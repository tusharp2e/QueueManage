// Multi-chain controlled-batch load test.
//
// Mission: drive each of the 7 supported testnets to a target userOp count
// (default 1000, BNB 800), forming batches of sizes cycled through [1,3,7,10],
// then write a full statistics report.
//
// Submission strategy (chosen for batch-size fidelity + realistic concurrency):
//   - Within a batch: submit N userOps as a tight CONCURRENT burst (~0ms apart),
//     far shorter than the 5s dispatcher tick, so all N land in ONE batch.
//   - Between batches (per chain): DYNAMIC gate, no fixed interval — the next
//     burst fires only after the current batch reaches a terminal status
//     (the (wallet,chain) unit is free again). Real settle time paces it.
//   - Across chains: all 7 run fully concurrently. The dispatcher serializes per
//     (smart_wallet_address, chain_id), so the shared default wallet on 7 chains
//     is 7 independent units.
//
// Self-stops when every chain reaches its target OR a chain's paymaster deposit
// can no longer fund the next burst (abort-guard). Writes a Markdown report +
// per-userOp CSV. Ctrl-C writes a partial report.
//
//   node scripts/multiChainLoadTest.js                 # all 7, 1000 each (BNB 800)
//   node scripts/multiChainLoadTest.js sepolia,avax    # subset
//   TARGET=200 node scripts/multiChainLoadTest.js       # override default target

import fs from 'node:fs';
import path from 'node:path';
import { ethers } from 'ethers';
import { pool, closePool } from '../src/utils/db.js';
import { config } from '../src/config/config.js';

const QM_URL = process.env.QM_URL || 'http://localhost:3000';
const ENTRY_POINT = config.testnetEntryPointAddress;
const PAYMASTER = config.testnetPaymasterAddress;
const WALLET = config.defaultTestnetSmartWalletAddress; // shared across chains
const PATTERN = (process.env.PATTERN || '1,3,7,10').split(',').map((n) => Number(n.trim())).filter((n) => n > 0);
const DEFAULT_TARGET = Number(process.env.TARGET || 1000);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 3000);
const SETTLE_TIMEOUT_MS = Number(process.env.SETTLE_TIMEOUT_MS || 25 * 60 * 1000);
const GUARD_SAFETY = Number(process.env.GUARD_SAFETY || 1.2); // halt if deposit < cost/op * nextBurst * this
// RESUME: count this test's already-submitted userOps per chain (from RUN_START)
// and only submit the remainder, so stopping + relaunching never double-submits.
const RESUME = process.env.RESUME === '1' || process.env.RESUME === 'true';

