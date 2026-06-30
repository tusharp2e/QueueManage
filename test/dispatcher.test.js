import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

import { dispatchOnce } from '../src/jobs/dispatcher.js';
import {
  config,
  cleanDB,
  closeAll,
  insertTestTxn,
  getTxn,
  createMockBundler,
} from './helpers/setup.js';

const CHAIN_A = 80002;
const CHAIN_B = 11155111; // a different supported chain (independent nonce space)

const WALLET_A = '0xaaa0000000000000000000000000000000000001';
const WALLET_B = '0xbbb0000000000000000000000000000000000002';
const WALLET_C = '0xccc0000000000000000000000000000000000003';

// Insert n queued txns for a wallet with strictly increasing created_at, so
// "oldest first" is deterministic. Returns ids in ascending created_at order.
async function insertQueued(wallet, n, startMs = Date.UTC(2023, 0, 1)) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    ids.push(
      await insertTestTxn({ smart_wallet_address: wallet, created_at: new Date(startMs + i * 1000) })
    );
  }
  return ids;
}

const statusesOf = async (ids) =>
  Promise.all(ids.map(async (id) => (await getTxn(id)).status));

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

describe('Layer 4 — dispatcher: single wallet', () => {
  it('no queued txns -> does nothing, no Bundler call', async () => {
    // Table is non-empty but nothing is dispatchable.
    const done = await insertTestTxn({ smart_wallet_address: WALLET_A, status: 'success' });
    const dead = await insertTestTxn({ smart_wallet_address: WALLET_A, status: 'failed' });

    await dispatchOnce();

    expect(bundler.getReceivedBatches()).toHaveLength(0);
    expect((await getTxn(done)).status).toBe('success');
    expect((await getTxn(dead)).status).toBe('failed');
  });

  it('1 queued txn -> dispatched (status + batch_id) and sent to the Bundler', async () => {
    const [id] = await insertQueued(WALLET_A, 1);

    await dispatchOnce();

    const row = await getTxn(id);
    expect(row.status).toBe('dispatched');
    expect(row.batch_id).not.toBeNull();

    const batches = bundler.getReceivedBatches();
    expect(batches).toHaveLength(1);
    expect(batches[0].smartWallet).toBe(WALLET_A);
    expect(batches[0].transactions).toHaveLength(1);
    expect(batches[0].transactions[0].id).toBe(id);
  });

  it('3 queued txns -> one batch, all share the same batch_id', async () => {
    const ids = await insertQueued(WALLET_A, 3);

    await dispatchOnce();

    const rows = await Promise.all(ids.map(getTxn));
    expect(rows.every((r) => r.status === 'dispatched')).toBe(true);
    const batchIds = new Set(rows.map((r) => r.batch_id));
    expect(batchIds.size).toBe(1); // exactly one batch_id across all three
    expect([...batchIds][0]).not.toBeNull();

    const batches = bundler.getReceivedBatches();
    expect(batches).toHaveLength(1);
    expect(batches[0].transactions).toHaveLength(3);
  });

  it('14 queued txns -> only 10 dispatched, 4 remain queued (batch-size cap)', async () => {
    const ids = await insertQueued(WALLET_A, 14);

    await dispatchOnce();

    const statuses = await statusesOf(ids);
    const dispatched = statuses.filter((s) => s === 'dispatched');
    const queued = statuses.filter((s) => s === 'queued');
    expect(dispatched).toHaveLength(config.maxBatchSize); // 10
    expect(queued).toHaveLength(4);

    expect(bundler.getReceivedBatches()[0].transactions).toHaveLength(10);
  });

  it('oldest txns dispatched first; the newest remain queued', async () => {
    const ids = await insertQueued(WALLET_A, 14); // ascending created_at

    await dispatchOnce();

    // The 10 oldest must be dispatched; the 4 newest must still be queued.
    const oldest10 = await statusesOf(ids.slice(0, 10));
    const newest4 = await statusesOf(ids.slice(10));
    expect(oldest10.every((s) => s === 'dispatched')).toBe(true);
    expect(newest4.every((s) => s === 'queued')).toBe(true);

    // And the batch carries them in created_at order.
    const sentIds = bundler.getReceivedBatches()[0].transactions.map((t) => t.id);
    expect(sentIds).toEqual(ids.slice(0, 10));
  });
});

