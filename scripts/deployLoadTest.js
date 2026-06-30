// Deploy load test — controlled batch sizes, with a full stats + funds report.
//
// Drives each chain to a target number of contract DEPLOYS (default 200),
// forming batches cycled through [1,3,5,8]. Same gated-burst strategy as the
// call load test: wait until the (wallet,chain) is free -> submit N deploys as a
// concurrent burst -> wait for all to reach terminal -> next. Reads the contract
// payload from scripts/deploy-payload.json (unique traceId per deploy).
//
// Measures funds burnt (paymaster deposit before/after, on-chain) and writes a
// Markdown report + per-deploy CSV into loadtesting/.
//
//   node scripts/deployLoadTest.js                 # amoy,sepolia x200, [1,3,5,8]
//   node scripts/deployLoadTest.js sepolia 50
//   PATTERN=1,3 TARGET=20 node scripts/deployLoadTest.js amoy

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { ethers } from 'ethers';
import { pool, closePool } from '../src/utils/db.js';
import { config } from '../src/config/config.js';

const QM_URL = process.env.QM_URL || 'http://localhost:3000';
const ENTRY_POINT = config.testnetEntryPointAddress;
const PAYMASTER = config.testnetPaymasterAddress;
const WALLET = config.defaultTestnetSmartWalletAddress;
const PATTERN = (process.env.PATTERN || '1,3,5,8').split(',').map((n) => Number(n.trim())).filter((n) => n > 0);
const DEFAULT_TARGET = Number(process.env.TARGET || 200);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 3000);
const SETTLE_TIMEOUT_MS = Number(process.env.SETTLE_TIMEOUT_MS || 25 * 60 * 1000);

const here = path.dirname(fileURLToPath(import.meta.url));
const payload = JSON.parse(fs.readFileSync(path.join(here, 'deploy-payload.json'), 'utf8'));
const OUT_DIR = path.join(here, '..', 'loadtesting');

const CHAINS = {
  amoy: { chainId: 80002, symbol: 'POL', rpc: process.env.AMOY_RPC_URL || 'https://80002.rpc.thirdweb.com/28eb15303fc228ba1379cfc8dd0181c4' },
  sepolia: { chainId: 11155111, symbol: 'ETH', rpc: process.env.SEPOLIA_RPC_URL || 'https://11155111.rpc.thirdweb.com/28eb15303fc228ba1379cfc8dd0181c4' },
};
const ALIASES = { eth: 'sepolia', polygon: 'amoy', matic: 'amoy' };
const EP_ABI = ['function balanceOf(address) view returns (uint256)'];
const TERMINAL = new Set(['success', 'failed', 'execution_failed', 'validation_failed']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (wei) => ethers.formatEther(wei);

const startMs = Date.now();
const startIso = new Date(startMs).toISOString();
const stamp = startIso.replace(/[:.]/g, '-');
const CSV_PATH = path.join(OUT_DIR, `deploy-loadtest-${stamp}.csv`);
const REPORT_PATH = path.join(OUT_DIR, `deploy-loadtest-report-${stamp}.md`);

const records = []; // {chainKey, chainId, intendedSize, burstSeq, traceId, queue_id, batch_id, status, deployed_address, tx_hash, latencyS}
const chainState = {};
let stopping = false;
let finished = false;

function providerFor(key) { return new ethers.JsonRpcProvider(CHAINS[key].rpc, undefined, { staticNetwork: true }); }
async function readDeposit(key) {
  try { return await new ethers.Contract(ENTRY_POINT, EP_ABI, providerFor(key)).balanceOf(PAYMASTER); }
  catch { return null; }
}

function buildSchedule(target) {
  const sizes = []; let sum = 0, i = 0;
  while (sum < target) { let n = PATTERN[i % PATTERN.length]; if (sum + n > target) n = target - sum; sizes.push(n); sum += n; i++; }
  return sizes;
}

async function postDeploy(key, intendedSize, burstSeq) {
  const c = CHAINS[key];
  const traceId = randomUUID();
  const rec = { chainKey: key, chainId: c.chainId, intendedSize, burstSeq, traceId, queue_id: '', batch_id: '', status: '', deployed_address: '', tx_hash: '', latencyS: '', submittedAt: new Date().toISOString() };
  try {
    const res = await fetch(`${QM_URL}/queue/deploy`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ abiEncoded: payload.abiEncoded, bytecode: payload.bytecode, constructorArgs: payload.constructorArgs, chainId: c.chainId, traceId, smartWallet: '' }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) { rec.queue_id = body.queue_id || ''; rec.status = body.status || ''; }
    else rec.status = 'POST_ERROR';
  } catch { rec.status = 'POST_EXCEPTION'; }
  records.push(rec);
  return rec;
}

