// Load test: send N transactions per chain, one every INTERVAL_MS, calling the
// per-chain target function on the per-chain contract via the default smart
// wallet, then track each to a terminal status and write a CSV record.
//
// Pure client + read-only observer (never runs a dispatcher).
// Run the QM (pointed at the real Bundler) first, then:
//   node scripts/loadTest.js <chain> [count]      # e.g. avax 50
//   node scripts/loadTest.js avax,celo 50         # multiple chains in parallel
//   node scripts/loadTest.js                       # falls back to CHAINS/COUNT env
//   pm2 start ecosystem.loadtest.cjs               # under pm2 (uses env, unchanged)
//
// <chain> is a preset name (amoy, sepolia, avax, baseSepolia, bnbTestnet,
// opSepolia, celo), an alias (base, op, bnb, fuji, eth, ...), or a numeric
// chainId. Each preset knows its contract + function signature + args shape, so
// increment() chains send no args and set1(uint256) chains send one.
// Ctrl-C / `pm2 stop` writes the CSV with whatever statuses are known so far.

import fs from 'node:fs';
import path from 'node:path';
import { pool, closePool } from '../src/utils/db.js';
import { chainInfo } from '../src/config/chainInfo.js';

const QM_URL = process.env.QM_URL || 'http://localhost:3000';
const INTERVAL_MS = Number(process.env.INTERVAL_MS || 5); // default per-chain spacing
const SMART_WALLET = process.env.SMART_WALLET ?? ''; // '' => chain default
const DRAIN_TIMEOUT_MS = Number(process.env.DRAIN_TIMEOUT_MS || 30 * 60 * 1000);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 10_000);

// --- Per-chain presets -----------------------------------------------------
// Each chain knows its target contract, the function to call, and the args that
// function takes. Amoy/Sepolia call increment() (no args); the others call
// set1(uint256 _x), which needs one uint — we pass the submission index so each
// txn carries a distinct value. Override per chain with CONTRACT_<chainId> /
// FUNCTION_SIGNATURE_<chainId>.
const noArgs = () => [];
const oneUint = (i) => [i];
const CHAIN_PRESETS = {
  amoy: { chainId: 80002, contract: '0xD3601131e5b98fab6326CC795e171252bA2Ae86C', functionSignature: 'function increment()', argsFor: noArgs },
  sepolia: { chainId: 11155111, contract: '0x98F811D169F8A87AF29015ac170B709135c5CC07', functionSignature: 'function increment()', argsFor: noArgs },
  avax: { chainId: 43113, contract: '0x98907e0dAf5E358B9569F2C57D8B06Ffad21028F', functionSignature: 'function set1(uint256 _x)', argsFor: oneUint },
  baseSepolia: { chainId: 84532, contract: '0x0cC01096800d5DD37c42598832A3669295aE914C', functionSignature: 'function set1(uint256 _x)', argsFor: oneUint },
  bnbTestnet: { chainId: 97, contract: '0x88C93C890C3C4355b7fF506e1ef19bCBaee8aDdF', functionSignature: 'function set1(uint256 _x)', argsFor: oneUint },
  opSepolia: { chainId: 11155420, contract: '0x3caa944E4638c873b36638965521aBAf0d202bb9', functionSignature: 'function set1(uint256 _x)', argsFor: oneUint },
  celo: { chainId: 11142220, contract: '0x7a5F2c113c247E8196DD453a7b7C57dbFc20793B', functionSignature: 'function set1(uint256 _x)', argsFor: oneUint },
};

// Friendly aliases (case-insensitive) -> canonical preset name.
const ALIASES = {
  matic: 'amoy', polygon: 'amoy',
  eth: 'sepolia', ethsepolia: 'sepolia',
  fuji: 'avax', avalanche: 'avax',
  base: 'baseSepolia',
  bnb: 'bnbTestnet', bsc: 'bnbTestnet',
  op: 'opSepolia', optimism: 'opSepolia',
};
const byChainId = new Map(Object.values(CHAIN_PRESETS).map((p) => [p.chainId, p]));

// Resolve one CLI/env token (preset name, alias, or numeric chainId) to a
// preset, or null if it's an unknown name. Unknown numeric ids resolve to a
// bare config so CONTRACT_<id> / FUNCTION_SIGNATURE env can still drive them.
function resolveChain(token) {
  const t = String(token).trim();
  if (/^\d+$/.test(t)) {
    const id = Number(t);
    return byChainId.get(id) || { chainId: id, contract: undefined, functionSignature: undefined, argsFor: noArgs };
  }
  const key = ALIASES[t.toLowerCase()] || (CHAIN_PRESETS[t] ? t : Object.keys(CHAIN_PRESETS).find((k) => k.toLowerCase() === t.toLowerCase()));
  return key ? CHAIN_PRESETS[key] : null;
}

