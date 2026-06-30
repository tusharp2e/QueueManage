// Controlled batch-SIZE load test.
//
// Goal: make the Queue Manager form batches of specific sizes (e.g. 1,3,5,8,10)
// rather than whatever the backlog happens to be. Because a wallet allows only
// ONE batch in-flight at a time, the only reliable way to control batch size is:
//
//   1. wait until the wallet is free (no queued/dispatched/sent rows for it)
//   2. submit exactly N txns as a fast concurrent BURST
//   3. wait until those N reach a terminal status (wallet frees again)
//   4. repeat for the next target size
//
// The gap between bursts is therefore DYNAMIC (driven by real on-chain settle
// time), not a fixed interval — a fixed sleep can't work when Sepolia settle
// time varies from ~30s to ~8min.
//
// Records the actual batch_id each txn landed in, so we can VERIFY that a burst
// of N really formed one batch of N (a dispatcher tick can occasionally split a
// burst; this measures how often).
//
// Run the QM (pointed at the real Bundler) first, then:
//   node scripts/batchSizeTest.js                      # sepolia, 150, [1,3,5,8,10]
//   node scripts/batchSizeTest.js sepolia 150 1,3,5,8,10
//   DRY_RUN=1 node scripts/batchSizeTest.js            # print schedule only, no POSTs

import fs from 'node:fs';
import path from 'node:path';
import { pool, closePool } from '../src/utils/db.js';
import { chainInfo } from '../src/config/chainInfo.js';

const QM_URL = process.env.QM_URL || 'http://localhost:3000';
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 3000);
// Must exceed the QM stale timeout so a stuck batch gets force-failed (-> terminal)
// and the loop continues instead of hanging forever.
const WAIT_TIMEOUT_MS = Number(process.env.WAIT_TIMEOUT_MS || 25 * 60 * 1000);
const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';

// Minimal preset table (same contracts/functions as loadTest.js).
const PRESETS = {
  amoy: { chainId: 80002, contract: '0xD3601131e5b98fab6326CC795e171252bA2Ae86C', fn: 'function increment()', args: () => [] },
  sepolia: { chainId: 11155111, contract: '0x98F811D169F8A87AF29015ac170B709135c5CC07', fn: 'function increment()', args: () => [] },
  avax: { chainId: 43113, contract: '0x98907e0dAf5E358B9569F2C57D8B06Ffad21028F', fn: 'function set1(uint256 _x)', args: (i) => [i] },
  baseSepolia: { chainId: 84532, contract: '0x0cC01096800d5DD37c42598832A3669295aE914C', fn: 'function set1(uint256 _x)', args: (i) => [i] },
  bnbTestnet: { chainId: 97, contract: '0x88C93C890C3C4355b7fF506e1ef19bCBaee8aDdF', fn: 'function set1(uint256 _x)', args: (i) => [i] },
  opSepolia: { chainId: 11155420, contract: '0x3caa944E4638c873b36638965521aBAf0d202bb9', fn: 'function set1(uint256 _x)', args: (i) => [i] },
  celo: { chainId: 11142220, contract: '0x7a5F2c113c247E8196DD453a7b7C57dbFc20793B', fn: 'function set1(uint256 _x)', args: (i) => [i] },
};
const ALIASES = { eth: 'sepolia', ethsepolia: 'sepolia', fuji: 'avax', base: 'baseSepolia', bnb: 'bnbTestnet', bsc: 'bnbTestnet', op: 'opSepolia', matic: 'amoy', polygon: 'amoy' };

const CHAIN_KEY = (process.argv[2] || 'sepolia').toLowerCase();
const presetKey = PRESETS[process.argv[2]] ? process.argv[2] : (ALIASES[CHAIN_KEY] || Object.keys(PRESETS).find((k) => k.toLowerCase() === CHAIN_KEY));
const preset = presetKey ? PRESETS[presetKey] : null;
if (!preset) {
  console.error(`Unknown chain "${process.argv[2]}". Valid: ${Object.keys(PRESETS).join(', ')}`);
  process.exit(1);
}
const TOTAL = Number(process.argv[3] || 150);
const PATTERN = (process.argv[4] || '1,3,5,8,10').split(',').map((n) => Number(n.trim())).filter((n) => n > 0);

