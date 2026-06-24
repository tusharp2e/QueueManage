# Queue Manager — Load Test Report

**Window:** 22–23 June 2026 only (`created_at` 2026-06-22 → 2026-06-23; verified: **0 transactions fall outside this range**).
**Method:** `increment()` calls via the default smart wallet, submitted through `POST /queue/transaction`, dispatched in batches (≤10/wallet/chain) to the Bundler, tracked to terminal status in the DB.
**Source:** `smart_wallet_transactions` where `function_signature = 'function increment()'`, plus `logs/log-2026-06-22.log` and `logs/log-2026-06-23.log`.

## Executive summary

- **Amoy is healthy: 1817 / 1817 transactions succeeded (100%).**
- **Optimism Sepolia is largely broken: only 431 / 1802 succeeded (24%); 1371 (76%) are stuck unprocessed.**
- Root cause for the Sepolia chains is **Bundler-side**, not the Queue Manager: the Bundler returns `500 {"error":"transaction hash not available after 10 attempts"}`. The QM correctly reverts and retries, but the txns never clear.

## Results by chain

| Chain | Total | Success | Stuck (queued) | Other failed | Success rate | Latency p50 / p95 / max |
|---|---|---|---|---|---|---|
| **Amoy** (80002) | 1817 | 1817 | 0 | 0 | **100%** | 13.0s / 22.8s / 308.3s |
| **OP Sepolia** (11155420) | 1802 | 431 | 1371 | 0 | **24%** | 11.6s / 17.2s / 17.9s |
| **Eth Sepolia** (11155111) | 15 | 10 | 0 | 5 (validation_failed) | 67% | 50.6s / 91.2s / 93.5s |
| **Total** | 3634 | 2258 | 1371 | 5 | 62% | — |

*Latency = time from `queued` to terminal `success`. "Stuck (queued)" = never reached the Bundler successfully; reverted to `queued` and retried indefinitely (not marked failed).*

## Per-day breakdown

| Day | Chain | Success | Stuck (non-terminal) | Other failed |
|---|---|---|---|---|
| Jun 22 | Amoy (80002) | 1217 | 0 | 0 |
| Jun 22 | OP Sepolia (11155420) | 431 | 771 | 0 |
| Jun 22 | Eth Sepolia (11155111) | 10 | 0 | 5 |
| Jun 23 | Amoy (80002) | 600 | 0 | 0 |
| Jun 23 | OP Sepolia (11155420) | **0** | 600 | 0 |

**Notable:** all OP Sepolia successes (431) occurred on Jun 22. On **Jun 23, OP Sepolia had 0 successes** — every one of the 600 transactions is stuck `queued`, i.e. the Bundler's hash-resolution failure became fully blocking for that chain on the second day.

## Dispatch attempts (from logs)

| Chain | Batches accepted (2xx) | Batch failures (5xx) | Dominant error |
|---|---|---|---|
| Amoy (80002) | 624 | 54 | transient |
| OP Sepolia (11155420) | 199 | **1949** | `transaction hash not available after 10 attempts` |
| Eth Sepolia (11155111) | 2 | 11 | same |

## Key finding

Both Sepolia chains fail at the **Bundler's synchronous transaction-hash resolution**: after submitting, the Bundler polls for the tx hash up to 10 attempts, gives up, and returns `500`. Notably, the OP Sepolia txns that *did* succeed were **fast** (p50 11.6s, p95 17.2s) — so this is not a throughput/speed problem, it's the Bundler's hash-resolution failing ~76% of the time. The transaction is likely submitted on-chain but reported as failed, so:

1. The QM reverts the batch to `queued` and retries on the next tick → **1371 OP Sepolia txns are stuck in an infinite retry loop** (still hammering the Bundler now). They are `queued`, not `failed`, because the QM reverts (not fails) on Bundler error and the stale detector only sweeps `dispatched`/`sent`.
2. Because the original submit probably executed, retries risk **duplicate on-chain `increment()`s**.

## Recommendations

1. **Bundler (primary fix):** accept the batch and return `ACCEPTED` immediately, then resolve the tx hash **asynchronously** via the status pipeline — or make the hash-poll attempts/interval per-chain configurable. The current synchronous 10-attempt poll is too short for Sepolia/OP-Sepolia.
2. **Bundler:** ensure idempotency by `batch_id` / txn `id` so the QM's retries don't double-submit.
3. **Queue Manager (operational):** the 1371 stuck `queued` OP Sepolia txns should be cleared (mark `failed`) to stop the retry storm against the Bundler. Consider giving up after N consecutive failures (or distinguishing a permanent failure) so persistently-failing batches don't loop forever.

## Caveats

- Counts are cumulative across all runs in the window (multiple 100-txn runs).
- OP Sepolia on-chain `increment()` count likely exceeds submitted count due to retry double-submission.
- Amoy is the clean baseline; treat its numbers as the reference for QM performance.
