#!/usr/bin/env node
// Compile every contract in contracts/ with solc-js and write build/<Name>.json.
// No hardhat, no foundry: `npm i` and `node build.js` is the whole toolchain, which
// matters when the thing being judged has to be reproducible by whoever reads it.
const fs = require('fs');
const path = require('path');
const solc = require('solc');

const ROOT = __dirname;
const SRC = path.join(ROOT, 'contracts');
const OUT = path.join(ROOT, 'build');

function findSources(dir, acc = {}) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) findSources(p, acc);
    else if (e.name.endsWith('.sol')) acc[path.relative(ROOT, p)] = { content: fs.readFileSync(p, 'utf8') };
  }
  return acc;
}

// Import resolution: bare specifiers come from node_modules, relative ones from disk.
function resolve(importPath) {
  const candidates = [path.join(ROOT, 'node_modules', importPath), path.join(ROOT, importPath)];
  for (const c of candidates) {
    try { return { contents: fs.readFileSync(c, 'utf8') }; } catch { /* try next */ }
  }
  return { error: 'not found: ' + importPath };
}

const input = {
  language: 'Solidity',
  sources: findSources(SRC),
  settings: {
    // Paris, not the compiler default of Cancun. Degen Chain is an Arbitrum Orbit chain
    // and Base is OP-stack; targeting the older instruction set means one artifact that
    // deploys on both, and on whatever local node is used to test it. Nothing here needs
    // MCOPY, TSTORE or even PUSH0 to be cheap.
    evmVersion: 'paris',
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } },
  },
};

const out = JSON.parse(solc.compile(JSON.stringify(input), { import: resolve }));

let fatal = false;
for (const e of out.errors || []) {
  if (e.severity === 'error') fatal = true;
  process.stderr.write(e.formattedMessage);
}
if (fatal) process.exit(1);

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const written = [];
for (const [file, contracts] of Object.entries(out.contracts || {})) {
  for (const [name, c] of Object.entries(contracts)) {
    if (!c.evm.bytecode.object) continue; // interfaces and libraries with no code
    fs.writeFileSync(
      path.join(OUT, name + '.json'),
      JSON.stringify({
        name, file, abi: c.abi,
        bytecode: '0x' + c.evm.bytecode.object,
        deployedBytecode: '0x' + c.evm.deployedBytecode.object, // for installing code at a fixed address
      }, null, 2)
    );
    written.push(`${name} (${(c.evm.deployedBytecode.object.length / 2).toLocaleString()} bytes deployed)`);
  }
}
console.log('compiled with solc ' + solc.version());
for (const w of written.sort()) console.log('  ' + w);