// CLI: <chains> [count]. Falls back to CHAINS / COUNT env (pm2 path).
const rawChains = (process.argv[2] || process.env.CHAINS || 'sepolia')
  .split(',').map((s) => s.trim()).filter(Boolean);
const COUNT = Number(process.argv[3] || process.env.COUNT || 30); // txns per chain

const SELECTED = rawChains.map((tok) => {
  const base = resolveChain(tok);
  if (!base) {
    console.error(`Unknown chain "${tok}". Valid: ${Object.keys(CHAIN_PRESETS).join(', ')} (or a numeric chainId).`);
    process.exit(1);
  }
  const chainId = base.chainId;
  return {
    chainId,
    contract: process.env[`CONTRACT_${chainId}`] || base.contract,
    // Per-chain env wins, then the preset, then a global env fallback for
    // unknown numeric chains, then increment().
    functionSignature:
      process.env[`FUNCTION_SIGNATURE_${chainId}`] || base.functionSignature ||
      process.env.FUNCTION_SIGNATURE || 'function increment()',
    argsFor: base.argsFor || noArgs,
  };
});

const CHAINS = SELECTED.map((s) => s.chainId);
const cfgFor = (chainId) => SELECTED.find((s) => s.chainId === chainId);
const contractFor = (chainId) => cfgFor(chainId)?.contract;
const walletFor = (chainId) => SMART_WALLET || chainInfo[chainId]?.smartWallet || '(unknown)';
// Per-chain submission interval. Slow chains (e.g. Sepolia, ~12s blocks) need
// more spacing so each batch settles before the next is submitted, avoiding
// nonce pile-ups that make the Bundler 500. Falls back to INTERVAL_MS.
const intervalFor = (chainId) => Number(process.env[`INTERVAL_MS_${chainId}`]) || INTERVAL_MS;

const TERMINAL = new Set(['success', 'failed', 'execution_failed', 'validation_failed']);

const startMs = Date.now();
const startIso = new Date(startMs).toISOString();
const CSV_PATH = path.resolve(process.env.CSV_PATH || `loadtest-${startIso.replace(/[:.]/g, '-')}.csv`);