// Per-chain config (RPC + contract/function), plus per-chain target overrides
// and a seed cost/op (wei) from the calibration run so the abort-guard works
// from the very first burst, before live data accrues.
const noArgs = () => [];
const oneUint = (i) => [i];
const CHAINS = {
  sepolia:     { chainId: 11155111, symbol: 'ETH',  target: 1000, rpc: process.env.SEPOLIA_RPC_URL || 'https://11155111.rpc.thirdweb.com/28eb15303fc228ba1379cfc8dd0181c4', contract: '0x98F811D169F8A87AF29015ac170B709135c5CC07', fn: 'function increment()', args: noArgs, seedCostWei: 1174000000000000n },
  amoy:        { chainId: 80002,    symbol: 'POL',  target: 1000, rpc: process.env.AMOY_RPC_URL || 'https://80002.rpc.thirdweb.com/28eb15303fc228ba1379cfc8dd0181c4', contract: '0xD3601131e5b98fab6326CC795e171252bA2Ae86C', fn: 'function increment()', args: noArgs, seedCostWei: 1084000000000000n },
  opsepolia:   { chainId: 11155420, symbol: 'ETH',  target: 1000, rpc: process.env.OP_SEPOLIA_RPC_URL || 'https://optimism-sepolia-rpc.publicnode.com', contract: '0x3caa944E4638c873b36638965521aBAf0d202bb9', fn: 'function set1(uint256 _x)', args: oneUint, seedCostWei: 1049000000000000n },
  basesepolia: { chainId: 84532,    symbol: 'ETH',  target: 1000, rpc: process.env.BASE_SEPOLIA_RPC_URL || 'https://base-sepolia-rpc.publicnode.com', contract: '0x0cC01096800d5DD37c42598832A3669295aE914C', fn: 'function set1(uint256 _x)', args: oneUint, seedCostWei: 1050000000000000n },
  avaxfuji:    { chainId: 43113,    symbol: 'AVAX', target: 1000, rpc: process.env.FUJI_RPC_URL || 'https://43113.rpc.thirdweb.com/28eb15303fc228ba1379cfc8dd0181c4', contract: '0x98907e0dAf5E358B9569F2C57D8B06Ffad21028F', fn: 'function set1(uint256 _x)', args: oneUint, seedCostWei: 1049000000000000n },
  bnbtestnet:  { chainId: 97,       symbol: 'tBNB', target: 800,  rpc: process.env.BNB_TESTNET_RPC_URL || 'https://bsc-testnet-rpc.publicnode.com', contract: '0x88C93C890C3C4355b7fF506e1ef19bCBaee8aDdF', fn: 'function set1(uint256 _x)', args: oneUint, seedCostWei: 1049000000000000n },
  celosepolia: { chainId: 11142220, symbol: 'CELO', target: 1000, rpc: process.env.CELO_SEPOLIA_RPC_URL || 'https://11142220.rpc.thirdweb.com/28eb15303fc228ba1379cfc8dd0181c4', contract: '0x7a5F2c113c247E8196DD453a7b7C57dbFc20793B', fn: 'function set1(uint256 _x)', args: oneUint, seedCostWei: 3147000000000000n },
};
const ALIASES = { eth: 'sepolia', op: 'opsepolia', base: 'basesepolia', fuji: 'avaxfuji', avax: 'avaxfuji', bnb: 'bnbtestnet', bsc: 'bnbtestnet', celo: 'celosepolia', polygon: 'amoy', matic: 'amoy' };

const EP_ABI = ['function balanceOf(address) view returns (uint256)'];
const IN_FLIGHT = ['queued', 'dispatched', 'sent'];
const TERMINAL = new Set(['success', 'failed', 'execution_failed', 'validation_failed']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (wei) => ethers.formatEther(wei);

const startMs = Date.now();
const startIso = new Date(startMs).toISOString();
// Scope for RESUME counting: the ORIGINAL run start, passed in on relaunch so we
// count the whole test, not just this process. Defaults to now for a fresh run.
const RUN_START = process.env.RUN_START || startIso;
const stamp = startIso.replace(/[:.]/g, '-');
const CSV_PATH = path.resolve(process.env.CSV_PATH || `loadtest-batched-${stamp}.csv`);
const REPORT_PATH = path.resolve(process.env.REPORT_PATH || `loadtest-report-${stamp}.md`);

// One record per submitted userOp.
const records = []; // {chainKey, chainId, intendedSize, burstSeq, queue_id, batch_id, status, latencyS, submittedAt}
const chainState = {}; // chainKey -> {target, depositBefore, depositAfter, halted, haltReason, startMs, endMs, opsSubmitted}
let stopping = false;
let finished = false;

function providerFor(key) {
  return new ethers.JsonRpcProvider(CHAINS[key].rpc, undefined, { staticNetwork: true });
}
async function readDeposit(key) {
  const ep = new ethers.Contract(ENTRY_POINT, EP_ABI, providerFor(key));
  return ep.balanceOf(PAYMASTER);
}

// Cycle PATTERN until target; clamp the final batch to the remainder.
function buildSchedule(target) {
  const sizes = [];
  let sum = 0, i = 0;
  while (sum < target) {
    let n = PATTERN[i % PATTERN.length];
    if (sum + n > target) n = target - sum;
    sizes.push(n);
    sum += n;
    i++;
  }
  return sizes;
}

async function postOne(key, intendedSize, burstSeq, idx) {
  const c = CHAINS[key];
  const rec = { chainKey: key, chainId: c.chainId, intendedSize, burstSeq, queue_id: '', batch_id: '', status: '', latencyS: '', submittedAt: new Date().toISOString() };
  try {
    const res = await fetch(`${QM_URL}/queue/transaction`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ functionSignature: c.fn, args: c.args(idx), contractAddress: c.contract, chainId: c.chainId, smartWallet: '' }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) { rec.queue_id = body.queue_id || ''; rec.status = body.status || ''; }
    else rec.status = 'POST_ERROR';
  } catch { rec.status = 'POST_EXCEPTION'; }
  records.push(rec);
  return rec;
}

