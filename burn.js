#!/usr/bin/env node
'use strict';
/**
 * burn.js — send an NFT into the vault on the source chain, the user-facing half of the
 * bridge. Two paths, both supported by the vault:
 *
 *   node burn.js --collection 0xNFT --token 3            # safeTransferFrom, one tx
 *   node burn.js --collection 0xNFT --token 3 --approve  # approve then burn(), two txs
 *
 * Reads sourceRpc and vaultAddress from config.json. Key from HOLDER_KEY.
 */
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const abiOf = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, 'build', n + '.json'), 'utf8')).abi;
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };

(async () => {
  const key = process.env.HOLDER_KEY;
  if (!key) { console.error('set HOLDER_KEY'); process.exit(2); }
  const collection = arg('collection');
  const token = arg('token');
  if (!collection || token === undefined) { console.error('--collection and --token are required'); process.exit(2); }

  const provider = new ethers.JsonRpcProvider(cfg.sourceRpc, undefined, { cacheTimeout: -1 });
  const w = new ethers.Wallet(key, provider);
  const nft = new ethers.Contract(collection, abiOf('DemoNFT'), w);
  const vault = new ethers.Contract(cfg.vaultAddress, abiOf('BurnVault'), w);

  const owner = await nft.ownerOf(token);
  if (owner.toLowerCase() !== w.address.toLowerCase()) {
    console.error(`token ${token} is held by ${owner}, not ${w.address}`);
    process.exit(1);
  }

  let rc;
  if (process.argv.includes('--approve')) {
    console.log('approve:', (await (await nft.approve(cfg.vaultAddress, token)).wait()).hash);
    rc = await (await vault.burn(collection, token)).wait();
    console.log('burn:   ', rc.hash);
  } else {
    const tx = await nft['safeTransferFrom(address,address,uint256)'](w.address, cfg.vaultAddress, token);
    rc = await tx.wait();
    console.log('safeTransferFrom:', rc.hash);
  }

  // Read the receipt out of this transaction's own logs rather than re-reading
  // receiptCount(): a public RPC is several nodes behind a load balancer, and the one that
  // answers the next call may not have the block that just landed. The log is in hand.
  const ev = rc.logs
    .filter((l) => l.address.toLowerCase() === cfg.vaultAddress.toLowerCase())
    .map((l) => { try { return vault.interface.parseLog(l); } catch { return null; } })
    .find((l) => l && l.name === 'Burned');
  if (!ev) { console.error('no Burned event in the transaction — check the vault address'); process.exit(1); }
  const [index, coll, tokenId, holder, uri] = ev.args;
  console.log(`receipt ${index}: ${coll}#${tokenId} held by ${holder}`);
  console.log(`  tokenURI captured: ${uri || '(none)'}`);
  console.log(`  burned in block ${rc.blockNumber}; the relayer waits ${cfg.confirmations ?? 12} blocks`);
})().catch((e) => { console.error(e.shortMessage || e.message || e); process.exit(1); });
