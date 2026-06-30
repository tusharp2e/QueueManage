// Deploy-flow test for the Queue Manager.
//
// POSTs contract deployments to /queue/deploy (one per unique traceId), then
// tracks each to a terminal status and reports the resolved deployed_address
// from smart_wallet_deployments. Reads the contract payload (bytecode/abi/args)
// from scripts/deploy-payload.json.
//
//   node scripts/deployTest.js                 # SMOKE: sepolia,amoy x1 each
//   node scripts/deployTest.js sepolia 5       # 5 deploys on sepolia
//   node scripts/deployTest.js sepolia,amoy 3  # 3 each
//
// Submission is gated per (wallet,chain): one deploy at a time per chain, chains
// concurrent. (Deploys carry large calldata; this keeps the smoke clean and
// avoids giant multi-deploy batches. The batch/load variant comes later.)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { pool, closePool } from '../src/utils/db.js';

const QM_URL = process.env.QM_URL || 'http://localhost:3000';
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 3000);
const SETTLE_TIMEOUT_MS = Number(process.env.SETTLE_TIMEOUT_MS || 10 * 60 * 1000);

const here = path.dirname(fileURLToPath(import.meta.url));
const payload = JSON.parse(fs.readFileSync(path.join(here, 'deploy-payload.json'), 'utf8'));

const CHAINS = { sepolia: 11155111, amoy: 80002, opsepolia: 11155420, basesepolia: 84532, avaxfuji: 43113, bnbtestnet: 97, celosepolia: 11142220 };
const ALIASES = { eth: 'sepolia', op: 'opsepolia', base: 'basesepolia', fuji: 'avaxfuji', avax: 'avaxfuji', bnb: 'bnbtestnet', celo: 'celosepolia', polygon: 'amoy', matic: 'amoy' };
const TERMINAL = new Set(['success', 'failed', 'execution_failed', 'validation_failed']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function resolveKeys(arg) {
  if (!arg) return ['sepolia', 'amoy'];
  return arg.split(',').map((s) => s.trim().toLowerCase()).map((s) => (CHAINS[s] ? s : ALIASES[s])).filter(Boolean);
}

const records = []; // {chain, chainId, traceId, queue_id, httpStatus, status, deployed_address, tx_hash, latencyS}

async function postDeploy(key, chainId) {
  const traceId = randomUUID();
  const rec = { chain: key, chainId, traceId, queue_id: '', httpStatus: 0, status: '', deployed_address: '', tx_hash: '', latencyS: '' };
  try {
    const res = await fetch(`${QM_URL}/queue/deploy`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        abiEncoded: payload.abiEncoded,
        bytecode: payload.bytecode,
        constructorArgs: payload.constructorArgs,
        chainId,
        traceId,
        smartWallet: '',
      }),
    });
    rec.httpStatus = res.status;
    const body = await res.json().catch(() => ({}));
    if (res.ok) { rec.queue_id = body.queue_id || ''; rec.status = body.status || ''; }
    else { rec.status = 'POST_ERROR'; rec.error = JSON.stringify(body).slice(0, 200); }
  } catch (e) { rec.status = 'POST_EXCEPTION'; rec.error = e.message; }
  records.push(rec);
  return rec;
}

async function waitTerminal(rec) {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  for (;;) {
    const { rows } = await pool.query(
      `SELECT t.status, t.transaction_hash,
              ROUND(EXTRACT(EPOCH FROM (t.updated_at - t.created_at))::numeric,1) AS lat,
              d.deployed_address
         FROM smart_wallet_transactions t
         LEFT JOIN smart_wallet_deployments d ON d.tx_id = t.id
        WHERE t.queue_id = $1`, [rec.queue_id]);
    const r = rows[0];
    if (r) {
      rec.status = r.status;
      rec.tx_hash = r.transaction_hash || '';
      rec.deployed_address = r.deployed_address || '';
      rec.latencyS = TERMINAL.has(r.status) ? r.lat : '';
      if (TERMINAL.has(r.status)) return;
    }
    if (Date.now() > deadline) return;
    await sleep(POLL_INTERVAL_MS);
  }
}

async function runChain(key, count) {
  const chainId = CHAINS[key];
  for (let i = 1; i <= count; i++) {
    const rec = await postDeploy(key, chainId);
    console.log(`[${key}] deploy #${i}/${count} http=${rec.httpStatus} ${rec.status} queue_id=${rec.queue_id || rec.error || ''}`);
    if (!rec.queue_id) continue;
    await waitTerminal(rec);
    console.log(`[${key}] deploy #${i} -> ${rec.status} address=${rec.deployed_address || '(none)'} tx=${(rec.tx_hash || '').slice(0, 20)} lat=${rec.latencyS}s`);
  }
}

(async () => {
  const keys = resolveKeys(process.argv[2]);
  const count = Number(process.argv[3] || 1);
  console.log(`Deploy test → ${QM_URL} | chains=[${keys.join(',')}] count=${count}/chain`);
  console.log(`  constructorArgs=${JSON.stringify(payload.constructorArgs)}`);

  try {
    const h = await fetch(`${QM_URL}/health`);
    if (!h.ok) throw new Error(`/health -> ${h.status}`);
  } catch (e) {
    console.error(`QM not reachable: ${e.message}`); await closePool().catch(() => {}); process.exit(1);
  }

  await Promise.all(keys.map((k) => runChain(k, count)));

  // summary
  console.log('\n=== SUMMARY ===');
  for (const k of keys) {
    const rs = records.filter((r) => r.chain === k);
    const ok = rs.filter((r) => r.status === 'success').length;
    const addrs = rs.filter((r) => r.deployed_address).map((r) => r.deployed_address);
    console.log(`  ${k}: ${ok}/${rs.length} success | deployed: ${addrs.join(', ') || '(none resolved)'}`);
    for (const r of rs.filter((x) => x.status && x.status !== 'success')) console.log(`     non-success: ${r.status} ${r.error || ''} tx=${(r.tx_hash||'').slice(0,20)}`);
  }
  await closePool().catch(() => {});
})();