async function alreadyDone(chainId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM smart_wallet_transactions
      WHERE smart_wallet_address = $1 AND chain_id = $2 AND created_at >= $3`,
    [WALLET, chainId, RUN_START]
  );
  return rows[0].n;
}

async function walletChainBusy(chainId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM smart_wallet_transactions
      WHERE smart_wallet_address = $1 AND chain_id = $2 AND status = ANY($3)`,
    [WALLET, chainId, IN_FLIGHT]
  );
  return rows[0].n;
}
async function waitWalletChainFree(chainId) {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  for (;;) {
    if (stopping) return;
    if ((await walletChainBusy(chainId)) === 0) return;
    if (Date.now() > deadline) throw new Error('waitWalletChainFree timeout');
    await sleep(POLL_INTERVAL_MS);
  }
}
async function waitTerminal(queueIds) {
  if (queueIds.length === 0) return;
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  for (;;) {
    const { rows } = await pool.query(
      `SELECT queue_id, batch_id, status,
              ROUND(EXTRACT(EPOCH FROM (updated_at - created_at))::numeric, 1) AS lat
         FROM smart_wallet_transactions WHERE queue_id = ANY($1)`, [queueIds]);
    const byId = new Map(rows.map((r) => [r.queue_id, r]));
    for (const rec of records) {
      const row = byId.get(rec.queue_id);
      if (!row) continue;
      rec.status = row.status; rec.batch_id = row.batch_id || '';
      rec.latencyS = TERMINAL.has(row.status) ? Number(row.lat) : '';
    }
    if ((rows.length === queueIds.length && rows.every((r) => TERMINAL.has(r.status))) || stopping) return;
    if (Date.now() > deadline) return;
    await sleep(POLL_INTERVAL_MS);
  }
}

async function runChain(key) {
  const c = CHAINS[key];
  const st = chainState[key] = { target: c.target, depositBefore: 0n, depositAfter: 0n, halted: false, haltReason: '', startMs: Date.now(), endMs: 0, opsSubmitted: 0 };

  // RESUME: submit only the remainder toward the original target.
  let remaining = c.target;
  if (RESUME) {
    const done = await alreadyDone(c.chainId);
    remaining = Math.max(0, c.target - done);
    console.log(`[resume] ${key}: ${done}/${c.target} already submitted -> ${remaining} remaining`);
    if (remaining === 0) { st.endMs = Date.now(); return; }
  }

  try { st.depositBefore = await readDeposit(key); } catch (e) { st.haltReason = `deposit read failed: ${e.shortMessage || e.message}`; }

  const schedule = buildSchedule(remaining);
  let idx = 0, opsDone = 0, costEst = c.seedCostWei;

  for (let seq = 0; seq < schedule.length && !stopping; seq++) {
    const size = schedule[seq];
    // Abort-guard: re-read deposit; refine live cost/op; stop if the next burst
    // can't be funded with margin.
    let deposit;
    try { deposit = await readDeposit(key); } catch { deposit = null; }
    if (deposit != null) {
      if (opsDone > 0 && st.depositBefore > deposit) costEst = (st.depositBefore - deposit) / BigInt(opsDone);
      const needed = (costEst * BigInt(size) * BigInt(Math.round(GUARD_SAFETY * 100))) / 100n;
      if (deposit < needed) { st.halted = true; st.haltReason = `paymaster deposit ${fmt(deposit)} ${c.symbol} < needed ${fmt(needed)} for next burst of ${size}`; break; }
    }

    await waitWalletChainFree(c.chainId);
    if (stopping) break;
    const recs = await Promise.all(Array.from({ length: size }, (_, k) => postOne(key, size, seq, idx + k)));
    idx += size; opsDone += size; st.opsSubmitted = opsDone;
    await waitTerminal(recs.filter((r) => r.queue_id).map((r) => r.queue_id));
  }

  try { st.depositAfter = await readDeposit(key); } catch { st.depositAfter = st.depositBefore; }
  st.endMs = Date.now();
}

