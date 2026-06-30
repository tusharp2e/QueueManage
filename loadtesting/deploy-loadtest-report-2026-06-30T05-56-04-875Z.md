# Deploy Load Test Report

- **Started:** 2026-06-30T05:56:04.875Z | **Duration:** 23.5 min | **Finished:** all chains reached target
- **Flow:** contract deploy via `/queue/deploy` (universal deployer)
- **Batch sizes:** [1, 3, 5, 8] cycled to target | **Target:** 200 deploys/chain
- **Paymaster:** 0xC0c93FB14810d5a6Ace26999b816F5c3522249E0 | **EntryPoint:** 0x437A904958Fcf25ad6a6A9BC7F28b2F02d2D8485
- **Total deploys submitted:** 400

## 1. Per-chain results

| Chain | Target | Submitted | Success | Failed | Deployed (addr resolved) | Success % |
|---|---:|---:|---:|---:|---:|---:|
| amoy | 200 | 200 | 200 | 0 | 200 | 100.0% |
| sepolia | 200 | 200 | 200 | 0 | 200 | 100.0% |

## 2. Funds burnt (paymaster deposit)

Deposit read on-chain (EntryPoint.balanceOf) before and after the run.

| Chain | Deposit before | Deposit after | Burnt | Cost/deploy (success) |
|---|---:|---:|---:|---:|
| amoy | 47.42850 POL | 46.60990 POL | 0.81859 POL | 0.004093 POL |
| sepolia | 1.74641 ETH | 0.52383 ETH | 1.22258 ETH | 0.006113 ETH |

> Note: deposit is shared across the paymaster; if other traffic hit it during the run, "burnt" is an upper bound for this test.

## 3. Batch-size fidelity

| Intended size | Bursts | Clean (1 batch) | Split |
|---:|---:|---:|---:|
| 1 | 24 | 24 | 0 |
| 3 | 24 | 24 | 0 |
| 5 | 24 | 24 | 0 |
| 8 | 22 | 22 | 0 |

## 4. Latency (queued -> terminal, seconds)

| Chain | p50 | p95 | max |
|---|---:|---:|---:|
| amoy | 10.4 | 12.7 | 17.3 |
| sepolia | 34.3 | 36.0 | 36.6 |

By batch size (all chains):

| Size | p50 | p95 | max |
|---:|---:|---:|---:|
| 1 | 15.3 | 35.9 | 35.9 |
| 3 | 11.6 | 35.6 | 35.9 |
| 5 | 11.5 | 36.0 | 36.0 |
| 8 | 16.4 | 35.9 | 36.6 |

## 5. Failures

No failed deploys. 🎉

## 6. Throughput & deployed contracts

- 400 deploys, 400 success (100.0%) in 23.5 min
- Throughput: 17.0 deploys/min
- Distinct contracts deployed: 90
- Sample addresses: 0xaBFD102FEd74E8E5F44Cd50Fd9c4F432C4C94D88, 0xa1db11aC0bC119289293B1a8abFbBd48EC5E2213, 0xB68fE9120628Be4A438A3986742Deb6FF8cCB6D4, 0x6e6374613687d7F698799Fb41bB90Db50ed6777B, 0xc5250797e0343f99090710f3DEe31377fbc771eD

Raw per-deploy data: `deploy-loadtest-2026-06-30T05-56-04-875Z.csv`
