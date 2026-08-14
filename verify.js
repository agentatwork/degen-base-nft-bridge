#!/usr/bin/env node
'use strict';
/**
 * verify.js — check the bridge from outside it.
 *
 * The relayer's status page is written by the relayer, so it can only ever be an assertion.
 * This reads both chains directly and checks the things that actually matter for each
 * receipt in the source vault:
 *
 *   - a token was minted on the destination for it
 *   - it belongs to the same address that held the original
 *   - its tokenURI is byte-identical to the one captured at burn time
 *   - its recorded origin points back at the right chain, collection and token
 *
 * Nothing here talks to the relayer. Point it at any node you trust.
 *
 *   node verify.js
 *   DEST_RPC=https://base-rpc.publicnode.com node verify.js   # override a rate-limited RPC
 */
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const abiOf = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, 'build', n + '.json'), 'utf8')).abi;
const nap = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const src = new ethers.JsonRpcProvider(process.env.SOURCE_RPC || cfg.sourceRpc, undefined, { cacheTimeout: -1 });
  const dst = new ethers.JsonRpcProvider(process.env.DEST_RPC || cfg.destRpc, undefined, { cacheTimeout: -1 });
  const vault = new ethers.Contract(cfg.vaultAddress, abiOf('BurnVault'), src);
  const nft = new ethers.Contract(cfg.nftAddress, abiOf('BridgedNFT'), dst);

  const n = Number(await vault.receiptCount());
  console.log(`receipts on chain ${cfg.sourceChainId}: ${n}   minted on chain ${cfg.destChainId}: ${await nft.totalMinted()}`);

  let bad = 0;
  for (let i = 0; i < n; i++) {
    // Public RPCs rate-limit; this is a verification tool, not a race.
    await nap(1500);
    const r = await vault.receiptAt(i);
    const [bridged, id] = await nft.bridgedTokenOf(cfg.sourceChainId, r.collection, r.tokenId);
    if (!bridged) { console.log(`receipt ${i}: not bridged yet (${r.collection}#${r.tokenId})`); continue; }

    const [owner, uri, origin] = await Promise.all([nft.ownerOf(id), nft.tokenURI(id), nft.originOf(id)]);
    const holderOk = owner.toLowerCase() === r.holder.toLowerCase();
    const uriOk = uri === r.tokenURI;
    const originOk = Number(origin[0]) === cfg.sourceChainId
      && origin[1].toLowerCase() === r.collection.toLowerCase()
      && origin[2] === r.tokenId;
    if (!holderOk || !uriOk || !originOk) bad++;

    console.log(`receipt ${i}: ${r.collection}#${r.tokenId} -> token ${id}`);
    console.log(`  holder   ${holderOk ? 'ok' : 'MISMATCH'}  ${owner}`);
    console.log(`  tokenURI ${uriOk ? 'ok' : 'MISMATCH'}  ${r.tokenURI || '(none)'}`);
    console.log(`  origin   ${originOk ? 'ok' : 'MISMATCH'}  chain ${origin[0]} ${origin[1]}#${origin[2]}`);
    // burnedAtBlock is this chain's own height; burnedAtRefBlock is whatever block.number
    // said. On an Orbit L3 they differ by millions — that gap is why chainBlock() exists.
    console.log(`  burned   block ${r.burnedAtBlock} (chain clock), ref ${r.burnedAtRefBlock} (block.number)`);
  }

  console.log(`\nsource head: chainBlock() ${await vault.chainBlock()}, eth_blockNumber ${await src.getBlockNumber()}`);
  console.log(bad === 0 ? 'all bridged tokens check out' : `${bad} mismatched`);
  process.exit(bad === 0 ? 0 : 1);
})().catch((e) => { console.error(e.shortMessage || e.message || e); process.exit(2); });
