#!/usr/bin/env node
'use strict';
/**
 * relayer.js — the centralized half of the bridge.
 *
 * Polls BurnVault on the source chain, and for every receipt that is old enough to be
 * safe, mints the matching token on the destination chain and hands it to the burner.
 *
 * The three things that make this different from a for-loop over receipts:
 *
 *  1. **Maturity, by depth or by age.** A receipt is acted on once it is `confirmations`
 *     blocks deep — minting on a block that later reorgs out would create a token whose
 *     origin burn no longer exists, and the mint cannot be undone — or once it is
 *     `minAgeSeconds` old, whichever comes first. The age rule is not a shortcut: Degen
 *     produces blocks only when someone transacts, so on a quiet day "twelve more blocks"
 *     is an unbounded wait, and depth alone would leave burns stranded indefinitely.
 *
 *  2. **The destination contract is the source of truth for what has been minted**, not
 *     the cursor file. The cursor is an optimization that saves re-reading old receipts;
 *     if it is lost, deleted, or stale, the relayer re-scans and `bridgedTokenOf` tells it
 *     what to skip. There is no state here that can be corrupted into a double mint.
 *
 *  3. **One receipt failing does not stall the queue behind it.** A token whose mint
 *     reverts (bad recipient contract, gas spike) is recorded and retried on later passes
 *     while the rest proceed; the cursor only advances past a contiguous run of finished
 *     work.
 *
 * Also serves a small JSON/HTML status endpoint, so the operator of a trusted relayer can
 * be checked from outside rather than taken at their word.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { ethers } = require('ethers');

const BUILD = path.join(__dirname, 'build');
const abiOf = (n) => JSON.parse(fs.readFileSync(path.join(BUILD, n + '.json'), 'utf8')).abi;

const DEFAULTS = {
  pollMs: 15000,
  confirmations: 12,
  // A receipt also matures on age alone. Degen only produces a block when somebody sends
  // a transaction — measured: zero blocks in twenty seconds on an idle chain — so "wait
  // twelve more blocks" can mean "wait until eleven other people happen to transact",
  // which on a quiet L3 is not a bounded wait at all. Time is the fallback clock.
  minAgeSeconds: 600,
  batchSize: 50,
  maxAttempts: 5,
  statusPort: 0,        // 0 = no HTTP server
  statusHost: '127.0.0.1',
  cursorFile: path.join(__dirname, '.cursor.json'),
};

class Relayer {
  constructor(cfg, log = console.log) {
    this.cfg = { ...DEFAULTS, ...cfg };
    this.log = log;
    // cacheTimeout: -1 turns off ethers' short response cache. It exists to spare the RPC
    // repeated reads, but it also caches the account nonce, and a relayer sending several
    // mints in quick succession will read a stale one and have the second transaction
    // replace the first.
    const opts = { cacheTimeout: -1 };
    this.src = new ethers.JsonRpcProvider(this.cfg.sourceRpc, undefined, opts);
    this.dst = new ethers.JsonRpcProvider(this.cfg.destRpc, undefined, opts);
    this.signer = new ethers.Wallet(this.cfg.relayerKey, this.dst);
    this.vault = new ethers.Contract(this.cfg.vaultAddress, abiOf('BurnVault'), this.src);
    this.nft = new ethers.Contract(this.cfg.nftAddress, abiOf('BridgedNFT'), this.signer);
    this.cursor = 0;
    this.stats = {
      scanned: 0, minted: 0, skipped: 0, failed: 0, waiting: 0, lastPass: null, errors: [], recent: [],
      // Totals read off the two chains rather than counted in memory: these survive a
      // restart, and they are what a reader can check independently.
      onChain: { receipts: null, bridged: null },
    };
    this.attempts = new Map(); // receipt index -> failed attempts
    this.stopped = false;
  }

  loadCursor() {
    try {
      const v = JSON.parse(fs.readFileSync(this.cfg.cursorFile, 'utf8'));
      if (Number.isInteger(v.cursor) && v.chainId === this.cfg.sourceChainId) this.cursor = v.cursor;
    } catch { /* first run, or a cursor for a different chain: start from zero */ }
  }

  saveCursor() {
    try {
      fs.writeFileSync(this.cfg.cursorFile, JSON.stringify({ chainId: this.cfg.sourceChainId, cursor: this.cursor }));
    } catch (e) {
      // A cursor we cannot persist costs re-reads, not correctness. Say so and continue.
      this.log(`warn: cursor not saved (${e.message})`);
    }
  }

  /** One full pass. Returns the number of tokens minted. */
  async pass() {
    // head comes from the vault, not from eth_blockNumber. On Degen — an Arbitrum Orbit
    // L3 — `block.number` inside a contract is the parent chain's height, ~23 million
    // blocks ahead of Degen's own, so comparing a stored block.number against
    // eth_blockNumber yields a negative depth and nothing is ever relayed. chainBlock()
    // returns the same clock the receipts are stamped with, whatever chain this is.
    const [head, total] = await Promise.all([this.vault.chainBlock(), this.vault.receiptCount()]);
    const n = Number(total);
    let minted = 0;
    let contiguous = true;
    let nextCursor = this.cursor;
    this.stats.waiting = 0;

    for (let off = this.cursor; off < n; off += this.cfg.batchSize) {
      const page = await this.vault.receipts(off, this.cfg.batchSize);
      for (let i = 0; i < page.length; i++) {
        const idx = off + i;
        const r = page[i];
        const depth = Number(head) - Number(r.burnedAtBlock);
        const age = Math.floor(Date.now() / 1000) - Number(r.burnedAt);
        const mature = depth >= this.cfg.confirmations
          || (this.cfg.minAgeSeconds > 0 && age >= this.cfg.minAgeSeconds);

        if (!mature) {
          // Too new to be safe. Everything after it is newer still, so stop the pass.
          this.stats.waiting = n - idx;
          contiguous = false;
          break;
        }

        this.stats.scanned++;
        const done = await this.relay(idx, r);
        if (done === 'minted') minted++;
        if (done === 'failed') contiguous = false;
        if (contiguous) nextCursor = idx + 1;
      }
      if (!contiguous) break;
    }

    if (nextCursor !== this.cursor) { this.cursor = nextCursor; this.saveCursor(); }
    this.stats.lastPass = new Date().toISOString();
    // Totals from the chains themselves, not from this process's counters, which start at
    // zero every restart. Best-effort: a failed read must not fail the pass.
    try {
      this.stats.onChain = { receipts: n, bridged: Number(await this.nft.totalMinted()) };
    } catch { /* leave the last known values */ }
    return minted;
  }

  /** @returns 'minted' | 'skipped' | 'failed' */
  async relay(idx, r) {
    const already = await this.nft.bridgedTokenOf(this.cfg.sourceChainId, r.collection, r.tokenId);
    if (already[0]) {
      this.stats.skipped++;
      return 'skipped';
    }

    const tries = this.attempts.get(idx) || 0;
    if (tries >= this.cfg.maxAttempts) return 'failed'; // parked; still visible in /status

    try {
      const tx = await this.nft.bridgeMint(
        r.holder, this.cfg.sourceChainId, r.collection, r.tokenId, r.tokenURI
      );
      const rec = await tx.wait();
      this.stats.minted++;
      this.stats.recent = [...(this.stats.recent || []).slice(-19), {
        receipt: idx, collection: r.collection, tokenId: r.tokenId.toString(),
        holder: r.holder, tx: rec.hash, block: rec.blockNumber,
      }];
      this.attempts.delete(idx);
      this.log(
        `bridged receipt ${idx}: ${r.collection}#${r.tokenId} -> ${r.holder} ` +
        `(tx ${rec.hash}, block ${rec.blockNumber})`
      );
      return 'minted';
    } catch (e) {
      // AlreadyBridged means another relayer instance (or an earlier run whose receipt we
      // never saw confirm) got there first. That is success, not failure.
      if (String(e.message || e).includes('AlreadyBridged')) {
        this.stats.skipped++;
        return 'skipped';
      }
      this.attempts.set(idx, tries + 1);
      this.stats.failed++;
      const msg = `receipt ${idx} failed (attempt ${tries + 1}/${this.cfg.maxAttempts}): ${e.shortMessage || e.message}`;
      this.stats.errors = [...this.stats.errors.slice(-19), { at: new Date().toISOString(), msg }];
      this.log('error: ' + msg);
      return 'failed';
    }
  }

  /**
   * Rebuild the recent-bridges table from the two chains, so a restarted relayer does not
   * report "nothing bridged yet" about tokens that plainly exist. Counters live in process
   * memory; the chain does not, and the chain is the one worth showing.
   *
   * Contract reads only — no eth_getLogs, whose block ranges are capped or billed by most
   * providers. The cost is that a backfilled row has no mint transaction hash: this process
   * did not send it and has no honest way to name it. It shows the destination token id
   * instead, which is what you would look up anyway.
   */
  async backfill(limit = 20) {
    try {
      const n = Number(await this.vault.receiptCount());
      const rows = [];
      for (let i = Math.max(0, n - limit); i < n; i++) {
        const r = await this.vault.receiptAt(i);
        const [bridged, id] = await this.nft.bridgedTokenOf(this.cfg.sourceChainId, r.collection, r.tokenId);
        if (!bridged) continue;
        rows.push({
          receipt: i, collection: r.collection, tokenId: r.tokenId.toString(),
          holder: r.holder, token: id.toString(), tx: null,
        });
      }
      // Anything this process minted since starting wins over the reconstruction.
      const mine = new Set(this.stats.recent.map((x) => x.receipt));
      this.stats.recent = [...rows.filter((x) => !mine.has(x.receipt)), ...this.stats.recent];
      if (rows.length) this.log(`backfilled ${rows.length} earlier bridge${rows.length === 1 ? '' : 's'} from chain state`);
    } catch (e) {
      // A status page that cannot be built is not a reason to stop bridging.
      this.log(`warn: backfill failed (${e.shortMessage || e.message})`);
    }
  }

  status() {
    return {
      source: { chainId: this.cfg.sourceChainId, vault: this.cfg.vaultAddress },
      destination: { chainId: this.cfg.destChainId, collection: this.cfg.nftAddress, relayer: this.signer.address },
      onChain: this.stats.onChain,
      confirmations: this.cfg.confirmations,
      minAgeSeconds: this.cfg.minAgeSeconds,
      cursor: this.cursor,
      ...this.stats,
      parked: [...this.attempts.entries()].filter(([, v]) => v >= this.cfg.maxAttempts).map(([k]) => k),
    };
  }

  /// A trusted relayer that cannot be observed is just a promise. This page is the whole
  /// audit surface: what it is relaying, from where, how far behind it is, and every
  /// transaction it has sent — enough to check its work against both chains yourself.
  page() {
    const s = this.status();
    const esc = (v) => String(v).replace(/[<&>"]/g, (c) => ({ '<': '&lt;', '&': '&amp;', '>': '&gt;', '"': '&quot;' }[c]));
    const rows = (s.recent || []).slice().reverse().map((r) => `<tr>
      <td>${esc(r.receipt)}</td><td class=m>${esc(r.collection)}</td><td>${esc(r.tokenId)}</td>
      <td class=m>${esc(r.holder)}</td>
      <td class=m>${r.tx ? esc(r.tx) : `token ${esc(r.token)} <span style="color:#888">(minted before this process started)</span>`}</td></tr>`).join('');
    const errs = (s.errors || []).slice().reverse()
      .map((e) => `<li>${esc(e.at)} — ${esc(e.msg)}</li>`).join('');
    return `<!doctype html><meta charset=utf-8><title>NFT bridge relayer</title>
<meta name=viewport content="width=device-width,initial-scale=1">
<style>
body{font:15px/1.5 system-ui,sans-serif;margin:2rem auto;max-width:60rem;padding:0 1rem;color:#111}
h1{font-size:1.3rem} h2{font-size:1rem;margin-top:2rem}
table{border-collapse:collapse;width:100%;font-size:13px} td,th{text-align:left;padding:.35rem .5rem;border-bottom:1px solid #eee}
.m{font-family:ui-monospace,monospace} dl{display:grid;grid-template-columns:auto 1fr;gap:.2rem 1rem;font-size:14px}
dt{color:#666} dd{margin:0} .n{font-size:1.6rem;font-weight:600} .k{display:inline-block;margin-right:2rem}
</style>
<h1>NFT bridge relayer</h1>
<p><span class=k><span class=n>${s.onChain?.bridged ?? s.minted}</span> bridged</span>
<span class=k><span class=n>${s.onChain?.receipts ?? '—'}</span> burned</span>
<span class=k><span class=n>${s.waiting}</span> awaiting confirmations</span>
<span class=k><span class=n>${s.failed}</span> failed</span></p>
<p style="color:#666;font-size:13px">Burn and bridge counts are read from the two chains on
every pass, not counted in this process — restarting the relayer does not reset them.
${s.minted} of them were minted by this process since it started.</p>
<dl>
<dt>source</dt><dd class=m>chain ${s.source.chainId} · vault ${esc(s.source.vault)}</dd>
<dt>destination</dt><dd class=m>chain ${s.destination.chainId} · collection ${esc(s.destination.collection)}</dd>
<dt>relayer key</dt><dd class=m>${esc(s.destination.relayer)}</dd>
<dt>maturity</dt><dd>${s.confirmations} blocks, or ${s.minAgeSeconds}s of age — Degen only
mints blocks when someone transacts, so depth alone is not a bounded wait</dd>
<dt>cursor</dt><dd>receipt ${s.cursor} · last pass ${esc(s.lastPass || 'never')}</dd>
</dl>
<h2>Recent bridges</h2>
${rows ? `<table><tr><th>receipt<th>origin collection<th>token<th>holder<th>mint tx</tr>${rows}</table>`
       : '<p>Nothing bridged yet.</p>'}
${errs ? `<h2>Recent errors</h2><ul>${errs}</ul>` : ''}
<h2>Verify it yourself</h2>
<p>Every mint above is checkable without trusting this page: read
<code class=m>receiptAt(n)</code> on the source vault, then <code class=m>bridgedTokenOf(chainId,
collection, tokenId)</code> and <code class=m>originOf(id)</code> on the destination collection.
Machine-readable copy of this page: <a href="status.json">status.json</a>.</p>`;
  }

  serve() {
    if (!this.cfg.statusPort) return null;
    const srv = http.createServer((req, res) => {
      // endsWith, not startsWith: behind a reverse proxy this may be mounted under a path
      // prefix, and the HTML links to status.json relatively so both mountings work.
      const json = (req.url || '').split('?')[0].endsWith('status.json');
      const body = json ? JSON.stringify(this.status(), null, 2) : this.page();
      res.writeHead(200, {
        'content-type': json ? 'application/json' : 'text/html; charset=utf-8',
        'access-control-allow-origin': '*',
      });
      res.end(body);
    });
    // Loopback by default. This is an operator's window into a process that holds a hot
    // key, and the machine running it is usually not the machine you want it reachable
    // from; put a reverse proxy in front if you want it public. statusHost overrides.
    const host = this.cfg.statusHost || '127.0.0.1';
    srv.listen(this.cfg.statusPort, host, () => this.log(`status on http://${host}:${srv.address().port}/`));
    return srv;
  }

  async run() {
    this.loadCursor();
    const srv = this.serve();
    this.log(
      `relaying ${this.cfg.vaultAddress} (chain ${this.cfg.sourceChainId}) -> ` +
      `${this.cfg.nftAddress} (chain ${this.cfg.destChainId}) as ${this.signer.address}, ` +
      `${this.cfg.confirmations} confirmations, from receipt ${this.cursor}`
    );
    await this.backfill();
    while (!this.stopped) {
      try {
        await this.pass();
      } catch (e) {
        // An RPC outage must not kill the process; the next pass re-reads from the cursor.
        this.log('error: pass failed: ' + (e.shortMessage || e.message));
      }
      await new Promise((r) => setTimeout(r, this.cfg.pollMs));
    }
    if (srv) srv.close();
  }
}

module.exports = { Relayer };

if (require.main === module) {
  const cfgPath = process.argv[2] || path.join(__dirname, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  if (process.env.RELAYER_KEY) cfg.relayerKey = process.env.RELAYER_KEY;
  const r = new Relayer(cfg);
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { r.stopped = true; r.log('\nstopping after this pass'); });
  }
  r.run().catch((e) => { console.error(e); process.exit(1); });
}