const CHAIN_ID = preset.chainId;
const CONTRACT = process.env.CONTRACT || preset.contract;
const FUNCTION_SIGNATURE = process.env.FUNCTION_SIGNATURE || preset.fn;
const SMART_WALLET = process.env.SMART_WALLET || chainInfo[CHAIN_ID]?.smartWallet || '';
const IN_FLIGHT = ['queued', 'dispatched', 'sent'];
const TERMINAL = new Set(['success', 'failed', 'execution_failed', 'validation_failed']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Cycle PATTERN until TOTAL is reached; clamp the final batch to the remainder.
function buildSchedule(pattern, total) {
  const sizes = [];
  let sum = 0;
  let i = 0;
  while (sum < total) {
    let n = pattern[i % pattern.length];
    if (sum + n > total) n = total - sum;
    sizes.push(n);
    sum += n;
    i++;
  }
  return sizes;
}

const SCHEDULE = buildSchedule(PATTERN, TOTAL);

const startMs = Date.now();
const startIso = new Date(startMs).toISOString();
const CSV_PATH = path.resolve(process.env.CSV_PATH || `batchsize-${presetKey}-${startIso.replace(/[:.]/g, '-')}.csv`);

// One record per submitted txn.
const records = []; // { intendedSize, batchSeq, idx, queue_id, httpStatus, status, batch_id, submittedAt, createdAt, updatedAt, latencyS }
let stopping = false;
let finished = false;

async function postOne(intendedSize, batchSeq, idx) {
  const rec = {
    intendedSize, batchSeq, idx,
    queue_id: '', httpStatus: 0, status: '', batch_id: '',
    submittedAt: new Date().toISOString(), createdAt: '', updatedAt: '', latencyS: '',
  };
  try {
    const res = await fetch(`${QM_URL}/queue/transaction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        functionSignature: FUNCTION_SIGNATURE,
        args: preset.args(idx),
        contractAddress: CONTRACT,
        chainId: CHAIN_ID,
        smartWallet: SMART_WALLET,
      }),
    });
    rec.httpStatus = res.status;
    const body = await res.json().catch(() => ({}));
    if (res.ok) {
      rec.queue_id = body.queue_id || '';
      rec.status = body.status || '';
    } else {
      rec.status = 'POST_ERROR';
    }
  } catch {
    rec.status = 'POST_EXCEPTION';
  }
  records.push(rec);
  return rec;
}

// Submit N txns as concurrently as possible so the burst is far shorter than the
// 5s dispatcher tick — minimizing the chance a tick splits it across batches.
async function burst(intendedSize, batchSeq, startIdx) {
  return Promise.all(
    Array.from({ length: intendedSize }, (_, k) => postOne(intendedSize, batchSeq, startIdx + k))
  );
}

async function walletBusyCount() {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM smart_wallet_transactions
      WHERE smart_wallet_address = $1 AND status = ANY($2)`,
    [SMART_WALLET, IN_FLIGHT]
  );
  return rows[0].n;
}

async function waitWalletFree() {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  for (;;) {
    if (stopping) return;
    const n = await walletBusyCount();
    if (n === 0) return;
    if (Date.now() > deadline) throw new Error(`waitWalletFree timed out (${n} still busy)`);
    await sleep(POLL_INTERVAL_MS);
  }
}

// Poll the given queue_ids until all are terminal; fold status/batch_id/latency
// back into their records. Returns the DB rows.
async function waitBurstTerminal(queueIds) {
  if (queueIds.length === 0) return [];
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  for (;;) {
    const { rows } = await pool.query(
      `SELECT queue_id, batch_id, status, created_at, updated_at,
              ROUND(EXTRACT(EPOCH FROM (updated_at - created_at))::numeric, 1) AS lat
         FROM smart_wallet_transactions WHERE queue_id = ANY($1)`,
      [queueIds]
    );
    const byId = new Map(rows.map((r) => [r.queue_id, r]));
    for (const rec of records) {
      const row = byId.get(rec.queue_id);
      if (!row) continue;
      rec.status = row.status;
      rec.batch_id = row.batch_id || '';
      rec.createdAt = row.created_at ? new Date(row.created_at).toISOString() : '';
      rec.updatedAt = row.updated_at ? new Date(row.updated_at).toISOString() : '';
      rec.latencyS = TERMINAL.has(row.status) ? row.lat : '';
    }
    const allTerminal = rows.length === queueIds.length && rows.every((r) => TERMINAL.has(r.status));
    if (allTerminal || stopping) return rows;
    if (Date.now() > deadline) throw new Error(`waitBurstTerminal timed out`);
    await sleep(POLL_INTERVAL_MS);
  }
}

function writeCsv() {
  const header = 'intended_size,batch_seq,idx,queue_id,batch_id,http_status,final_status,submitted_at,created_at,updated_at,latency_seconds';
  const lines = records.map((r) =>
    [r.intendedSize, r.batchSeq, r.idx, r.queue_id, r.batch_id, r.httpStatus, r.status, r.submittedAt, r.createdAt, r.updatedAt, r.latencyS].join(',')
  );
  fs.writeFileSync(CSV_PATH, [header, ...lines].join('\n') + '\n');
  console.log(`\nCSV written: ${CSV_PATH} (${records.length} rows)`);
}

function pctile(sortedAsc, p) {
  if (!sortedAsc.length) return '-';
  return sortedAsc[Math.min(sortedAsc.length - 1, Math.floor((p / 100) * sortedAsc.length))].toFixed(1);
}

function printSummary() {
  console.log(`\n=== SUMMARY (started ${startIso}, ${((Date.now() - startMs) / 60000).toFixed(1)} min) ===`);

  // Batch-size fidelity: for each burst, how many distinct batch_ids did its
  // txns land in? 1 => the QM formed exactly one batch of the intended size.
  const bursts = new Map(); // batchSeq -> { intendedSize, ids:Set(batch_id) }
  for (const r of records) {
    if (!r.queue_id) continue;
    const b = bursts.get(r.batchSeq) || { intendedSize: r.intendedSize, batchIds: new Set() };
    if (r.batch_id) b.batchIds.add(r.batch_id);
    bursts.set(r.batchSeq, b);
  }
  let clean = 0;
  let split = 0;
  for (const b of bursts.values()) (b.batchIds.size === 1 ? clean++ : split++);
  console.log(`Batch-size fidelity: ${clean}/${bursts.size} bursts formed a single clean batch; ${split} were split by a tick.`);

  // Per intended size: counts, success rate, latency.
  for (const size of [...new Set(SCHEDULE)].sort((a, b) => a - b)) {
    const recs = records.filter((r) => r.intendedSize === size);
    const byStatus = recs.reduce((a, r) => ((a[r.status] = (a[r.status] || 0) + 1), a), {});
    const lats = recs.map((r) => Number(r.latencyS)).filter((n) => !Number.isNaN(n) && n !== 0).sort((a, b) => a - b);
    const success = byStatus['success'] || 0;
    const rate = recs.length ? ((success / recs.length) * 100).toFixed(0) : '0';
    console.log(
      `  size ${String(size).padStart(2)}: txns=${recs.length} success=${success} (${rate}%) | ${JSON.stringify(byStatus)} | ` +
      `lat p50=${pctile(lats, 50)}s p95=${pctile(lats, 95)}s max=${lats.length ? lats[lats.length - 1].toFixed(1) : '-'}s`
    );
  }
  const allSuccess = records.filter((r) => r.status === 'success').length;
  console.log(`OVERALL: ${records.length} txns, ${allSuccess} success (${records.length ? ((allSuccess / records.length) * 100).toFixed(0) : 0}%)`);
}

async function finish(reason) {
  if (finished) return;
  finished = true;
  stopping = true;
  console.log(`\nFinishing (${reason})...`);
  writeCsv();
  printSummary();
  await closePool().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', () => finish('SIGINT'));
process.on('SIGTERM', () => finish('SIGTERM'));

(async () => {
  console.log(`Batch-size test: chain=${presetKey}(${CHAIN_ID}) total=${TOTAL} pattern=[${PATTERN.join(',')}]`);
  console.log(`  schedule (${SCHEDULE.length} batches): [${SCHEDULE.join(',')}] sum=${SCHEDULE.reduce((a, b) => a + b, 0)}`);
  console.log(`  contract=${CONTRACT} fn="${FUNCTION_SIGNATURE}" wallet=${SMART_WALLET}`);

  if (DRY_RUN) {
    console.log('\nDRY_RUN: schedule printed, no transactions submitted.');
    await closePool().catch(() => {});
    return;
  }

  try {
    const h = await fetch(`${QM_URL}/health`);
    if (!h.ok) throw new Error(`/health -> ${h.status}`);
  } catch (err) {
    console.error(`Queue Manager not reachable at ${QM_URL}: ${err.message}`);
    await closePool().catch(() => {});
    process.exit(1);
  }
  console.log(`  CSV -> ${CSV_PATH}\n`);

  let idx = 0;
  for (let seq = 0; seq < SCHEDULE.length && !stopping; seq++) {
    const size = SCHEDULE[seq];
    process.stdout.write(`[batch ${seq + 1}/${SCHEDULE.length}] size ${size}: waiting for wallet free... `);
    await waitWalletFree();
    if (stopping) break;
    const recs = await burst(size, seq, idx);
    idx += size;
    const ids = recs.filter((r) => r.queue_id).map((r) => r.queue_id);
    process.stdout.write(`submitted ${ids.length}/${size}, settling... `);
    const rows = await waitBurstTerminal(ids);
    const distinctBatches = new Set(rows.map((r) => r.batch_id).filter(Boolean));
    const statuses = rows.reduce((a, r) => ((a[r.status] = (a[r.status] || 0) + 1), a), {});
    console.log(`done. batches=${distinctBatches.size} statuses=${JSON.stringify(statuses)}`);
  }

  await finish('completed');
})();