describe('Layer 4 — dispatcher: wallet serialization (nonce safety)', () => {
  it("a 'dispatched' txn blocks new dispatch for that wallet", async () => {
    await insertTestTxn({ smart_wallet_address: WALLET_A, status: 'dispatched' });
    const queued = await insertQueued(WALLET_A, 2);

    await dispatchOnce();

    // The queued txns must NOT be dispatched while a batch is in flight.
    expect((await statusesOf(queued)).every((s) => s === 'queued')).toBe(true);
    expect(bundler.getReceivedBatches()).toHaveLength(0);
  });

  it("a 'sent' txn also blocks new dispatch for that wallet", async () => {
    await insertTestTxn({ smart_wallet_address: WALLET_A, status: 'sent' });
    const queued = await insertQueued(WALLET_A, 2);

    await dispatchOnce();

    expect((await statusesOf(queued)).every((s) => s === 'queued')).toBe(true);
    expect(bundler.getReceivedBatches()).toHaveLength(0);
  });

  it("only 'success' txns present -> wallet is free, queued txns dispatch", async () => {
    await insertTestTxn({ smart_wallet_address: WALLET_A, status: 'success' });
    const queued = await insertQueued(WALLET_A, 2);

    await dispatchOnce();

    expect((await statusesOf(queued)).every((s) => s === 'dispatched')).toBe(true);
    expect(bundler.getReceivedBatches()).toHaveLength(1);
  });

  it("only 'failed' txns present -> wallet is free, queued txns dispatch", async () => {
    await insertTestTxn({ smart_wallet_address: WALLET_A, status: 'failed' });
    const queued = await insertQueued(WALLET_A, 2);

    await dispatchOnce();

    expect((await statusesOf(queued)).every((s) => s === 'dispatched')).toBe(true);
    expect(bundler.getReceivedBatches()).toHaveLength(1);
  });
});

describe('Layer 4 — dispatcher: multiple wallets', () => {
  it('3 free wallets -> 3 separate batches dispatched concurrently', async () => {
    await insertQueued(WALLET_A, 2);
    await insertQueued(WALLET_B, 2);
    await insertQueued(WALLET_C, 2);

    // Prove the wallets are processed in parallel (Promise.all), not serially:
    // a slow handler lets us observe how many calls overlap at once. The delay
    // must comfortably exceed the per-wallet DB jitter (each dispatchWallet runs
    // 3 sequential queries before its fetch); 200ms gives ~40x margin over that
    // ~5ms jitter so all three fetches are reliably in flight together. Serial
    // execution would peak at 1.
    let inFlightNow = 0;
    let maxConcurrent = 0;
    bundler.setHandler(async (_req, res) => {
      inFlightNow += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlightNow);
      await new Promise((r) => setTimeout(r, 200));
      inFlightNow -= 1;
      res.status(200).json({ status: 'ACCEPTED' });
    });

    await dispatchOnce();

    const batches = bundler.getReceivedBatches();
    expect(batches).toHaveLength(3);
    expect(new Set(batches.map((b) => b.smartWallet))).toEqual(
      new Set([WALLET_A, WALLET_B, WALLET_C])
    );
    // Distinct batch per wallet.
    expect(new Set(batches.map((b) => b.batchId)).size).toBe(3);
    // All three were in flight simultaneously => genuinely concurrent.
    expect(maxConcurrent).toBe(3);
  });

  it('mix of free and in-flight wallets -> only the free one dispatches', async () => {
    // Wallet A is free; wallet B is in flight (has a dispatched txn).
    const freeA = await insertQueued(WALLET_A, 2);
    await insertTestTxn({ smart_wallet_address: WALLET_B, status: 'dispatched' });
    const blockedB = await insertQueued(WALLET_B, 2);

    await dispatchOnce();

    expect((await statusesOf(freeA)).every((s) => s === 'dispatched')).toBe(true);
    expect((await statusesOf(blockedB)).every((s) => s === 'queued')).toBe(true);

    const batches = bundler.getReceivedBatches();
    expect(batches).toHaveLength(1);
    expect(batches[0].smartWallet).toBe(WALLET_A);
  });
});

describe('Layer 4 — dispatcher: per-(wallet, chain) serialization', () => {
  it('same wallet on two chains -> two independent batches, both dispatched', async () => {
    // Identical wallet address, different chains = independent nonce spaces.
    const onA = await insertTestTxn({ smart_wallet_address: WALLET_A, chain_id: CHAIN_A });
    const onB = await insertTestTxn({ smart_wallet_address: WALLET_A, chain_id: CHAIN_B });

    await dispatchOnce();

    expect((await getTxn(onA)).status).toBe('dispatched');
    expect((await getTxn(onB)).status).toBe('dispatched');

    const batches = bundler.getReceivedBatches();
    expect(batches).toHaveLength(2);
    expect(batches.every((b) => b.smartWallet === WALLET_A)).toBe(true);
    expect(new Set(batches.map((b) => b.chainId))).toEqual(new Set([CHAIN_A, CHAIN_B]));
    expect(new Set(batches.map((b) => b.batchId)).size).toBe(2); // distinct batches
  });

  it('an in-flight batch on one chain does NOT block the same wallet on another chain', async () => {
    // Chain A is wedged (in-flight 'dispatched'); chain B for the SAME wallet is free.
    await insertTestTxn({ smart_wallet_address: WALLET_A, chain_id: CHAIN_A, status: 'dispatched' });
    const blockedOnA = await insertTestTxn({
      smart_wallet_address: WALLET_A,
      chain_id: CHAIN_A,
      status: 'queued',
    });
    const freeOnB = await insertTestTxn({
      smart_wallet_address: WALLET_A,
      chain_id: CHAIN_B,
      status: 'queued',
    });

    await dispatchOnce();

    // The in-flight check is scoped to (wallet, chain): chain A stays blocked,
    // chain B dispatches independently.
    expect((await getTxn(blockedOnA)).status).toBe('queued');
    expect((await getTxn(freeOnB)).status).toBe('dispatched');

    const batches = bundler.getReceivedBatches();
    expect(batches).toHaveLength(1);
    expect(batches[0].chainId).toBe(CHAIN_B);
  });
});

