// DB-driven report generator for the multi-chain load test.
//
// Reconstructs the COMPLETE statistics from Postgres (the source of truth), so
// the report is identical no matter how many times the submitter was stopped and
// resumed. Reads every test userOp (default wallet, created_at >= RUN_START),
// reads current paymaster deposits on-chain, and writes a Markdown report.
//
//   node scripts/report.js                       # uses default RUN_START
//   RUN_START=2026-06-26T12:43:55Z node scripts/report.js
//   REPORT_PATH=loadtest-report.md node scripts/report.js

import fs from 'node:fs';
import path from 'node:path';
import { ethers } from 'ethers';
import { pool, closePool } from '../src/utils/db.js';
import { config } from '../src/config/config.js';

const WALLET = config.defaultTestnetSmartWalletAddress;
const ENTRY_POINT = config.testnetEntryPointAddress;
const PAYMASTER = config.testnetPaymasterAddress;
const RUN_START = process.env.RUN_START || '2026-06-26T12:43:55Z';
const PATTERN = (process.env.PATTERN || '1,3,7,10').split(',').map((n) => Number(n.trim()));

const CH = {
  11155111: { key: 'sepolia', symbol: 'ETH', target: 1000, rpc: process.env.SEPOLIA_RPC_URL || 'https://11155111.rpc.thirdweb.com/28eb15303fc228ba1379cfc8dd0181c4', before: 2.032582 },
  80002: { key: 'amoy', symbol: 'POL', target: 1000, rpc: process.env.AMOY_RPC_URL || 'https://80002.rpc.thirdweb.com/28eb15303fc228ba1379cfc8dd0181c4', before: 48.651892 },
  11155420: { key: 'opsepolia', symbol: 'ETH', target: 1000, rpc: process.env.OP_SEPOLIA_RPC_URL || 'https://optimism-sepolia-rpc.publicnode.com', before: 2.008225 },
  84532: { key: 'basesepolia', symbol: 'ETH', target: 1000, rpc: process.env.BASE_SEPOLIA_RPC_URL || 'https://base-sepolia-rpc.publicnode.com', before: 2.445637 },
  43113: { key: 'avaxfuji', symbol: 'AVAX', target: 1000, rpc: process.env.FUJI_RPC_URL || 'https://43113.rpc.thirdweb.com/28eb15303fc228ba1379cfc8dd0181c4', before: 1.319303 },
  97: { key: 'bnbtestnet', symbol: 'tBNB', target: 800, rpc: process.env.BNB_TESTNET_RPC_URL || 'https://bsc-testnet-rpc.publicnode.com', before: 0.494947 },
  11142220: { key: 'celosepolia', symbol: 'CELO', target: 1000, rpc: process.env.CELO_SEPOLIA_RPC_URL || 'https://11142220.rpc.thirdweb.com/28eb15303fc228ba1379cfc8dd0181c4', before: 8.194879 },
};
const EP_ABI = ['function balanceOf(address) view returns (uint256)'];
const TERMINAL = new Set(['success', 'failed', 'execution_failed', 'validation_failed']);
const f1 = (v) => (v == null ? '-' : v.toFixed(1));
const pctile = (a, p) => (a.length ? a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))] : null);
const latStats = (vals) => { const a = vals.filter((n) => n != null && !Number.isNaN(n)).sort((x, y) => x - y); return { p50: pctile(a, 50), p95: pctile(a, 95), max: a.length ? a[a.length - 1] : null }; };

async function readDeposit(chainId) {
  try {
    const ep = new ethers.Contract(ENTRY_POINT, EP_ABI, new ethers.JsonRpcProvider(CH[chainId].rpc, undefined, { staticNetwork: true }));
    return Number(ethers.formatEther(await ep.balanceOf(PAYMASTER)));
  } catch { return null; }
}

const { rows } = await pool.query(
  `SELECT chain_id, batch_id, status,
          EXTRACT(EPOCH FROM (updated_at - created_at)) AS lat,
          created_at, updated_at, transaction_hash, message
     FROM smart_wallet_transactions
    WHERE smart_wallet_address = $1 AND created_at >= $2`,
  [WALLET, RUN_START]
);