async function walletChainBusy(chainId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int n FROM smart_wallet_transactions WHERE smart_wallet_address=$1 AND chain_id=$2 AND status = ANY($3)`,
    [WALLET, chainId, ['queued', 'dispatched', 'sent']]);
  return rows[0].n;
}
async function waitWalletChainFree(chainId) {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  for (;;) { if (stopping) return; if ((await walletChainBusy(chainId)) === 0) return; if (Date.now() > deadline) throw new Error('free-timeout'); await sleep(POLL_INTERVAL_MS); }
}
async function waitTerminal(queueIds) {
  if (queueIds.length === 0) return;
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  for (;;) {
    const { rows } = await pool.query(
      `SELECT t.queue_id, t.batch_id, t.status, t.transaction_hash,
              ROUND(EXTRACT(EPOCH FROM (t.updated_at - t.created_at))::numeric,1) AS lat, d.deployed_address
         FROM smart_wallet_transactions t LEFT JOIN smart_wallet_deployments d ON d.tx_id=t.id
        WHERE t.queue_id = ANY($1)`, [queueIds]);
    const byId = new Map(rows.map((r) => [r.queue_id, r]));
    for (const rec of records) {
      const r = byId.get(rec.queue_id); if (!r) continue;
      rec.status = r.status; rec.batch_id = r.batch_id || ''; rec.tx_hash = r.transaction_hash || '';
      rec.deployed_address = r.deployed_address || ''; rec.latencyS = TERMINAL.has(r.status) ? Number(r.lat) : '';
    }
    if ((rows.length === queueIds.length && rows.every((r) => TERMINAL.has(r.status))) || stopping) return;
    if (Date.now() > deadline) return;
    await sleep(POLL_INTERVAL_MS);
  }
}

async function runChain(key) {
  const c = CHAINS[key];
  const st = chainState[key] = { target: c.target, depositBefore: 0n, depositAfter: 0n, startMs: Date.now(), endMs: 0 };
  st.depositBefore = (await readDeposit(key)) ?? 0n;
  const schedule = buildSchedule(c.target);
  for (let seq = 0; seq < schedule.length && !stopping; seq++) {
    const size = schedule[seq];
    await waitWalletChainFree(c.chainId);
    if (stopping) break;
    const recs = await Promise.all(Array.from({ length: size }, () => postDeploy(key, size, seq)));
    const ids = recs.filter((r) => r.queue_id).map((r) => r.queue_id);
    await waitTerminal(ids);
    const done = records.filter((r) => r.chainKey === key && TERMINAL.has(r.status)).length;
    console.log(`[${key}] batch ${seq + 1}/${schedule.length} size ${size} -> ${done}/${c.target} terminal`);
  }
  st.depositAfter = (await readDeposit(key)) ?? st.depositBefore;
  st.endMs = Date.now();
}

// Decode one on-chain FailedOp reason (for the failure section).
async function decodeRevert(key, hash) {
  try {
    const prov = providerFor(key);
    const tx = await prov.getTransaction(hash); if (!tx) return 'tx-not-found';
    const rc = await prov.getTransactionReceipt(hash);
    try { await prov.call({ to: tx.to, from: tx.from, data: tx.data, value: tx.value, gasLimit: tx.gasLimit }, rc ? rc.blockNumber : 'latest'); return 'no-revert'; }
    catch (e) { const d = e.data || e.info?.error?.data; if (d && (''+d).includes('0x')) { const hex = (''+d).slice((''+d).indexOf('0x')); try { const dec = ethers.AbiCoder.defaultAbiCoder().decode(['uint256', 'string'], '0x' + hex.slice(10)); return `FailedOp(${dec[0]},"${dec[1]}")`; } catch { return 'raw ' + hex.slice(0, 40); } } return (e.shortMessage || e.message || '').slice(0, 80); }
  } catch (e) { return 'decode-err: ' + (e.message || '').slice(0, 60); }
}

const pctile = (a, p) => (a.length ? a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))] : null);
const f1 = (v) => (v == null ? '-' : v.toFixed(1));
function lat(recs) { const a = recs.map((r) => Number(r.latencyS)).filter((n) => !Number.isNaN(n) && n !== 0).sort((x, y) => x - y); return { p50: pctile(a, 50), p95: pctile(a, 95), max: a.length ? a[a.length - 1] : null }; }

function writeCsv() {
  const header = 'chain,chain_id,intended_size,burst_seq,trace_id,queue_id,batch_id,final_status,deployed_address,tx_hash,latency_seconds,submitted_at';
  const lines = records.map((r) => [r.chainKey, r.chainId, r.intendedSize, r.burstSeq, r.traceId, r.queue_id, r.batch_id, r.status, r.deployed_address, r.tx_hash, r.latencyS, r.submittedAt].join(','));
  fs.writeFileSync(CSV_PATH, [header, ...lines].join('\n') + '\n');
}

async function buildReport(reason) {
  const keys = Object.keys(chainState);
  const durMin = ((Date.now() - startMs) / 60000).toFixed(1);
  const L = [];
  L.push(`# Deploy Load Test Report`);
  L.push('');
  L.push(`- **Started:** ${startIso} | **Duration:** ${durMin} min | **Finished:** ${reason}`);
  L.push(`- **Flow:** contract deploy via \`/queue/deploy\` (universal deployer)`);
  L.push(`- **Batch sizes:** [${PATTERN.join(', ')}] cycled to target | **Target:** ${DEFAULT_TARGET} deploys/chain`);
  L.push(`- **Paymaster:** ${PAYMASTER} | **EntryPoint:** ${ENTRY_POINT}`);
  L.push(`- **Total deploys submitted:** ${records.length}`);
  L.push('');

  // 1. Per-chain results
  L.push(`## 1. Per-chain results`);
  L.push('');
  L.push(`| Chain | Target | Submitted | Success | Failed | Deployed (addr resolved) | Success % |`);
  L.push(`|---|---:|---:|---:|---:|---:|---:|`);
  for (const k of keys) {
    const rs = records.filter((r) => r.chainKey === k);
    const ok = rs.filter((r) => r.status === 'success').length;
    const failed = rs.filter((r) => TERMINAL.has(r.status) && r.status !== 'success').length;
    const deployed = rs.filter((r) => r.deployed_address).length;
    L.push(`| ${k} | ${chainState[k].target} | ${rs.length} | ${ok} | ${failed} | ${deployed} | ${rs.length ? ((ok / rs.length) * 100).toFixed(1) : 0}% |`);
  }
  L.push('');

  // 2. Funds burnt
  L.push(`## 2. Funds burnt (paymaster deposit)`);
  L.push('');
  L.push(`Deposit read on-chain (EntryPoint.balanceOf) before and after the run.`);
  L.push('');
  L.push(`| Chain | Deposit before | Deposit after | Burnt | Cost/deploy (success) |`);
  L.push(`|---|---:|---:|---:|---:|`);
  for (const k of keys) {
    const st = chainState[k]; const sym = CHAINS[k].symbol;
    const ok = records.filter((r) => r.chainKey === k && r.status === 'success').length;
    const burnt = st.depositBefore - st.depositAfter;
    const perOp = ok > 0 ? burnt / BigInt(ok) : 0n;
    L.push(`| ${k} | ${Number(fmt(st.depositBefore)).toFixed(5)} ${sym} | ${Number(fmt(st.depositAfter)).toFixed(5)} ${sym} | ${Number(fmt(burnt)).toFixed(5)} ${sym} | ${ok ? Number(fmt(perOp)).toFixed(6) : '-'} ${sym} |`);
  }
  L.push('');
  L.push(`> Note: deposit is shared across the paymaster; if other traffic hit it during the run, "burnt" is an upper bound for this test.`);
  L.push('');

  // 3. Batch-size fidelity
  L.push(`## 3. Batch-size fidelity`);
  L.push('');
  const bmap = new Map();
  for (const r of records) { if (!r.queue_id) continue; const key = `${r.chainKey}|${r.burstSeq}`; const b = bmap.get(key) || { size: r.intendedSize, ids: new Set() }; if (r.batch_id) b.ids.add(r.batch_id); bmap.set(key, b); }
  L.push(`| Intended size | Bursts | Clean (1 batch) | Split |`);
  L.push(`|---:|---:|---:|---:|`);
  for (const size of [...new Set(PATTERN)].sort((a, b) => a - b)) {
    const bs = [...bmap.values()].filter((b) => b.size === size);
    const clean = bs.filter((b) => b.ids.size === 1).length;
    L.push(`| ${size} | ${bs.length} | ${clean} | ${bs.length - clean} |`);
  }
  L.push('');

  // 4. Latency
  L.push(`## 4. Latency (queued -> terminal, seconds)`);
  L.push('');
  L.push(`| Chain | p50 | p95 | max |`);
  L.push(`|---|---:|---:|---:|`);
  for (const k of keys) { const s = lat(records.filter((r) => r.chainKey === k)); L.push(`| ${k} | ${f1(s.p50)} | ${f1(s.p95)} | ${f1(s.max)} |`); }
  L.push('');
  L.push(`By batch size (all chains):`);
  L.push('');
  L.push(`| Size | p50 | p95 | max |`);
  L.push(`|---:|---:|---:|---:|`);
  for (const size of [...new Set(PATTERN)].sort((a, b) => a - b)) { const s = lat(records.filter((r) => r.intendedSize === size)); L.push(`| ${size} | ${f1(s.p50)} | ${f1(s.p95)} | ${f1(s.max)} |`); }
  L.push('');

  // 5. Failures (decode on-chain reason)
  const failed = records.filter((r) => TERMINAL.has(r.status) && r.status !== 'success');
  L.push(`## 5. Failures`);
  L.push('');
  if (failed.length === 0) { L.push(`No failed deploys. 🎉`); }
  else {
    L.push(`${failed.length} deploys failed. On-chain revert reason (sampled per chain):`);
    L.push('');
    for (const k of keys) {
      const fr = failed.filter((r) => r.chainKey === k && r.tx_hash);
      if (fr.length === 0) continue;
      const reason = await decodeRevert(k, fr[0].tx_hash);
      const sizes = [...new Set(fr.map((r) => r.intendedSize))].sort((a, b) => a - b);
      L.push(`- **${k}**: ${fr.length} failed (batch sizes ${sizes.join(', ')}) — reason: \`${reason}\``);
    }
  }
  L.push('');

  // 6. Throughput + sample addresses
  const totalOk = records.filter((r) => r.status === 'success').length;
  const addrs = records.filter((r) => r.deployed_address).map((r) => r.deployed_address);
  L.push(`## 6. Throughput & deployed contracts`);
  L.push('');
  L.push(`- ${records.length} deploys, ${totalOk} success (${records.length ? ((totalOk / records.length) * 100).toFixed(1) : 0}%) in ${durMin} min`);
  L.push(`- Throughput: ${(records.length / Math.max(1, (Date.now() - startMs) / 60000)).toFixed(1)} deploys/min`);
  L.push(`- Distinct contracts deployed: ${new Set(addrs).size}`);
  L.push(`- Sample addresses: ${[...new Set(addrs)].slice(0, 5).join(', ') || '(none)'}`);
  L.push('');
  L.push(`Raw per-deploy data: \`${path.basename(CSV_PATH)}\``);
  return L.join('\n') + '\n';
}

async function finish(reason) {
  if (finished) return; finished = true; stopping = true;
  console.log(`\nFinishing (${reason})...`);
  writeCsv();
  const report = await buildReport(reason);
  fs.writeFileSync(REPORT_PATH, report);
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
  const target = Number(process.argv[3] || DEFAULT_TARGET);
  for (const k of keys) CHAINS[k].target = target;

  console.log(`Deploy load test -> ${QM_URL}`);
  console.log(`  chains: ${keys.map((k) => `${k}(${CHAINS[k].target})`).join(', ')} | pattern [${PATTERN.join(',')}]`);
  console.log(`  CSV ${path.basename(CSV_PATH)} | report ${path.basename(REPORT_PATH)}`);

  try { const h = await fetch(`${QM_URL}/health`); if (!h.ok) throw new Error(`/health -> ${h.status}`); }
  catch (e) { console.error(`QM not reachable: ${e.message}`); await closePool().catch(() => {}); process.exit(1); }

  await Promise.all(keys.map((k) => runChain(k).catch((e) => console.error(`${k} error:`, e.message))));
  await finish('all chains reached target');
})();
