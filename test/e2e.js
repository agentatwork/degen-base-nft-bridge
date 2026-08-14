#!/usr/bin/env node
'use strict';
/**
 * End-to-end test of the whole bridge across two independent EVM chains.
 *
 * Degen Chain has no public testnet (testnet.rpc.degen.tips and rpc-testnet.degen.tips
 * are both NXDOMAIN as of August 2026), so "launch on testnet" cannot mean Degen. Two
 * local ganache instances with the real Degen and Base chain ids stand in for the pair
 * here, which is strictly more than a testnet gives you: the test can mine blocks on
 * demand and so can actually exercise the confirmation-depth and reorg-safety paths that
 * a live testnet only lets you wait for.
 *
 * Run: node test/e2e.js
 */
const fs = require('fs');
const path = require('path');
const ganache = require('ganache');
const { ethers } = require('ethers');
const { Relayer } = require('../relayer');

const BUILD = path.join(__dirname, '..', 'build');
const artifact = (n) => JSON.parse(fs.readFileSync(path.join(BUILD, n + '.json'), 'utf8'));

const SOURCE_CHAIN_ID = 666666666; // Degen
const DEST_CHAIN_ID = 8453;        // Base
const CONFIRMATIONS = 40; // higher than the number of blocks the setup itself mines

// Deterministic keys so the test reads the same on every run.
const KEYS = [
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d', // deployer / holder A
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a', // holder B
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6', // relayer
];

let passed = 0, failed = 0;
function ok(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}
function eq(name, actual, expected) {
  const a = typeof actual === 'bigint' ? actual.toString() : actual;
  const b = typeof expected === 'bigint' ? expected.toString() : expected;
  ok(name, String(a).toLowerCase() === String(b).toLowerCase(), `got ${a}, want ${b}`);
}
// Assert a revert by name. The call must be a staticCall: ganache returns no revert data
// from eth_estimateGas, so a normal send surfaces "missing revert data" and the custom
// error name is lost. eth_call returns the data and ethers decodes it against the ABI.
// `iface` is needed when the revert bubbles up through another contract: ethers decodes
// against the ABI of the contract it called, so an error defined in the vault comes back
// as "unknown custom error" when the call went through the rogue collection.
async function throws(name, p, needle, iface = null) {
  try { await p; ok(name, false, 'no revert'); }
  catch (e) {
    const msg = String(e.shortMessage || e.message || '');
    let named = e.revert?.name || '';
    if (!named && iface && e.data) { try { named = iface.parseError(e.data)?.name || ''; } catch { /* not ours */ } }
    ok(name, needle === '*' || named === needle || msg.includes(needle), `revert was: ${named || msg.slice(0, 100)}`);
  }
}

async function startChain(port, chainId) {
  const server = ganache.server({
    chain: { chainId, networkId: chainId },
    wallet: { accounts: KEYS.map((secretKey) => ({ secretKey, balance: '0x56BC75E2D63100000' })) },
    logging: { quiet: true },
    miner: { blockGasLimit: '0x1c9c380' },
  });
  await server.listen(port);
  return server;
}

async function deploy(name, signer, args = []) {
  const a = artifact(name);
  const f = new ethers.ContractFactory(a.abi, a.bytecode, signer);
  const c = await f.deploy(...args);
  await c.waitForDeployment();
  return c;
}

async function mine(provider, n) {
  for (let i = 0; i < n; i++) await provider.send('evm_mine', []);
}

