#!/usr/bin/env node
'use strict';
/**
 * deploy.js — put one side of the bridge on a chain and write the config the relayer reads.
 *
 *   node deploy.js source --rpc https://rpc.degen.tips
 *   node deploy.js dest   --rpc https://mainnet.base.org --relayer 0xRelayerAddress \
 *                         --name "Bridged Degen NFTs" --symbol bDEGEN
 *   node deploy.js demo   --rpc https://rpc.degen.tips        # a test collection to bridge
 *
 * The deploying key comes from DEPLOYER_KEY in the environment, never from a file or an
 * argument — argv is visible to every process on the box and shell history keeps it.
 *
 * Each run merges its addresses into config.json, so deploying the two sides from two
 * different machines still produces one config the relayer can use.
 */
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const CONFIG = path.join(__dirname, 'config.json');
const artifact = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, 'build', n + '.json'), 'utf8'));

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { return {}; }
}

function saveConfig(patch) {
  const cfg = { ...loadConfig(), ...patch };
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n');
  console.log('wrote ' + CONFIG);
  return cfg;
}

(async () => {
  const side = process.argv[2];
  if (!['source', 'dest', 'demo'].includes(side)) {
    console.error('usage: node deploy.js <source|dest|demo> --rpc <url> [--relayer 0x..] [--name N] [--symbol S]');
    process.exit(2);
  }
  const key = process.env.DEPLOYER_KEY;
  if (!key) { console.error('set DEPLOYER_KEY in the environment'); process.exit(2); }

  const rpc = arg('rpc');
  if (!rpc) { console.error('--rpc is required'); process.exit(2); }

  const provider = new ethers.JsonRpcProvider(rpc, undefined, { cacheTimeout: -1 });
  const wallet = new ethers.Wallet(key, provider);
  const net = await provider.getNetwork();
  const bal = await provider.getBalance(wallet.address);
  console.log(`chain ${net.chainId} as ${wallet.address} (${ethers.formatEther(bal)} native)`);
  if (bal === 0n) { console.error('the deployer has no gas on this chain'); process.exit(1); }

  const deploy = async (name, args = []) => {
    const a = artifact(name);
    const f = new ethers.ContractFactory(a.abi, a.bytecode, wallet);
    const c = await f.deploy(...args);
    console.log(`  ${name}: ${c.deploymentTransaction().hash}`);
    await c.waitForDeployment();
    const addr = await c.getAddress();
    console.log(`  ${name} deployed at ${addr}`);
    return addr;
  };

  if (side === 'source') {
    const vaultAddress = await deploy('BurnVault');
    saveConfig({ sourceRpc: rpc, sourceChainId: Number(net.chainId), vaultAddress });
  } else if (side === 'dest') {
    const relayer = arg('relayer', wallet.address);
    if (!ethers.isAddress(relayer)) { console.error('--relayer must be an address'); process.exit(2); }
    const nftAddress = await deploy('BridgedNFT', [
      arg('name', 'Bridged Degen NFTs'), arg('symbol', 'bDEGEN'), relayer,
    ]);
    saveConfig({ destRpc: rpc, destChainId: Number(net.chainId), nftAddress });
    console.log(`relayer is ${relayer}; admin (able to rotate it) is ${wallet.address}`);
  } else {
    const addr = await deploy('DemoNFT');
    console.log(`mint one with: cast send ${addr} "mint(address,string)" <to> <uri>`);
  }
})().catch((e) => { console.error(e.shortMessage || e.message || e); process.exit(1); });
