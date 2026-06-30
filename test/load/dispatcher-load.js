// Dispatcher load test — measure how long ONE dispatchOnce() pass takes as the
// number of wallets grows, and whether it stays within the 5s tick interval.
//
//   node test/load/dispatcher-load.js
//   SCALES=100,500,1000,2000 PER_WALLET=5 node test/load/dispatcher-load.js
//
// What it proves: the per-tick cost of fan-out (one batch per wallet, processed
// concurrently), correctness at scale (one batch/wallet, right size, all
// dispatched), and — critically — whether a tick can finish before the next one
// is scheduled. A tick slower than dispatcherIntervalMs means ticks pile up.
import { randomUUID } from 'node:crypto';
import './_env.js';
import { ms } from './_stats.js';

const { dispatchOnce } = await import('../../src/jobs/dispatcher.js');
const { pool, config, cleanDB, closeAll, createMockBundler } = await import('../helpers/setup.js');

const SCALES = (process.env.SCALES || '100,500,1000').split(',').map((n) => Number(n.trim()));
const PER_WALLET = Number(process.env.PER_WALLET) || 5; // <= maxBatchSize so each batch = PER_WALLET

const CONTRACT = '0x2222222222222222222222222222222222222222';
const COLS = [
  'id', 'queue_id', 'status', 'transaction_type', 'chain_id', 'entry_point_address',
  'paymaster_address', 'smart_wallet_address', 'target_contract', 'function_signature', 'args', 'nonce',
];

async function bulkInsertQueued(walletCount, perWallet) {
  const ROWS_PER_CHUNK = 1000;
  let buffer = [];
  const flush = async () => {
    if (!buffer.length) return;
    const values = [];
    const tuples = buffer.map((r, ri) => {
      const base = ri * COLS.length;
      values.push(...r);
      const ph = COLS.map((c, ci) => (c === 'args' ? `$${base + ci + 1}::jsonb` : `$${base + ci + 1}`));
      return `(${ph.join(',')}, NOW(), NOW())`;
    });
    await pool.query(
      `INSERT INTO smart_wallet_transactions (${COLS.join(',')}, created_at, updated_at) VALUES ${tuples.join(',')}`,
      values
    );
    buffer = [];
  };

  for (let w = 0; w < walletCount; w++) {
    const wallet = '0x' + w.toString(16).padStart(40, '0');
    for (let k = 0; k < perWallet; k++) {
      const id = randomUUID();
      buffer.push([
        id, id, 'queued', 'call', 80002, config.testnetEntryPointAddress,
        config.testnetPaymasterAddress, wallet, CONTRACT, 'transfer(address,uint256)',
        JSON.stringify([String(k)]), '0',
      ]);
      if (buffer.length >= ROWS_PER_CHUNK) await flush();
    }
  }
  await flush();
}

async function statusCounts() {
  const { rows } = await pool.query(
    'SELECT status, COUNT(*)::int AS n FROM smart_wallet_transactions GROUP BY status'
  );
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

async function main() {
  const bundler = createMockBundler();
  await bundler.start();
  config.bundlerUrl = bundler.url();
  bundler.acceptAll();

  const interval = config.dispatcherIntervalMs;
  console.log(`Dispatcher load test — PER_WALLET=${PER_WALLET}, tick interval=${interval}ms\n`);
  console.log('wallets |  insert |  dispatch | batches | size | within interval?');
  console.log('--------+---------+-----------+---------+------+-----------------');

  let allOk = true;
  for (const walletCount of SCALES) {
    await cleanDB();
    bundler.clearReceived();

    const t0 = process.hrtime.bigint();
    await bulkInsertQueued(walletCount, PER_WALLET);
    const insertMs = Number(process.hrtime.bigint() - t0) / 1e6;

    const t1 = process.hrtime.bigint();
    await dispatchOnce();
    const dispatchMs = Number(process.hrtime.bigint() - t1) / 1e6;

    const batches = bundler.getReceivedBatches();
    const sizes = new Set(batches.map((b) => b.transactions.length));
    const counts = await statusCounts();

    const oneBatchPerWallet = batches.length === walletCount;
    const correctSize = sizes.size === 1 && [...sizes][0] === PER_WALLET;
    const allDispatched = counts.dispatched === walletCount * PER_WALLET && !counts.queued;
    const withinInterval = dispatchMs < interval;
    const ok = oneBatchPerWallet && correctSize && allDispatched;
    allOk = allOk && ok;

    console.log(
      `${String(walletCount).padStart(7)} | ${ms(insertMs).padStart(7)} | ${ms(dispatchMs).padStart(9)} | ` +
        `${String(batches.length).padStart(7)} | ${String([...sizes][0] ?? '-').padStart(4)} | ` +
        `${withinInterval ? 'yes' : 'NO — ticks will pile up'}${ok ? '' : '  [CORRECTNESS FAIL]'}`
    );
  }

  await bundler.stop();
  await closeAll();
  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