(async () => {
  console.log('starting two chains: source =', SOURCE_CHAIN_ID, '(Degen), dest =', DEST_CHAIN_ID, '(Base)');
  const srcServer = await startChain(8555, SOURCE_CHAIN_ID);
  const dstServer = await startChain(8556, DEST_CHAIN_ID);

  const srcRpc = 'http://127.0.0.1:8555';
  const dstRpc = 'http://127.0.0.1:8556';
  // cacheTimeout: -1 disables ethers' 250 ms response cache. On a real network that cache
  // is harmless; against an instamining local node, two transactions sent inside the same
  // 250 ms window both read the same stale nonce and the second silently replaces the
  // first — which looks like two deployments landing on one address.
  const opts = { staticNetwork: true, cacheTimeout: -1 };
  const src = new ethers.JsonRpcProvider(srcRpc, undefined, opts);
  const dst = new ethers.JsonRpcProvider(dstRpc, undefined, opts);

  const [a, b, rel] = KEYS.map((k) => new ethers.Wallet(k, src));
  const relDst = new ethers.Wallet(KEYS[2], dst);
  const aDst = new ethers.Wallet(KEYS[0], dst);

  console.log('\ndeploying');
  const nft = await deploy('DemoNFT', a);
  const vault = await deploy('BurnVault', a);
  const bridged = await deploy('BridgedNFT', aDst, ['Bridged Degen NFTs', 'bDEGEN', rel.address]);
  console.log('  DemoNFT   ', await nft.getAddress());
  console.log('  BurnVault ', await vault.getAddress());
  console.log('  BridgedNFT', await bridged.getAddress());

  const vaultAddr = await vault.getAddress();
  const nftAddr = await nft.getAddress();
  const bridgedAddr = await bridged.getAddress();

  // ---- source side -------------------------------------------------------
  console.log('\nsource chain: burning');
  const URI_A = 'ipfs://bafkreiuriaaa/1.json';
  const URI_B = 'https://example.invalid/meta/2.json';
  await (await nft.mint(a.address, URI_A)).wait();                       // token 0 -> A
  await (await nft.mint(b.address, URI_B)).wait();                       // token 1 -> B
  await (await nft.mint(a.address, 'ipfs://unrevealed/3.json')).wait();  // token 2 -> A

  // path 1: safeTransferFrom straight into the vault
  await (await nft.connect(a)['safeTransferFrom(address,address,uint256)'](a.address, vaultAddr, 0)).wait();
  // path 2: approve then burn()
  await (await nft.connect(b).approve(vaultAddr, 1)).wait();
  await (await vault.connect(b).burn(nftAddr, 1)).wait();
  // path 3: a token whose tokenURI reverts must still be bridgeable
  await (await nft.setBreakURI(true)).wait();
  await (await nft.connect(a)['safeTransferFrom(address,address,uint256)'](a.address, vaultAddr, 2)).wait();
  await (await nft.setBreakURI(false)).wait();

  eq('vault recorded three receipts', await vault.receiptCount(), 3n);
  const r0 = await vault.receiptAt(0);
  eq('receipt 0 collection', r0.collection, nftAddr);
  eq('receipt 0 holder is the sender, not the vault', r0.holder, a.address);
  eq('receipt 0 tokenURI captured at burn time', r0.tokenURI, URI_A);
  const r1 = await vault.receiptAt(1);
  eq('receipt 1 holder (approve+burn path)', r1.holder, b.address);
  eq('receipt 1 tokenURI', r1.tokenURI, URI_B);
  const r2 = await vault.receiptAt(2);
  eq('receipt 2 survives a reverting tokenURI', r2.tokenURI, '');
  ok('receipts carry a block number for confirmation depth', Number(r2.burnedAtBlock) > 0);

  eq('vault owns the burned token', await nft.ownerOf(0), vaultAddr);
  // The one-way property is structural: there is no code path out of the vault at all.
  // Check the ABI rather than the source, since that is what a reviewer can check against
  // a deployed address. (Match on functions only — the error named NotOwner is not a way out.)
  const vaultFns = artifact('BurnVault').abi.filter((f) => f.type === 'function');
  ok('vault has no withdrawal function',
    !vaultFns.some((f) => /withdraw|rescue|transferOut|sweep|escape|^owner$/i.test(f.name || '')));
  ok('vault has no owner or admin at all',
    !vaultFns.some((f) => /owner|admin|governor|pause/i.test(f.name || '')));
  ok('vault mutates state only through burn and the receive hook',
    vaultFns.filter((f) => !['view', 'pure'].includes(f.stateMutability))
      .every((f) => ['burn', 'onERC721Received'].includes(f.name)));

  const page = await vault.receipts(1, 10);
  eq('receipts(offset,limit) bounds instead of reverting', page.length, 2);
  eq('receipts() page starts at the offset', page[0].tokenId, 1n);
  eq('receipts() past the end returns empty', (await vault.receipts(99, 10)).length, 0);

  ok('the burn is recorded against (collection, tokenId)', await vault.burned(await vault.key(nftAddr, 0)));
  await throws('burn() rejects a token you do not own',
    vault.connect(b).burn.staticCall(nftAddr, 0), 'NotOwner');
  // Re-burning through burn() can only ever hit NotOwner, because the vault now holds the
  // token and never gives it back. The duplicate guard is for the other entry point —
  // exercised at the end of this file, once the receipt counts no longer matter.
  await throws('a token already in the vault cannot be re-burned',
    vault.connect(a).burn.staticCall(nftAddr, 0), 'NotOwner');

  // ---- destination side --------------------------------------------------
  console.log('\ndestination chain: access control');
  await throws('bridgeMint is relayer-only',
    bridged.connect(aDst).bridgeMint.staticCall(a.address, SOURCE_CHAIN_ID, nftAddr, 0, 'x'), 'NotRelayer');

  // ---- relayer -----------------------------------------------------------
  console.log('\nrelayer');
  const cursorFile = path.join(__dirname, '.test-cursor.json');
  fs.rmSync(cursorFile, { force: true });
  const logs = [];
  const cfg = {
    sourceRpc: srcRpc, destRpc: dstRpc,
    sourceChainId: SOURCE_CHAIN_ID, destChainId: DEST_CHAIN_ID,
    vaultAddress: vaultAddr, nftAddress: bridgedAddr,
    relayerKey: KEYS[2], confirmations: CONFIRMATIONS, batchSize: 2, cursorFile,
  };
  const relayer = new Relayer(cfg, (m) => logs.push(m));

  const beforeDepth = await relayer.pass();
  eq('nothing is minted before the confirmation depth', beforeDepth, 0);
  eq('  and the pass reports what it is waiting on', relayer.stats.waiting, 3);

  await mine(src, CONFIRMATIONS);
  relayer.loadCursor();
  const n1 = await relayer.pass();
  eq('all three bridge once confirmed', n1, 3);
  eq('destination minted three', await bridged.totalMinted(), 3n);
  eq('token 0 went to the original holder', await bridged.ownerOf(0), a.address);
  eq('token 1 went to holder B', await bridged.ownerOf(1), b.address);
  eq('metadata is copied verbatim', await bridged.tokenURI(0), URI_A);
  eq('empty metadata bridges as empty', await bridged.tokenURI(2), '');

  const o = await bridged.originOf(1);
  eq('provenance: origin chain', o.chainId, BigInt(SOURCE_CHAIN_ID));
  eq('provenance: origin collection', o.collection, nftAddr);
  eq('provenance: origin token id', o.tokenId, 1n);

  // idempotency, the whole point of the design
  console.log('\nidempotency');
  const n2 = await relayer.pass();
  eq('a second pass mints nothing', n2, 0);
  eq('  and the supply is unchanged', await bridged.totalMinted(), 3n);

  fs.rmSync(cursorFile, { force: true });
  const fresh = new Relayer(cfg, (m) => logs.push(m));
  fresh.loadCursor();
  eq('a lost cursor restarts from zero', fresh.cursor, 0);
  const n3 = await fresh.pass();
  eq('a relayer with no memory still mints nothing', n3, 0);
  eq('  supply still unchanged', await bridged.totalMinted(), 3n);
  ok('  it re-scanned rather than trusting the cursor', fresh.stats.skipped === 3);

  const second = new Relayer(cfg, (m) => logs.push(m));
  second.loadCursor();
  eq('two relayers running at once mint nothing extra', await second.pass(), 0);

  await throws('the contract rejects a replayed mint even if a relayer tries',
    bridged.connect(relDst).bridgeMint.staticCall(a.address, SOURCE_CHAIN_ID, nftAddr, 0, URI_A), 'AlreadyBridged');

  const [ex, id] = await bridged.bridgedTokenOf(SOURCE_CHAIN_ID, nftAddr, 1);
  ok('bridgedTokenOf reports the mapping', ex === true && id === 1n, `got ${ex}, ${id}`);
  const [ex2] = await bridged.bridgedTokenOf(SOURCE_CHAIN_ID, nftAddr, 999);
  ok('bridgedTokenOf is false for an unbridged token', ex2 === false);

  // a same-id token on a *different* origin collection must not collide
  const other = await deploy('DemoNFT', a);
  const otherAddr = await other.getAddress();
  await (await other.mint(a.address, 'ipfs://other/0.json')).wait();
  await (await other.connect(a)['safeTransferFrom(address,address,uint256)'](a.address, vaultAddr, 0)).wait();
  await mine(src, CONFIRMATIONS);
  eq('a same-id token from another collection is not a duplicate', await relayer.pass(), 1);
  eq('  it minted a fourth token', await bridged.totalMinted(), 4n);
  eq('  with its own provenance', (await bridged.originOf(3)).collection, otherAddr);

  // relayer rotation
  console.log('\noperations');
  await (await bridged.connect(aDst).setRelayer(aDst.address)).wait();
  await throws('the old relayer key stops working after rotation',
    bridged.connect(relDst).bridgeMint.staticCall(a.address, SOURCE_CHAIN_ID, otherAddr, 5, 'x'), 'NotRelayer');
  await (await bridged.connect(aDst).setRelayer(rel.address)).wait();
  await throws('only the admin can rotate the relayer',
    bridged.connect(relDst).setRelayer.staticCall(relDst.address), 'NotAdmin');

  const st = relayer.status();
  ok('status reports what this relayer minted', st.minted === 4, JSON.stringify(st));
  ok('status reports what a re-scan skipped', fresh.status().skipped === 3, JSON.stringify(fresh.status()));
  ok('status names both chains', st.source.chainId === SOURCE_CHAIN_ID && st.destination.chainId === DEST_CHAIN_ID);
  ok('status lists the transactions it sent', st.recent.length === 4 && /^0x[0-9a-f]{64}$/.test(st.recent[0].tx));
  const html = relayer.page();
  ok('the status page renders every bridge', html.includes(vaultAddr) && html.includes(st.recent[3].tx));

  // A status page whose numbers live in process memory reports "nothing bridged yet" after
  // any restart, about tokens that plainly exist. The headline counts come off the chains.
  ok('the headline counts come from the chains, not from memory',
    st.onChain.receipts === Number(await vault.receiptCount())
    && st.onChain.bridged === Number(await bridged.totalMinted()), JSON.stringify(st.onChain));
  const restarted = new Relayer(cfg, (m) => logs.push(m));  // same config, empty memory
  ok('  a restarted relayer starts with no history of its own', restarted.status().recent.length === 0);
  await restarted.backfill();
  ok('  and reconstructs earlier bridges from chain state alone', restarted.status().recent.length > 0,
    JSON.stringify(restarted.status().recent));
  ok('  naming the destination token rather than inventing a transaction it never sent',
    restarted.status().recent.every((r) => r.tx === null && /^\d+$/.test(r.token)));
  // Error text comes from an RPC the operator does not control, and lands in an HTML page.
  relayer.stats.errors.push({ at: 'now', msg: '<script>alert(1)</script>' });
  const dirty = relayer.page();
  ok('the status page escapes text that came from an RPC',
    !dirty.includes('<script>alert') && dirty.includes('&lt;script&gt;'));
  relayer.stats.errors.pop();

  // The receive hook trusts msg.sender as the collection, which is the whole spoof surface:
  // a contract can register receipts for tokens of its own collection without holding any.
  // That is harmless — it can only ever mint copies of its own worthless tokens — and it
  // still cannot register the same one twice.
  console.log('\nspoof surface');
  const before = await vault.receiptCount();
  const rogue = await deploy('Rogue', a);
  await (await rogue.poke(vaultAddr, b.address, 7)).wait();
  eq('a collection may register its own token via the hook', await vault.receiptCount(), before + 1n);
  eq('  recorded against the caller, not an address it claims',
    (await vault.receiptAt(before)).collection, await rogue.getAddress());
  await throws('  but it cannot register the same token twice',
    rogue.poke.staticCall(vaultAddr, b.address, 7), 'AlreadyBurned', vault.interface);
  // burn() takes the collection as an argument, so it is the caller's claim rather than
  // the hook's proof — and it is checked: ownerOf must return the caller. Rogue has no
  // ownerOf at all, so the call cannot succeed.
  await throws('  and burn() cannot be pointed at a collection that will not vouch for you',
    vault.connect(a).burn.staticCall(await rogue.getAddress(), 7), '*');

  // The bug that only a live deployment found. On Degen, `block.number` inside a contract
  // is the parent chain's height — 49,964,015 while Degen's own head was 26,961,399. A
  // relayer that stores block.number and compares it to eth_blockNumber computes a depth
  // of minus 23 million, waits for it to reach 12, and relays nothing, ever. Here ArbSys
  // is installed at 0x64 so the two clocks disagree the same way.
  console.log('\narbitrum orbit clock');
  eq('without ArbSys, chainBlock() is just block.number',
    await vault.chainBlock(), BigInt(await src.getBlockNumber()));
  await src.send('evm_setAccountCode', ['0x0000000000000000000000000000000000000064', artifact('ArbSysStub').deployedBytecode]);
  const raw = BigInt(await src.getBlockNumber());
  const clock = await vault.chainBlock();
  ok('with ArbSys present, chainBlock() follows it instead', clock === raw + 1000000n, `${clock} vs ${raw}`);

  const orbitRelayer = new Relayer({ ...cfg, cursorFile: cursorFile + '.orbit' }, (m) => logs.push(m));
  await orbitRelayer.pass(); // drain anything already mature, so the next pass is only about the new burn

  const orbitId = Number(await nft.next.staticCall());
  await (await nft.mint(a.address, 'ipfs://orbit/1.json')).wait();
  await (await nft.connect(a)['safeTransferFrom(address,address,uint256)'](a.address, vaultAddr, orbitId)).wait();
  const orbitIdx = Number(await vault.receiptCount()) - 1;
  const orbitReceipt = await vault.receiptAt(orbitIdx);
  ok('receipts are stamped with the chain\'s own clock',
    orbitReceipt.burnedAtBlock > orbitReceipt.burnedAtRefBlock + 999000n,
    `${orbitReceipt.burnedAtBlock} vs ${orbitReceipt.burnedAtRefBlock}`);

  eq('a fresh burn on an Orbit-style chain is not relayed yet', await orbitRelayer.pass(), 0);
  await mine(src, CONFIRMATIONS);
  eq('and it does relay once the depth is reached — the clocks are compared like for like',
    await orbitRelayer.pass(), 1);
  eq('  the copy reached the holder', await bridged.ownerOf(await bridged.totalMinted() - 1n), a.address);
  fs.rmSync(cursorFile + '.orbit', { force: true });

  // Degen makes a block only when somebody transacts: measured zero blocks in twenty
  // seconds on the live chain. Waiting for depth alone would strand a burn until eleven
  // strangers happened to send transactions, so a receipt also matures on age.
  console.log('\nblock-on-demand chain');
  const ageId = Number(await nft.next.staticCall());
  await (await nft.mint(a.address, 'ipfs://aged/1.json')).wait();
  await (await nft.connect(a)['safeTransferFrom(address,address,uint256)'](a.address, vaultAddr, ageId)).wait();
  const depthOnly = new Relayer({ ...cfg, minAgeSeconds: 0, cursorFile: cursorFile + '.age' }, () => {});
  eq('with the age rule off, a fresh burn waits for depth that may never come',
    await depthOnly.pass(), 0);
  const byAge = new Relayer({ ...cfg, minAgeSeconds: 2, cursorFile: cursorFile + '.age' }, () => {});
  eq('  and with it on, it is still too new a moment later', await byAge.pass(), 0);
  await new Promise((r) => setTimeout(r, 2200));   // no blocks mined in between, only time
  eq('  but it matures on age with the chain standing still', await byAge.pass(), 1);
  fs.rmSync(cursorFile + '.age', { force: true });

  fs.rmSync(cursorFile, { force: true });
  await srcServer.close();
  await dstServer.close();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