describe('Layer 4 — dispatcher: Bundler failure -> revert', () => {
  it('Bundler 500 -> batch reverted to queued, batch_id cleared', async () => {
    const ids = await insertQueued(WALLET_A, 3);
    bundler.rejectAll();

    await dispatchOnce();

    const rows = await Promise.all(ids.map(getTxn));
    expect(rows.every((r) => r.status === 'queued')).toBe(true);
    expect(rows.every((r) => r.batch_id === null)).toBe(true);
  });

  it('Bundler unreachable -> batch reverted to queued', async () => {
    const ids = await insertQueued(WALLET_A, 2);

    // Point at a port we just freed: connection refused.
    const temp = createMockBundler();
    await temp.start();
    const deadUrl = temp.url();
    await temp.stop();
    config.bundlerUrl = deadUrl;

    await dispatchOnce();

    const rows = await Promise.all(ids.map(getTxn));
    expect(rows.every((r) => r.status === 'queued')).toBe(true);
    expect(rows.every((r) => r.batch_id === null)).toBe(true);
  });

  it('one wallet fails, others succeed -> only the failed wallet is reverted', async () => {
    const idsA = await insertQueued(WALLET_A, 2);
    const idsB = await insertQueued(WALLET_B, 2);
    const idsC = await insertQueued(WALLET_C, 2);

    // Fail only wallet B; accept A and C.
    bundler.setHandler((req, res) => {
      if (req.body.smartWallet === WALLET_B) {
        return res.status(500).json({ error: 'BUNDLER_DOWN' });
      }
      return res.status(200).json({ status: 'ACCEPTED' });
    });

    await dispatchOnce();

    expect((await statusesOf(idsA)).every((s) => s === 'dispatched')).toBe(true);
    expect((await statusesOf(idsC)).every((s) => s === 'dispatched')).toBe(true);
    // Only B reverted.
    expect((await statusesOf(idsB)).every((s) => s === 'queued')).toBe(true);
    expect((await Promise.all(idsB.map(getTxn))).every((r) => r.batch_id === null)).toBe(true);
  });
});

describe('Layer 4 — dispatcher: payload correctness', () => {
  it('batch carries the expected fields in the expected format', async () => {
    const wallet = WALLET_A;
    const id = await insertTestTxn({
      smart_wallet_address: wallet,
      chain_id: 80002,
      target_contract: '0x2222222222222222222222222222222222222222',
      function_signature: 'transfer(address,uint256)',
      args: ['0x3333333333333333333333333333333333333333', '1000'],
      transaction_type: 'call',
    });

    await dispatchOnce();

    const batch = bundler.getReceivedBatches()[0];
    expect(typeof batch.batchId).toBe('string');
    expect(batch.smartWallet).toBe(wallet);
    expect(batch.chainId).toBe(80002); // coerced to a number
    expect(typeof batch.chainId).toBe('number');

    const tx = batch.transactions[0];
    expect(tx).toEqual({
      id,
      // Stable idempotency key (= id) the Bundler forwards to thirdweb so a
      // reverted-and-retried batch can't double-execute on-chain.
      idempotencyKey: id,
      contractAddress: '0x2222222222222222222222222222222222222222',
      functionSignature: 'transfer(address,uint256)',
      args: ['0x3333333333333333333333333333333333333333', '1000'],
      transactionType: 'call',
      paymasterAddress: config.testnetPaymasterAddress,
      entryPointAddress: config.testnetEntryPointAddress,
    });
  });

  it('mixed call/deploy txns in one batch -> both types included', async () => {
    await insertTestTxn({
      smart_wallet_address: WALLET_A,
      transaction_type: 'call',
      created_at: new Date(Date.UTC(2023, 0, 1, 0, 0, 0)),
    });
    await insertTestTxn({
      smart_wallet_address: WALLET_A,
      transaction_type: 'deploy',
      created_at: new Date(Date.UTC(2023, 0, 1, 0, 0, 1)),
    });

    await dispatchOnce();

    const batch = bundler.getReceivedBatches()[0];
    expect(batch.transactions).toHaveLength(2);
    expect(batch.transactions.map((t) => t.transactionType)).toEqual(['call', 'deploy']);
  });
});
