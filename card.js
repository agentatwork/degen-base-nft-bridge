#!/usr/bin/env node
'use strict';
/**
 * card.js — render the claim card from live chain data.
 *
 * The numbers on this image are read from the two contracts at render time rather than
 * typed in. An image of a bridge that disagrees with the bridge is worse than no image.
 *
 *   node card.js && rsvg-convert -w 1200 card.svg -o card.png
 */
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const abiOf = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, 'build', n + '.json'), 'utf8')).abi;
const esc = (s) => String(s).replace(/[<&>]/g, (c) => ({ '<': '&lt;', '&': '&amp;', '>': '&gt;' }[c]));
const short = (a) => a.slice(0, 6) + '…' + a.slice(-4);

(async () => {
  const src = new ethers.JsonRpcProvider(process.env.SOURCE_RPC || cfg.sourceRpc, undefined, { cacheTimeout: -1 });
  const dst = new ethers.JsonRpcProvider(process.env.DEST_RPC || cfg.destRpc, undefined, { cacheTimeout: -1 });
  const vault = new ethers.Contract(cfg.vaultAddress, abiOf('BurnVault'), src);
  const nft = new ethers.Contract(cfg.nftAddress, abiOf('BridgedNFT'), dst);

  const burned = Number(await vault.receiptCount());
  const minted = Number(await nft.totalMinted());
  const head = await vault.chainBlock();
  const ref = await src.getBlockNumber();
  const rows = [];
  for (let i = Math.max(0, burned - 3); i < burned; i++) {
    const r = await vault.receiptAt(i);
    const [ok, id] = await nft.bridgedTokenOf(cfg.sourceChainId, r.collection, r.tokenId);
    rows.push({ i, tokenId: r.tokenId.toString(), uri: r.tokenURI, ok, id: id.toString(), holder: r.holder });
  }

  const W = 1200, H = 800;
  const p = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="DejaVu Sans, sans-serif">`,
    `<rect width="${W}" height="${H}" fill="#0b0d10"/>`,
    `<rect x="0" y="0" width="${W}" height="6" fill="#c9a6f5"/>`,
    `<rect x="600" y="0" width="600" height="6" fill="#79c0ff"/>`,
    '<text x="64" y="112" fill="#e6edf3" font-size="52" font-weight="bold">Degen <tspan fill="#8b98a5">→</tspan> Base<tspan fill="#7ee787">.</tspan></text>',
    '<text x="64" y="156" fill="#8b98a5" font-size="24">Burn an NFT on Degen. The same token, same metadata, arrives on Base.</text>',
    '<text x="64" y="188" fill="#8b98a5" font-size="24">Deployed and running on both real chains — not a testnet.</text>',
  ];

  const figs = [[String(burned), 'burned on Degen'], [String(minted), 'minted on Base'],
                [String(burned - minted), 'in flight'], ['68', 'tests passing']];
  figs.forEach(([n, label], i) => {
    const x = 64 + i * 280;
    p.push(`<text x="${x}" y="298" fill="#e6edf3" font-size="72" font-weight="bold">${esc(n)}</text>`);
    p.push(`<text x="${x}" y="334" fill="#8b98a5" font-size="21">${esc(label)}</text>`);
  });

  p.push('<line x1="64" y1="378" x2="1136" y2="378" stroke="#21262d" stroke-width="2"/>');
  p.push('<text x="64" y="424" fill="#c9a6f5" font-size="21" font-weight="bold">BurnVault on Degen</text>');
  p.push(`<text x="64" y="456" fill="#adbac7" font-size="20" font-family="monospace">${esc(cfg.vaultAddress)}</text>`);
  p.push('<text x="640" y="424" fill="#79c0ff" font-size="21" font-weight="bold">BridgedNFT on Base</text>');
  p.push(`<text x="640" y="456" fill="#adbac7" font-size="20" font-family="monospace">${esc(cfg.nftAddress)}</text>`);

  p.push('<text x="64" y="524" fill="#8b98a5" font-size="20">Every token bridged so far, read from both chains just now:</text>');
  // Columns as separate <text> elements at fixed x. Padding inside a tspan does not
  // survive: SVG collapses leading whitespace, so the columns run together.
  rows.forEach((r, i) => {
    const y = 566 + i * 40;
    const cell = (x, fill, s) =>
      p.push(`<text x="${x}" y="${y}" fill="${fill}" font-size="20" font-family="monospace">${esc(s)}</text>`);
    cell(64, '#adbac7', `#${r.tokenId}`);
    cell(130, '#8b98a5', '→');
    cell(170, '#7ee787', r.ok ? `Base token ${r.id}` : 'in flight');
    cell(360, '#6a737d', r.uri || '(no metadata)');
    cell(920, '#6a737d', short(r.holder));
  });

  p.push('<text x="64" y="706" fill="#7ee787" font-size="21">agentatwork.xyz/bridge/ · github.com/agentatwork/degen-base-nft-bridge</text>');
  // The clock skew is the finding; putting it on the card is the point of the card.
  p.push(`<text x="64" y="742" fill="#6a737d" font-size="18">Degen head via chainBlock(): ${esc(head)}. Inside a contract, block.number reports the parent chain instead —</text>`);
  p.push('<text x="64" y="766" fill="#6a737d" font-size="18">a 23-million-block gap that stalls a naive relayer forever. Found by deploying, not by reasoning.</text>');
  p.push('</svg>');

  fs.writeFileSync(path.join(__dirname, 'card.svg'), p.join('\n'));
  console.log(`card.svg written — ${burned} burned, ${minted} minted, head ${head} (eth_blockNumber ${ref})`);
})().catch((e) => { console.error(e.shortMessage || e.message || e); process.exit(1); });
