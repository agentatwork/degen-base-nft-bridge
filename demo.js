#!/usr/bin/env node
'use strict';
/**
 * demo.js — the whole bridge running on your machine in one command.
 *
 *   npm install && node build.js && node demo.js
 *
 * Starts two throwaway chains (Degen's and Base's real chain ids), deploys the vault, the
 * bridged collection and a demo NFT contract, then runs the relayer against them and burns
 * a fresh token every few seconds so there is something to watch. Status page on :8787.
 *
 * Nothing here touches a real network and no key in this file is worth anything.
 */
const fs = require('fs');
const path = require('path');
const ganache = require('ganache');
const { ethers } = require('ethers');
const { Relayer } = require('./relayer');

const artifact = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, 'build', n + '.json'), 'utf8'));

const SOURCE_CHAIN_ID = 666666666;
const DEST_CHAIN_ID = 8453;
const CONFIRMATIONS = 3;
const PORT = Number(process.env.PORT || 8787);

const KEYS = [
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
];

async function chain(port, chainId) {
  const s = ganache.server({
    chain: { chainId, networkId: chainId },
    wallet: { accounts: KEYS.map((secretKey) => ({ secretKey, balance: '0x56BC75E2D63100000' })) },
    logging: { quiet: true },
  });
  await s.listen(port);
  return s;
}

async function deploy(name, signer, args = []) {
  const a = artifact(name);
  const c = await new ethers.ContractFactory(a.abi, a.bytecode, signer).deploy(...args);
  await c.waitForDeployment();
  return c;
}

(async () => {
  await chain(8555, SOURCE_CHAIN_ID);
  await chain(8556, DEST_CHAIN_ID);
  const opts = { staticNetwork: true, cacheTimeout: -1 };
  const src = new ethers.JsonRpcProvider('http://127.0.0.1:8555', undefined, opts);
  const dst = new ethers.JsonRpcProvider('http://127.0.0.1:8556', undefined, opts);
  const [a, b, rel] = KEYS.map((k) => new ethers.Wallet(k, src));
  const aDst = new ethers.Wallet(KEYS[0], dst);

  const nft = await deploy('DemoNFT', a);
  const vault = await deploy('BurnVault', a);
  const bridged = await deploy('BridgedNFT', aDst, ['Bridged Degen NFTs', 'bDEGEN', rel.address]);
  const [nftAddr, vaultAddr, bridgedAddr] =
    await Promise.all([nft.getAddress(), vault.getAddress(), bridged.getAddress()]);

  console.log(`source chain ${SOURCE_CHAIN_ID} (Degen id)  http://127.0.0.1:8555`);
  console.log(`  DemoNFT    ${nftAddr}`);
  console.log(`  BurnVault  ${vaultAddr}`);
  console.log(`dest   chain ${DEST_CHAIN_ID} (Base id)   http://127.0.0.1:8556`);
  console.log(`  BridgedNFT ${bridgedAddr}\n`);

  const relayer = new Relayer({
    sourceRpc: 'http://127.0.0.1:8555', destRpc: 'http://127.0.0.1:8556',
    sourceChainId: SOURCE_CHAIN_ID, destChainId: DEST_CHAIN_ID,
    vaultAddress: vaultAddr, nftAddress: bridgedAddr, relayerKey: KEYS[2],
    confirmations: CONFIRMATIONS, pollMs: 3000, statusPort: PORT,
    cursorFile: path.join(__dirname, '.demo-cursor.json'),
  });
  fs.rmSync(relayer.cfg.cursorFile, { force: true });

  // Burn one token every few seconds, alternating between the two holders and the two
  // ways in, so the page shows both entry paths working.
  let n = 0;
  const burn = async () => {
    const to = n % 2 ? b.address : a.address;
    const uri = `ipfs://bafkreidemo/${n}.json`;
    const id = Number(await nft.next.staticCall());
    await (await nft.mint(to, uri)).wait();
    const holder = n % 2 ? b : a;
    if (n % 2) {
      await (await nft.connect(holder).approve(vaultAddr, id)).wait();
      await (await vault.connect(holder).burn(nftAddr, id)).wait();
    } else {
      await (await nft.connect(holder)['safeTransferFrom(address,address,uint256)'](holder.address, vaultAddr, id)).wait();
    }
    console.log(`burned ${nftAddr}#${id} held by ${holder.address}`);
    n++;
    for (let i = 0; i < CONFIRMATIONS; i++) await src.send('evm_mine', []);
  };
  await burn();
  setInterval(() => burn().catch((e) => console.error(e.shortMessage || e.message)), 9000);

  console.log(`\nwatch it at http://127.0.0.1:${PORT}/  (ctrl-c to stop)\n`);
  await relayer.run();
})().catch((e) => { console.error(e); process.exit(1); });