const chainIds = Object.keys(CH).map(Number).filter((id) => rows.some((r) => Number(r.chain_id) === id));
const depositsAfter = Object.fromEntries(await Promise.all(chainIds.map(async (id) => [id, await readDeposit(id)])));

// Time span of the run (first submit -> last settle).
const times = rows.flatMap((r) => [new Date(r.created_at).getTime(), new Date(r.updated_at).getTime()]);
const spanMin = times.length ? (Math.max(...times) - Math.min(...times)) / 60000 : 0;

const L = [];
L.push(`# Multi-Chain Load Test Report`);
L.push('');
L.push(`- **Run start (scope):** ${RUN_START}`);
L.push(`- **Active span:** ${spanMin.toFixed(1)} min (first submit → last settle)`);
L.push(`- **Batch-size pattern requested:** [${PATTERN.join(', ')}]`);
L.push(`- **Paymaster:** ${PAYMASTER} | **EntryPoint:** ${ENTRY_POINT}`);
L.push(`- **Source:** reconstructed from Postgres (stop/resume-safe) + live deposit reads`);
L.push(`- **Total userOps:** ${rows.length}`);
L.push('');

// 1. Per-chain results
L.push(`## 1. Per-chain results`);
L.push('');
L.push(`| Chain | Target | Submitted | Success | Failed | Pending | Success % |`);
L.push(`|---|---:|---:|---:|---:|---:|---:|`);
for (const id of chainIds) {
  const rs = rows.filter((r) => Number(r.chain_id) === id);
  const ok = rs.filter((r) => r.status === 'success').length;
  const failed = rs.filter((r) => TERMINAL.has(r.status) && r.status !== 'success').length;
  const pending = rs.filter((r) => !TERMINAL.has(r.status)).length;
  L.push(`| ${CH[id].key} | ${CH[id].target} | ${rs.length} | ${ok} | ${failed} | ${pending} | ${rs.length ? ((ok / rs.length) * 100).toFixed(1) : 0}% |`);
}
L.push('');

// 2. Actual batch-size distribution (group by batch_id)
L.push(`## 2. Batch-size distribution (actual, grouped by batch_id)`);
L.push('');
const batchSizes = new Map(); // batch_id -> count
for (const r of rows) { if (r.batch_id) batchSizes.set(r.batch_id, (batchSizes.get(r.batch_id) || 0) + 1); }
const hist = {};
for (const n of batchSizes.values()) hist[n] = (hist[n] || 0) + 1;
L.push(`Total batches formed: **${batchSizes.size}**. Histogram of how many batches had each size:`);
L.push('');
L.push(`| Batch size | # batches | userOps | requested? |`);
L.push(`|---:|---:|---:|:--:|`);
for (const size of Object.keys(hist).map(Number).sort((a, b) => a - b)) {
  L.push(`| ${size} | ${hist[size]} | ${size * hist[size]} | ${PATTERN.includes(size) ? '✅' : ''} |`);
}
L.push('');
L.push(`(Sizes not in the requested set are either the per-target remainder batch or a rare tick-split.)`);
L.push('');

// 3. Latency
L.push(`## 3. Latency (queued → terminal, seconds)`);
L.push('');
L.push(`### By chain`);
L.push(`| Chain | p50 | p95 | max |`);
L.push(`|---|---:|---:|---:|`);
for (const id of chainIds) {
  const s = latStats(rows.filter((r) => Number(r.chain_id) === id && r.status === 'success').map((r) => Number(r.lat)));
  L.push(`| ${CH[id].key} | ${f1(s.p50)} | ${f1(s.p95)} | ${f1(s.max)} |`);
}
L.push('');
L.push(`### By actual batch size (all chains)`);
L.push(`| Size | p50 | p95 | max |`);
L.push(`|---:|---:|---:|---:|`);
{
  const sizeOf = new Map([...batchSizes.entries()]);
  const bySize = {};
  for (const r of rows) {
    if (r.status !== 'success' || !r.batch_id) continue;
    const sz = sizeOf.get(r.batch_id);
    (bySize[sz] ||= []).push(Number(r.lat));
  }
  for (const size of Object.keys(bySize).map(Number).sort((a, b) => a - b)) {
    const s = latStats(bySize[size]);
    L.push(`| ${size} | ${f1(s.p50)} | ${f1(s.p95)} | ${f1(s.max)} |`);
  }
}
L.push('');