// ---- reporting ----
function pctile(sortedAsc, p) {
  if (!sortedAsc.length) return null;
  return sortedAsc[Math.min(sortedAsc.length - 1, Math.floor((p / 100) * sortedAsc.length))];
}
function lat(recs) {
  const a = recs.map((r) => Number(r.latencyS)).filter((n) => !Number.isNaN(n) && n !== 0).sort((x, y) => x - y);
  return { p50: pctile(a, 50), p95: pctile(a, 95), max: a.length ? a[a.length - 1] : null };
}
const f1 = (v) => (v == null ? '-' : v.toFixed(1));

function writeCsv() {
  const header = 'chain,chain_id,intended_size,burst_seq,queue_id,batch_id,final_status,latency_seconds,submitted_at';
  const lines = records.map((r) => [r.chainKey, r.chainId, r.intendedSize, r.burstSeq, r.queue_id, r.batch_id, r.status, r.latencyS, r.submittedAt].join(','));
  fs.writeFileSync(CSV_PATH, [header, ...lines].join('\n') + '\n');
}

function buildReport(reason) {
  const durMin = ((Date.now() - startMs) / 60000).toFixed(1);
  const keys = Object.keys(chainState);
  const L = [];
  L.push(`# Multi-Chain Load Test Report`);
  L.push('');
  L.push(`- **Started:** ${startIso}`);
  L.push(`- **Duration:** ${durMin} min`);
  L.push(`- **Finished because:** ${reason}`);
  L.push(`- **Batch-size pattern:** [${PATTERN.join(', ')}] (cycled to each chain's target)`);
  L.push(`- **Submission:** concurrent burst per batch; dynamic gate between batches (wait for terminal); all chains concurrent`);
  L.push(`- **Paymaster:** ${PAYMASTER} | **EntryPoint:** ${ENTRY_POINT}`);
  L.push(`- **Total userOps submitted:** ${records.length}`);
  L.push('');

  // 1. Per-chain outcome
  L.push(`## 1. Per-chain results`);
  L.push('');
  L.push(`| Chain | Target | Submitted | Success | Failed | Success % | Duration (min) | Outcome |`);
  L.push(`|---|---:|---:|---:|---:|---:|---:|---|`);
  for (const k of keys) {
    const st = chainState[k];
    const recs = records.filter((r) => r.chainKey === k);
    const ok = recs.filter((r) => r.status === 'success').length;
    const failed = recs.filter((r) => r.status && r.status !== 'success' && TERMINAL.has(r.status)).length;
    const rate = recs.length ? ((ok / recs.length) * 100).toFixed(1) : '0';
    const dur = st.endMs ? ((st.endMs - st.startMs) / 60000).toFixed(1) : '-';
    const outcome = st.halted ? `⚠️ HALTED: ${st.haltReason}` : 'completed';
    L.push(`| ${k} | ${st.target} | ${recs.length} | ${ok} | ${failed} | ${rate}% | ${dur} | ${outcome} |`);
  }
  L.push('');

  // 2. Batch-size fidelity (per intended size, across all chains)
  L.push(`## 2. Batch-size fidelity`);
  L.push('');
  L.push(`How many bursts of each intended size formed exactly ONE batch (clean) vs were split by a dispatcher tick.`);
  L.push('');
  L.push(`| Intended size | Bursts | Clean (1 batch) | Split | Clean % |`);
  L.push(`|---:|---:|---:|---:|---:|`);
  const burstMap = new Map(); // key chainKey|seq -> {size, batchIds:Set}
  for (const r of records) {
    if (!r.queue_id) continue;
    const key = `${r.chainKey}|${r.burstSeq}`;
    const b = burstMap.get(key) || { size: r.intendedSize, batchIds: new Set() };
    if (r.batch_id) b.batchIds.add(r.batch_id);
    burstMap.set(key, b);
  }
  for (const size of [...new Set(PATTERN)].sort((a, b) => a - b)) {
    const bs = [...burstMap.values()].filter((b) => b.size === size);
    const clean = bs.filter((b) => b.batchIds.size === 1).length;
    const split = bs.length - clean;
    L.push(`| ${size} | ${bs.length} | ${clean} | ${split} | ${bs.length ? ((clean / bs.length) * 100).toFixed(0) : '0'}% |`);
  }
  L.push('');

  // 3. Latency
  L.push(`## 3. Latency (queued → terminal, seconds)`);
  L.push('');
  L.push(`### By chain`);
  L.push(`| Chain | p50 | p95 | max |`);
  L.push(`|---|---:|---:|---:|`);
  for (const k of keys) {
    const s = lat(records.filter((r) => r.chainKey === k));
    L.push(`| ${k} | ${f1(s.p50)} | ${f1(s.p95)} | ${f1(s.max)} |`);
  }
  L.push('');
  L.push(`### By batch size (all chains)`);
  L.push(`| Size | p50 | p95 | max |`);
  L.push(`|---:|---:|---:|---:|`);
  for (const size of [...new Set(PATTERN)].sort((a, b) => a - b)) {
    const s = lat(records.filter((r) => r.intendedSize === size));
    L.push(`| ${size} | ${f1(s.p50)} | ${f1(s.p95)} | ${f1(s.max)} |`);
  }
  L.push('');

  // 4. Paymaster economics
  L.push(`## 4. Paymaster economics`);
  L.push('');
  L.push(`| Chain | Deposit before | Deposit after | Spent | Cost/op (measured) | Remaining |`);
  L.push(`|---|---:|---:|---:|---:|---:|`);
  for (const k of keys) {
    const st = chainState[k];
    const ok = records.filter((r) => r.chainKey === k && r.status === 'success').length;
    const spent = st.depositBefore - st.depositAfter;
    const perOp = ok > 0 ? spent / BigInt(ok) : 0n;
    const sym = CHAINS[k].symbol;
    L.push(`| ${k} | ${Number(fmt(st.depositBefore)).toFixed(4)} ${sym} | ${Number(fmt(st.depositAfter)).toFixed(4)} ${sym} | ${Number(fmt(spent)).toFixed(4)} ${sym} | ${ok ? Number(fmt(perOp)).toFixed(6) : '-'} ${sym} | ${Number(fmt(st.depositAfter)).toFixed(4)} ${sym} |`);
  }
  L.push('');

  // 5. Throughput
  const totalOk = records.filter((r) => r.status === 'success').length;
  L.push(`## 5. Throughput`);
  L.push('');
  L.push(`- Total userOps submitted: **${records.length}**, succeeded: **${totalOk}** (${records.length ? ((totalOk / records.length) * 100).toFixed(1) : 0}%)`);
  L.push(`- Wall-clock: **${durMin} min** → overall **${(records.length / Math.max(1, (Date.now() - startMs) / 60000)).toFixed(1)} userOps/min** (7 chains in parallel)`);
  L.push('');
  L.push(`Raw per-userOp data: \`${path.basename(CSV_PATH)}\``);
  return L.join('\n') + '\n';
}

