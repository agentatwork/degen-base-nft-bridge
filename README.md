# One-way NFT bridge: Degen Chain → Base

Burn an NFT on Degen, get the same NFT on Base, with the same metadata, in your own wallet.

Live right now on the real chains — not a testnet:

| | chain | address |
|---|---|---|
| **BurnVault** (source) | Degen `666666666` | [`0x9dE9f9aED952a7DE181eC508115Ee25EAD65e6e7`](https://explorer.degen.tips/address/0x9dE9f9aED952a7DE181eC508115Ee25EAD65e6e7) |
| **BridgedNFT** (destination) | Base `8453` | [`0x28A00eDE11088AC206bE79a421c6b2B96453DE50`](https://basescan.org/address/0x28A00eDE11088AC206bE79a421c6b2B96453DE50) |
| DemoNFT (a collection to try it with) | Degen `666666666` | [`0xe983056edE831F205573eC5a1EC3795f56328794`](https://explorer.degen.tips/address/0xe983056edE831F205573eC5a1EC3795f56328794) |

Relayer status page: **https://agentatwork.xyz/bridge/**

```
npm install && node build.js && node demo.js     # the whole thing on your machine, 30 seconds
node test/e2e.js                                 # 64 assertions across two chains
```

## How it works

**BurnVault** on Degen takes custody of an NFT and appends a receipt to a public array:
collection, token id, holder, the metadata URI, the timestamp, and the block. There is no
withdrawal function and no owner — one-way is a structural property here, not a policy.
Two ways in: `safeTransferFrom` straight to the vault (one transaction), or `approve` then
`burn()`.

**relayer.js** polls `receiptCount()` and `receipts(offset, limit)`, waits for each receipt
to mature, and mints the copy on Base. It serves a status page showing every transaction it
has sent, because a trusted relayer that can't be checked is just a promise.

**BridgedNFT** on Base is one ERC-721 holding every bridged token, each with the metadata
copied from the origin. It records where each token came from — `originOf(tokenId)` returns
the chain id, collection and token id — and it will mint any given origin token **at most
once**, enforced on-chain rather than in the relayer's bookkeeping.

## The three design decisions that matter

**Idempotency lives in the contract, not the relayer.** The relayer is a server process: it
will be restarted mid-run, it will re-read receipts after a crash, and someone will
eventually run two copies of it. `bridgeMint` keys on `keccak256(originChainId,
originCollection, originTokenId)` and reverts on a repeat. The cursor file is only an
optimization — delete it and the relayer re-scans from zero and mints nothing extra. The
test suite proves exactly that.

**Metadata is captured at burn time, inside the burn transaction.** `tokenURI` is mutable on
plenty of collections. Reading it minutes later, from the relayer, can mint a copy of
something the original no longer says. The vault reads it in the same transaction that takes
custody, in a `try/catch` — because `tokenURI` is optional in ERC-721 and an unrevealed
token can revert, and a token whose metadata call fails must still be bridgeable rather than
permanently stuck.

**The receipts are an array, not just events.** The bounty asked for an array so a server can
read it easily, and it is the right call for a second reason: `eth_getLogs` ranges are
capped or billed by many providers, while `receiptCount()` + `receipts(offset, limit)` is
two calls against any node. Events are emitted as well, for anyone who prefers them.

## Two things that only showed up on the real chain

Both of these were found by deploying to Degen, not by reasoning about it. Both would have
been invisible on a local test chain, and both are fatal.

**1. `block.number` on Degen is not Degen's block number.** Degen is an Arbitrum Orbit L3.
Inside a contract, `block.number` returns the *parent* chain's height — the vault stamped a
receipt `49,964,015` while `eth_blockNumber` on the same chain answered `26,961,399`, a gap
of 23 million. A relayer that stores `block.number` and compares it against
`eth_blockNumber` computes a confirmation depth of minus 23 million, waits for it to reach
12, and relays nothing, ever.

The fix is `chainBlock()` on the vault: it staticcalls ArbSys at `0x64` (present on every
Arbitrum and Orbit chain, absent everywhere else) and falls back to `block.number`. Receipts
are stamped with it, and the relayer reads `vault.chainBlock()` instead of
`eth_blockNumber`. The relayer never has to know what kind of chain it is talking to — it
reads the same clock the receipts were written with. The raw `block.number` is kept in the
receipt too, as `burnedAtRefBlock`, since on an L3 that is the parent-chain height the
sequencer's batch will eventually be posted against.

**2. Degen makes blocks only when someone transacts.** Measured on the live chain: zero
blocks in twenty seconds. So "wait 12 confirmations" is not a bounded wait — it means "wait
until eleven strangers happen to send transactions", which on a quiet L3 can be hours. A
receipt therefore matures on **depth or age**, whichever comes first (`confirmations`,
`minAgeSeconds`). Depth is the reorg-safety rule; age is what makes the bridge terminate.

There is a third, smaller one, in ethers rather than the chain: its 250 ms response cache
also caches the account nonce, so a relayer sending several mints in quick succession reads
a stale nonce and the second transaction silently replaces the first. `cacheTimeout: -1`.

## Testing, and what "launch on testnet" had to mean

Degen has no public testnet. `testnet.rpc.degen.tips` and `rpc-testnet.degen.tips` are both
NXDOMAIN, and there is no faucet, so the source side of this bridge has nowhere to live on a
test network. What is here instead:

- `node test/e2e.js` — 64 assertions against **two local chains** carrying Degen's and
  Base's real chain ids. It mines blocks on demand, so it can actually exercise the paths a
  testnet only lets you wait for: confirmation depth, age-based maturity, a lost cursor, two
  relayers racing, a replayed mint, relayer key rotation, a collection whose `tokenURI`
  reverts, and an ArbSys precompile installed at `0x64` so the two clocks disagree exactly
  the way Degen's do.
- **A live deployment on Degen and Base**, which is where both of the findings above came
  from. Total cost of the whole live deployment, both chains: about four cents.

## Trust model

One-way with a centralized relayer cannot be trustless; it can be auditable, which is what
this aims at.

- The relayer can refuse to mint. It cannot mint to the wrong address without that being
  visible: every token records its origin, and every burn receipt is public on Degen.
- The relayer cannot double-mint, even if it tries. The contract rejects it.
- The relayer key is separate from the deployer key and can be rotated by the admin without
  redeploying or migrating anything — it is a hot key on a server, the most likely thing
  here to be compromised.
- The vault cannot be drained, unlocked, upgraded or paused, by me or anyone.
- Anyone can verify a bridged token without trusting the status page: read `receiptAt(n)` on
  Degen, then `originOf(id)` and `bridgedTokenOf(chainId, collection, tokenId)` on Base.

## Files

```
contracts/BurnVault.sol    source chain: custody + receipts + chainBlock()
contracts/BridgedNFT.sol   destination: ERC-721, relayer-gated, idempotent per origin token
contracts/DemoNFT.sol      a collection to test with
contracts/test/            a rogue collection and an ArbSys stub, used only by tests
relayer.js                 the poller, the miner of copies, and the status page
verify.js                  check both chains directly, trusting neither the relayer nor me
burn.js                    send an NFT into the vault (both paths)
deploy.js                  deploy either side, write config.json
demo.js                    two throwaway chains + the relayer, one command
build.js                   solc, no framework
test/e2e.js                64 assertions
```

No hardhat, no foundry: `npm install && node build.js` is the entire toolchain. Contracts
compile for the Paris EVM so one artifact deploys on both an OP-stack chain and an Orbit
chain.

## Running it

```bash
export DEPLOYER_KEY=0x...
node deploy.js source --rpc https://rpc.degen.tips
node deploy.js dest   --rpc https://mainnet.base.org --relayer 0xYourRelayerAddress
export RELAYER_KEY=0x...
node relayer.js                      # reads config.json
```

Keys come from the environment, never from argv — argv is readable by every process on the
box, and shell history keeps it.

MIT.
