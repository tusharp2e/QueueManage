// Ingestion load test — blast many POST /queue/transaction requests at the real
// HTTP server and report the latency distribution + correctness.
//
//   node test/load/ingestion-load.js
//   COUNT=2000 CONCURRENCY=100 node test/load/ingestion-load.js
//
// What it proves: under a burst, what p50/p95/p99/max latency looks like, and
// that EVERY accepted request produced exactly one DB row (no silent drops).
import './_env.js';
import { summarize, ms } from './_stats.js';

const { app } = await import('../../src/app.js');
const { pool, cleanDB, closeAll } = await import('../helpers/setup.js');

const COUNT = Number(process.env.COUNT) || 1000;
const CONCURRENCY = Number(process.env.CONCURRENCY) || 50;

function validBody(i) {
  return {
    functionSignature: 'transfer(address,uint256)',
    contractAddress: '0x2222222222222222222222222222222222222222',
    chainId: 80002,
    // Spread across many wallets so the rows are realistic, not all identical.
    smartWallet: '0x' + (i % 500).toString(16).padStart(40, '0'),
    args: ['0x3333333333333333333333333333333333333333', String(i)],
  };
}

async function main() {
  await cleanDB();
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/queue/transaction`;

  const latencies = [];
  let ok = 0;
  let failed = 0;
  let next = 0;

  console.log(`Blasting ${COUNT} requests at ${url} (concurrency ${CONCURRENCY})...`);
  const wallStart = process.hrtime.bigint();

  // Fixed-size worker pool: each worker pulls the next index until exhausted.
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= COUNT) return;
      const t0 = process.hrtime.bigint();
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(validBody(i)),
        });
        const dt = Number(process.hrtime.bigint() - t0) / 1e6;
        latencies.push(dt);
        if (res.status === 200) ok += 1;
        else failed += 1;
      } catch {
        failed += 1;
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const wallMs = Number(process.hrtime.bigint() - wallStart) / 1e6;

  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM smart_wallet_transactions');
  const dbCount = rows[0].n;

  const s = summarize(latencies);
  console.log('\n=== Ingestion load report ===');
  console.log(`requests:     ${COUNT}  (concurrency ${CONCURRENCY})`);
  console.log(`succeeded:    ${ok}   failed: ${failed}`);
  console.log(`wall time:    ${ms(wallMs)}   throughput: ${((COUNT / wallMs) * 1000).toFixed(0)} req/s`);
  console.log(`latency p50:  ${ms(s.p50)}`);
  console.log(`latency p95:  ${ms(s.p95)}`);
  console.log(`latency p99:  ${ms(s.p99)}`);
  console.log(`latency max:  ${ms(s.max)}`);
  console.log(`latency mean: ${ms(s.mean)}`);
  console.log(`rows in DB:   ${dbCount}  (expected ${ok})`);

  const correct = dbCount === ok && failed === 0;
  console.log(correct ? '\nPASS: all requests succeeded and persisted.' : '\nFAIL: drops or errors detected.');

  await new Promise((resolve) => server.close(resolve));
  await closeAll();
  process.exit(correct ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