async function finish(reason) {
  if (finished) return;
  finished = true; stopping = true;
  console.log(`\nFinishing (${reason})...`);
  writeCsv();
  fs.writeFileSync(REPORT_PATH, buildReport(reason));
  console.log(`CSV:    ${CSV_PATH}`);
  console.log(`Report: ${REPORT_PATH}`);
  await closePool().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', () => finish('interrupted (SIGINT)'));
process.on('SIGTERM', () => finish('interrupted (SIGTERM)'));

function resolveKeys(arg) {
  if (!arg) return Object.keys(CHAINS);
  return arg.split(',').map((s) => s.trim().toLowerCase()).map((s) => (CHAINS[s] ? s : ALIASES[s])).filter(Boolean);
}

(async () => {
  const keys = resolveKeys(process.argv[2]);
  // Apply TARGET override (keeps BNB's 800 default unless TARGET is explicitly set).
  if (process.env.TARGET) for (const k of keys) CHAINS[k].target = DEFAULT_TARGET;

  console.log(`Multi-chain load test → ${QM_URL}`);
  console.log(`  chains: ${keys.map((k) => `${k}(${CHAINS[k].target})`).join(', ')}`);
  console.log(`  pattern [${PATTERN.join(',')}] | CSV ${path.basename(CSV_PATH)} | report ${path.basename(REPORT_PATH)}`);

  try {
    const h = await fetch(`${QM_URL}/health`);
    if (!h.ok) throw new Error(`/health -> ${h.status}`);
  } catch (e) {
    console.error(`Queue Manager not reachable: ${e.message}`);
    await closePool().catch(() => {});
    process.exit(1);
  }

  // All chains concurrently; each runs its own gated burst loop.
  await Promise.all(keys.map((k) => runChain(k).catch((e) => { (chainState[k] ||= {}).haltReason = e.message; })));
  await finish('all chains reached target or guard');
})();
