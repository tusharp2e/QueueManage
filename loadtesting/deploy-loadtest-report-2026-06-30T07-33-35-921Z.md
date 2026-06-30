# Deploy Load Test Report

- **Started:** 2026-06-30T07:33:35.921Z | **Duration:** 0.7 min | **Finished:** all chains reached target
- **Flow:** contract deploy via `/queue/deploy` (universal deployer)
- **Batch sizes:** [3] cycled to target | **Target:** 3 deploys/chain
- **Paymaster:** 0xC0c93FB14810d5a6Ace26999b816F5c3522249E0 | **EntryPoint:** 0x437A904958Fcf25ad6a6A9BC7F28b2F02d2D8485
- **Total deploys submitted:** 3

## 1. Per-chain results

| Chain | Target | Submitted | Success | Failed | Deployed (addr resolved) | Success % |
|---|---:|---:|---:|---:|---:|---:|
| sepolia | 3 | 3 | 3 | 0 | 3 | 100.0% |

## 2. Funds burnt (paymaster deposit)

Deposit read on-chain (EntryPoint.balanceOf) before and after the run.

| Chain | Deposit before | Deposit after | Burnt | Cost/deploy (success) |
|---|---:|---:|---:|---:|
| sepolia | 0.52383 ETH | 0.51063 ETH | 0.01320 ETH | 0.004400 ETH |

> Note: deposit is shared across the paymaster; if other traffic hit it during the run, "burnt" is an upper bound for this test.

## 3. Batch-size fidelity

| Intended size | Bursts | Clean (1 batch) | Split |
|---:|---:|---:|---:|
| 3 | 1 | 1 | 0 |

## 4. Latency (queued -> terminal, seconds)

| Chain | p50 | p95 | max |
|---|---:|---:|---:|
| sepolia | 26.6 | 41.5 | 41.5 |

By batch size (all chains):

| Size | p50 | p95 | max |
|---:|---:|---:|---:|
| 3 | 26.6 | 41.5 | 41.5 |

## 5. Failures

No failed deploys. 🎉

## 6. Throughput & deployed contracts

- 3 deploys, 3 success (100.0%) in 0.7 min
- Throughput: 3.0 deploys/min
- Distinct contracts deployed: 1
- Sample addresses: 0x510017F2D841712F5c7B52138e841e63ef2417ed

Raw per-deploy data: `deploy-loadtest-2026-06-30T07-33-35-921Z.csv`
