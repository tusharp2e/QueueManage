import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

import { sweepStale } from '../src/jobs/staleDetector.js';
import { dispatchOnce } from '../src/jobs/dispatcher.js';
import {
  config,
  cleanDB,
  closeAll,
  insertTestTxn,
  getTxn,
  createMockBundler,
} from './helpers/setup.js';

const WALLET = '0xstale00000000000000000000000000000000001';

// Staleness is measured on updated_at ("how long stuck in this status"), not
// created_at. Offsets are derived from the CONFIGURED threshold rather than a
// hardcoded 6 minutes, so the test asserts behavior relative to the threshold
// and can't silently break if the pinned STALE_TIMEOUT_MINUTES changes.
const threshold = config.staleTimeoutMinutes; // pinned to 5 in vitest.config
const minutesAgo = (m) => new Date(Date.now() - m * 60 * 1000);
const STALE = () => minutesAgo(threshold + 2); // comfortably past the threshold
const FRESH = () => minutesAgo(Math.max(1, threshold - 2)); // comfortably within it
const ANCIENT = () => minutesAgo(threshold * 20 + 60); // very old: age alone is irrelevant

const bundler = createMockBundler();
let originalBundlerUrl;

beforeAll(async () => {
  await bundler.start();
  originalBundlerUrl = config.bundlerUrl;
});

afterAll(async () => {
  config.bundlerUrl = originalBundlerUrl;
  await bundler.stop();
  await closeAll();
});

beforeEach(async () => {
  await cleanDB();
  config.bundlerUrl = bundler.url();
  bundler.acceptAll();
  bundler.clearReceived();
});

describe('Layer 5 — stale detector: catches genuinely stuck txns', () => {
  it("'dispatched' past the threshold -> marked failed (and returned)", async () => {
    const id = await insertTestTxn({
      smart_wallet_address: WALLET,
      status: 'dispatched',
      updated_at: STALE(),
    });

    const failed = await sweepStale();

    const row = await getTxn(id);
    expect(row.status).toBe('failed');
    expect(row.message).toMatch(/stale/i);
    // The RETURNING contract feeds the KWALA-callback hook downstream.
    expect(failed.map((r) => r.id)).toContain(id);
  });

  it("'sent' past the threshold -> marked failed", async () => {
    const id = await insertTestTxn({
      smart_wallet_address: WALLET,
      status: 'sent',
      updated_at: STALE(),
    });

    await sweepStale();

    expect((await getTxn(id)).status).toBe('failed');
  });
});

describe('Layer 5 — stale detector: leaves the wrong things alone (false-positive guards)', () => {
  it("'dispatched' UNDER the threshold -> untouched (do not fail in-flight work)", async () => {
    const id = await insertTestTxn({
      smart_wallet_address: WALLET,
      status: 'dispatched',
      updated_at: FRESH(),
    });

    const failed = await sweepStale();

    const row = await getTxn(id);
    expect(row.status).toBe('dispatched'); // still in flight
    expect(row.message).toBeNull(); // UPDATE never ran on this row
    expect(failed.map((r) => r.id)).not.toContain(id);
  });

  it("'queued' of any age -> untouched (waiting is not stuck)", async () => {
    const id = await insertTestTxn({
      smart_wallet_address: WALLET,
      status: 'queued',
      updated_at: ANCIENT(),
    });

    await sweepStale();

    expect((await getTxn(id)).status).toBe('queued');
  });

  it('terminal statuses of any age -> untouched (never clobber a final outcome)', async () => {
    const terminal = ['success', 'execution_failed', 'validation_failed', 'failed'];
    const ids = {};
    for (const status of terminal) {
      ids[status] = await insertTestTxn({
        smart_wallet_address: WALLET,
        status,
        updated_at: ANCIENT(),
      });
    }

    await sweepStale();

    for (const status of terminal) {
      expect((await getTxn(ids[status])).status).toBe(status);
    }
  });
});

describe('Layer 5 — stale detector: restores forward progress', () => {
  it('after sweeping a stuck batch, the wallet is unblocked and can dispatch again', async () => {
    // A wedged wallet: a stuck 'dispatched' txn plus newer queued work behind it.
    await insertTestTxn({
      smart_wallet_address: WALLET,
      status: 'dispatched',
      updated_at: STALE(),
    });
    const queuedId = await insertTestTxn({
      smart_wallet_address: WALLET,
      status: 'queued',
      created_at: new Date(),
    });

    // Before the sweep, the in-flight 'dispatched' row blocks all new dispatch.
    await dispatchOnce();
    expect((await getTxn(queuedId)).status).toBe('queued');
    expect(bundler.getReceivedBatches()).toHaveLength(0);

    // Sweep frees the wallet by failing the stuck row...
    await sweepStale();

    // ...so the next dispatch tick can finally send the queued work.
    await dispatchOnce();
    expect((await getTxn(queuedId)).status).toBe('dispatched');
    expect(bundler.getReceivedBatches()).toHaveLength(1);
  });
});
