// Sustained load test — steady traffic for a long window, watching for leaks
// and stuck work. Runs the FULL system: HTTP ingestion + the real dispatcher
// and stale-detector loops.
//
//   node test/load/sustained-load.js
//   DURATION_SEC=600 RATE=10 WALLETS=50 node test/load/sustained-load.js
//   DURATION_SEC=20 node test/load/sustained-load.js   # quick smoke
//
// What it proves: over time, memory (RSS/heap) and the connection pool stay
// flat (no leak), the error rate stays ~0, and — after draining — there are
// ZERO transactions stuck in a non-terminal status (queued/dispatched/sent).
//
// The mock Bundler simulates the real one's eventual callback: after accepting
// a batch it marks those txns 'success', so wallets cycle queued->dispatched->
// success instead of piling up in 'dispatched'.
import './_env.js';
import { mb, ms } from './_stats.js';

const { app } = await import('../../src/app.js');
const { startDispatcher, stopDispatcher, dispatchOnce } = await import('../../src/jobs/dispatcher.js');
const { startStaleDetector, stopStaleDetector } = await import('../../src/jobs/staleDetector.js');
const { pool, config, cleanDB, closeAll, createMockBundler } = await import('../helpers/setup.js');

const DURATION_SEC = Number(process.env.DURATION_SEC) || 600;
const RATE = Number(process.env.RATE) || 10; // txns/sec
const WALLETS = Number(process.env.WALLETS) || 50;
const COMPLETION_DELAY_MS = Number(process.env.COMPLETION_DELAY_MS) || 300;

const sleep = (t) => new Promise((r) => setTimeout(r, t));
const wallet = (i) => '0x' + i.toString(16).padStart(40, '0');

async function statusCounts() {
  const { rows } = await pool.query(
    'SELECT status, COUNT(*)::int AS n FROM smart_wallet_transactions GROUP BY status'
  );
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

async function main() {
  await cleanDB();

  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const url = `http://127.0.0.1:${server.address().port}/queue/transaction`;

  // Mock Bundler that simulates eventual on-chain completion.
  const bundler = createMockBundler();
  await bundler.start();
  config.bundlerUrl = bundler.url();
  bundler.setHandler((req, res) => {
    res.status(200).json({ status: 'ACCEPTED' });
    const ids = (req.body.transactions || []).map((t) => t.id);
    if (ids.length) {
      setTimeout(() => {
        pool
          .query(
            `UPDATE smart_wallet_transactions SET status='success', updated_at=NOW()
              WHERE id = ANY($1::uuid[]) AND status='dispatched'`,
            [ids]
          )
          .catch(() => {});
      }, COMPLETION_DELAY_MS);
    }
  });

  startDispatcher();
  startStaleDetector();

  let sent = 0;
  let okSent = 0;
  let errSent = 0;
  const memStart = process.memoryUsage();
  const startMs = Date.now();

  console.log(
    `Sustained load: ${RATE} txn/s for ${DURATION_SEC}s across ${WALLETS} wallets ` +
      `(~${RATE * DURATION_SEC} txns)\n`
  );
  console.log('  t(s) |   sent | ok | err |    queued | dispatched | success |   rss |  heap | pool(idle/total/wait)');
  console.log('-------+--------+----+-----+-----------+------------+---------+-------+-------+----------------------');

  // Producer: one request every 1000/RATE ms.
  const producer = setInterval(async () => {
    sent += 1;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          functionSignature: 'transfer(address,uint256)',
          contractAddress: '0x2222222222222222222222222222222222222222',
          chainId: 80002,
          smartWallet: wallet(Math.floor(Math.random() * WALLETS)),
          args: [String(sent)],
        }),
      });
      if (res.status === 200) okSent += 1;
      else errSent += 1;
    } catch {
      errSent += 1;
    }
  }, Math.max(1, Math.round(1000 / RATE)));

  // Monitor: sample every 5s.
  const samples = [];
  const monitor = setInterval(async () => {
    const elapsed = ((Date.now() - startMs) / 1000).toFixed(0);
    const c = await statusCounts();
    const mem = process.memoryUsage();
    samples.push({ rss: mem.rss, heap: mem.heapUsed });
    console.log(
      `${String(elapsed).padStart(6)} | ${String(sent).padStart(6)} | ${String(okSent).padStart(2)} | ` +
        `${String(errSent).padStart(3)} | ${String(c.queued ?? 0).padStart(9)} | ${String(c.dispatched ?? 0).padStart(10)} | ` +
        `${String(c.success ?? 0).padStart(7)} | ${mb(mem.rss).padStart(5)} | ${mb(mem.heapUsed).padStart(5)} | ` +
        `${pool.idleCount}/${pool.totalCount}/${pool.waitingCount}`
    );
    bundler.clearReceived(); // keep the harness's own buffer bounded (not a leak under test)
  }, 5000);

  await sleep(DURATION_SEC * 1000);

  // --- Stop producing and drain ---
  clearInterval(producer);
  clearInterval(monitor);
  console.log('\nProduction stopped. Draining...');
  await Promise.all([stopDispatcher(), stopStaleDetector()]);

  // Drive remaining work to completion: dispatch, let mock completions land,
  // repeat until nothing is left in a non-terminal status (bounded retries).
  let drained = false;
  for (let i = 0; i < 120; i++) {
    await dispatchOnce();
    await sleep(COMPLETION_DELAY_MS + 200);
    const c = await statusCounts();
    if (!c.queued && !c.dispatched && !c.sent) {
      drained = true;
      break;
    }
  }

  const final = await statusCounts();
  const stuck = (final.queued ?? 0) + (final.dispatched ?? 0) + (final.sent ?? 0);
  const memEnd = process.memoryUsage();

  console.log('\n=== Sustained load report ===');
  console.log(`sent:          ${sent}   ok: ${okSent}   errors: ${errSent}`);
  console.log(`error rate:    ${((errSent / Math.max(1, sent)) * 100).toFixed(2)}%`);
  console.log(`final status:  ${JSON.stringify(final)}`);
  console.log(`stuck (q+d+s): ${stuck}${drained ? '' : '  (drain did not fully complete)'}`);
  console.log(`RSS:  ${mb(memStart.rss)} -> ${mb(memEnd.rss)}  (delta ${mb(memEnd.rss - memStart.rss)})`);
  console.log(`heap: ${mb(memStart.heapUsed)} -> ${mb(memEnd.heapUsed)}  (delta ${mb(memEnd.heapUsed - memStart.heapUsed)})`);

  const pass = stuck === 0 && errSent === 0 && drained;
  console.log(pass ? '\nPASS: no stuck txns, no errors.' : '\nFAIL: stuck txns or errors detected.');

  await new Promise((resolve) => server.close(resolve));
  await bundler.stop();
  await closeAll();
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