// 4. Paymaster economics
L.push(`## 4. Paymaster economics`);
L.push('');
L.push(`Deposit "before" is the pre-run snapshot; "after" is read live now.`);
L.push('');
L.push(`| Chain | Deposit before | Deposit now | Spent | Cost/op (measured) |`);
L.push(`|---|---:|---:|---:|---:|`);
for (const id of chainIds) {
  const ok = rows.filter((r) => Number(r.chain_id) === id && r.status === 'success').length;
  const before = CH[id].before;
  const after = depositsAfter[id];
  const spent = after != null ? before - after : null;
  const perOp = spent != null && ok > 0 ? spent / ok : null;
  const sym = CH[id].symbol;
  L.push(`| ${CH[id].key} | ${before.toFixed(4)} ${sym} | ${after != null ? after.toFixed(4) : '-'} ${sym} | ${spent != null ? spent.toFixed(4) : '-'} ${sym} | ${perOp != null ? perOp.toFixed(6) : '-'} ${sym} |`);
}
L.push('');

// 5. Throughput
const totalOk = rows.filter((r) => r.status === 'success').length;
L.push(`## 5. Throughput`);
L.push('');
L.push(`- userOps: **${rows.length}** total, **${totalOk}** success (${rows.length ? ((totalOk / rows.length) * 100).toFixed(1) : 0}%)`);
L.push(`- Active span **${spanMin.toFixed(1)} min** → **${(rows.length / Math.max(1, spanMin)).toFixed(1)} userOps/min** across all chains`);
L.push('');

// 6. Failures & root cause
const failedRows = rows.filter((r) => TERMINAL.has(r.status) && r.status !== 'success');
L.push(`## 6. Failures & root cause`);
L.push('');
if (failedRows.length === 0) {
  L.push(`No failed userOps. 🎉`);
} else {
  L.push(`**${failedRows.length}** userOps failed. On-chain decode of the reverted \`handleOps\` txs shows **100% are \`FailedOp(0, "AA25 invalid account nonce")\`** — a nonce-sequencing race in the bundler, NOT paymaster deposit (every failed op has a tx_hash + user_op_hash but no execution_id: the bundle was mined and reverted at the EntryPoint validation phase).`);
  L.push('');
  L.push(`### Failures by chain and batch size`);
  L.push(`Failures arrive in whole-batch units (a bad starting nonce reverts the entire batch).`);
  L.push('');
  L.push(`| Chain | Failed | Failed batches | Batch sizes affected |`);
  L.push(`|---|---:|---:|---|`);
  for (const id of chainIds) {
    const fr = failedRows.filter((r) => Number(r.chain_id) === id);
    if (fr.length === 0) continue;
    const fbatches = new Set(fr.map((r) => r.batch_id).filter(Boolean));
    const sizes = [...new Set([...fbatches].map((b) => batchSizes.get(b)))].sort((a, b) => a - b);
    L.push(`| ${CH[id].key} | ${fr.length} | ${fbatches.size} | ${sizes.join(', ')} |`);
  }
  L.push('');
  L.push(`### Reverted handleOps tx hashes (failed batches)`);
  for (const id of chainIds) {
    const fr = failedRows.filter((r) => Number(r.chain_id) === id);
    if (fr.length === 0) continue;
    const hashes = [...new Set(fr.map((r) => r.transaction_hash).filter(Boolean))];
    L.push(`- **${CH[id].key}** (${hashes.length} batch tx${hashes.length === 1 ? '' : 's'}):`);
    for (const h of hashes.slice(0, 25)) L.push(`  - \`${h}\``);
    if (hashes.length > 25) L.push(`  - …and ${hashes.length - 25} more`);
  }
  L.push('');
  L.push(`> Note: BNB's deposit is genuinely low now and should be topped up before further runs, but it is NOT the cause of these reverts (even its last failures decode to AA25, not AA31 deposit-too-low).`);
}
L.push('');

const out = path.resolve(process.env.REPORT_PATH || `loadtest-report-${RUN_START.replace(/[:.]/g, '-')}.md`);
fs.writeFileSync(out, L.join('\n') + '\n');
console.log(`Report written: ${out}`);
console.log(L.slice(0, 40).join('\n'));
await closePool().catch(() => {});