const records = []; // { chain, idx, queue_id, contract, wallet, submittedAt, httpStatus, status, createdAt, updatedAt, latencyS }
let finished = false;
let stopping = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function submit(chainId, idx) {
  const rec = {
    chain: chainId,
    idx,
    queue_id: '',
    contract: contractFor(chainId),
    wallet: walletFor(chainId),
    submittedAt: new Date().toISOString(),
    httpStatus: 0,
    status: '',
    createdAt: '',
    updatedAt: '',
    latencyS: '',
  };
  const cfg = cfgFor(chainId);
  try {
    const res = await fetch(`${QM_URL}/queue/transaction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        functionSignature: cfg.functionSignature,
        args: cfg.argsFor(idx),
        contractAddress: cfg.contract,
        chainId,
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

async function runChain(chainId) {
  for (let i = 1; i <= COUNT && !stopping; i++) {
    const rec = await submit(chainId, i);
    console.log(`[${new Date().toISOString()}] chain ${chainId} #${i}/${COUNT} http=${rec.httpStatus} ${rec.status} ${rec.queue_id}`);
    if (i < COUNT && !stopping) await sleep(intervalFor(chainId));
  }
}

async function refreshStatuses() {
  const ids = records.filter((r) => r.queue_id).map((r) => r.queue_id);
  if (ids.length === 0) return;
  const { rows } = await pool.query(
    `SELECT queue_id, status, created_at, updated_at,
            ROUND(EXTRACT(EPOCH FROM (updated_at - created_at))::numeric, 1) AS lat
       FROM smart_wallet_transactions WHERE queue_id = ANY($1)`,
    [ids]
  );
  const map = new Map(rows.map((r) => [r.queue_id, r]));
  for (const rec of records) {
    const row = map.get(rec.queue_id);
    if (!row) continue;
    rec.status = row.status;
    rec.createdAt = row.created_at ? new Date(row.created_at).toISOString() : '';
    rec.updatedAt = row.updated_at ? new Date(row.updated_at).toISOString() : '';
    rec.latencyS = TERMINAL.has(row.status) ? row.lat : '';
  }
}

function pendingCount() {
  return records.filter((r) => r.queue_id && !TERMINAL.has(r.status)).length;
}

async function trackDrain() {
  const deadline = Date.now() + DRAIN_TIMEOUT_MS;
  while (!stopping && Date.now() < deadline) {
    await refreshStatuses();
    const terminal = records.filter((r) => TERMINAL.has(r.status)).length;
    const queued = records.filter((r) => r.queue_id).length;
    console.log(`[drain] terminal=${terminal} pending=${pendingCount()} of ${queued} accepted`);
    if (pendingCount() === 0) return;
    await sleep(POLL_INTERVAL_MS);
  }
}

function writeCsv() {
  const header = 'chain,idx,queue_id,contract,smart_wallet,submitted_at,http_status,final_status,created_at,updated_at,latency_seconds';
  const lines = [...records]
    .sort((a, b) => a.chain - b.chain || a.idx - b.idx)
    .map((r) => [r.chain, r.idx, r.queue_id, r.contract, r.wallet, r.submittedAt, r.httpStatus, r.status, r.createdAt, r.updatedAt, r.latencyS].join(','));
  fs.writeFileSync(CSV_PATH, [header, ...lines].join('\n') + '\n');
  console.log(`\nCSV written: ${CSV_PATH} (${records.length} rows)`);
}

function pctile(sortedAsc, p) {
  if (!sortedAsc.length) return '-';
  const idx = Math.min(sortedAsc.length - 1, Math.floor((p / 100) * sortedAsc.length));
  return sortedAsc[idx].toFixed(1);
}

function printSummary() {
  console.log(`\n=== SUMMARY (started ${startIso}, ${((Date.now() - startMs) / 60000).toFixed(1)} min) ===`);
  for (const chainId of CHAINS) {
    const recs = records.filter((r) => r.chain === chainId);
    const byStatus = recs.reduce((a, r) => ((a[r.status] = (a[r.status] || 0) + 1), a), {});
    const lats = recs.map((r) => Number(r.latencyS)).filter((n) => !Number.isNaN(n) && n !== 0).sort((a, b) => a - b);
    const avg = lats.length ? (lats.reduce((s, n) => s + n, 0) / lats.length).toFixed(1) : '-';
    const success = byStatus['success'] || 0;
    const rate = recs.length ? ((success / recs.length) * 100).toFixed(0) : '0';
    console.log(
      `chain ${chainId}: submitted=${recs.length} success=${success} (${rate}%) | statuses=${JSON.stringify(byStatus)} | ` +
      `latency p50=${pctile(lats, 50)}s p95=${pctile(lats, 95)}s avg=${avg}s max=${lats.length ? lats[lats.length - 1].toFixed(1) : '-'}s`
    );
  }
  const allSuccess = records.filter((r) => r.status === 'success').length;
  const allRate = records.length ? ((allSuccess / records.length) * 100).toFixed(0) : '0';
  console.log(`OVERALL: ${records.length} txns, ${allSuccess} success (${allRate}%)`);
}

async function finish(reason) {
  if (finished) return;
  finished = true;
  stopping = true;
  console.log(`\nFinishing (${reason})...`);
  try {
    await refreshStatuses();
  } catch (err) {
    console.error('final refresh error:', err.message);
  }
  writeCsv();
  printSummary();
  await closePool().catch(() => { });
  process.exit(0);
}

process.on('SIGINT', () => finish('SIGINT'));
process.on('SIGTERM', () => finish('SIGTERM'));

(async () => {
  try {
    const h = await fetch(`${QM_URL}/health`);
    if (!h.ok) throw new Error(`/health -> ${h.status}`);
  } catch (err) {
    console.error(`Queue Manager not reachable at ${QM_URL}: ${err.message}`);
    await closePool().catch(() => { });
    process.exit(1);
  }

  for (const c of CHAINS) {
    if (!contractFor(c)) {
      console.error(`No target contract for chain ${c} — use a preset name or set CONTRACT_${c}.`);
      await closePool().catch(() => { });
      process.exit(1);
    }
  }

  console.log(`Load test starting ${startIso}`);
  console.log(`  QM=${QM_URL} | ${COUNT} txns/chain`);
  for (const c of CHAINS) {
    const cfg = cfgFor(c);
    console.log(`  chain ${c}: fn=${cfg.functionSignature} contract=${cfg.contract} wallet=${walletFor(c)} interval=${intervalFor(c)}ms`);
  }
  console.log(`  CSV -> ${CSV_PATH}\n`);

  await Promise.all(CHAINS.map(runChain)); // submission phase
  console.log('\nSubmission complete; tracking drain to terminal status...');
  await trackDrain();
  await finish('completed');
})();
