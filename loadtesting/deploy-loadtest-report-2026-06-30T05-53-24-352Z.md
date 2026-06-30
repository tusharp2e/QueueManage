# Deploy Load Test Report

- **Started:** 2026-06-30T05:53:24.352Z | **Duration:** 0.9 min | **Finished:** all chains reached target
- **Flow:** contract deploy via `/queue/deploy` (universal deployer)
- **Batch sizes:** [1, 3, 5, 8] cycled to target | **Target:** 4 deploys/chain
- **Paymaster:** 0xC0c93FB14810d5a6Ace26999b816F5c3522249E0 | **EntryPoint:** 0x437A904958Fcf25ad6a6A9BC7F28b2F02d2D8485
- **Total deploys submitted:** 4

## 1. Per-chain results

| Chain | Target | Submitted | Success | Failed | Deployed (addr resolved) | Success % |
|---|---:|---:|---:|---:|---:|---:|
| sepolia | 4 | 4 | 4 | 0 | 4 | 100.0% |

## 2. Funds burnt (paymaster deposit)

Deposit read on-chain (EntryPoint.balanceOf) before and after the run.

| Chain | Deposit before | Deposit after | Burnt | Cost/deploy (success) |
|---|---:|---:|---:|---:|
| sepolia | 1.77243 ETH | 1.74641 ETH | 0.02602 ETH | 0.006505 ETH |

> Note: deposit is shared across the paymaster; if other traffic hit it during the run, "burnt" is an upper bound for this test.

## 3. Batch-size fidelity

| Intended size | Bursts | Clean (1 batch) | Split |
|---:|---:|---:|---:|
| 1 | 1 | 1 | 0 |
| 3 | 1 | 1 | 0 |
| 5 | 0 | 0 | 0 |
| 8 | 0 | 0 | 0 |

## 4. Latency (queued -> terminal, seconds)

| Chain | p50 | p95 | max |
|---|---:|---:|---:|
| sepolia | 35.5 | 35.6 | 35.6 |

By batch size (all chains):

| Size | p50 | p95 | max |
|---:|---:|---:|---:|
| 1 | 16.4 | 16.4 | 16.4 |
| 3 | 35.5 | 35.6 | 35.6 |
| 5 | - | - | - |
| 8 | - | - | - |

## 5. Failures

No failed deploys. 🎉

## 6. Throughput & deployed contracts

- 4 deploys, 4 success (100.0%) in 0.9 min
- Throughput: 4.0 deploys/min
- Distinct contracts deployed: 2
- Sample addresses: 0x11d306c808276bfD4AaBf54600455714411bF58c, 0x53b109DCbc2A7DD95DDa2FB7f5008718DA526bA7

Raw per-deploy data: `deploy-loadtest-2026-06-30T05-53-24-352Z.csv`
