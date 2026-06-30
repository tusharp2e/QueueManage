// Paymaster cost-per-userOp calibration.
//
// Measures the REAL gas cost the paymaster pays per userOp on each chain by
// reading the EntryPoint deposit before and after submitting a small number of
// userOps through the live Queue Manager:
//
//   cost/op = (deposit_before - deposit_after) / N
//
// then projects that to the planned 1000-userOp run and flags which chains'
// current deposits can't cover it. This replaces the gas-price *assumptions* in
// the load-test feasibility estimate with measured numbers.
//
// Two modes:
//   node scripts/calibrate.js check          # read & print current deposits only (read-only)
//   node scripts/calibrate.js run 10         # submit N userOps/chain, measure cost/op
//   node scripts/calibrate.js run 10 sepolia,avax   # only specific chains
//
// Reads paymaster gas deposit = EntryPoint.balanceOf(paymaster). Optional relayer
// balance via RELAYER_ADDRESS env (the bundler EOA).

import fs from 'node:fs';
import path from 'node:path';
import { ethers } from 'ethers';
import { pool, closePool } from '../src/utils/db.js';
import { config } from '../src/config/config.js';

const QM_URL = process.env.QM_URL || 'http://localhost:3000';
const ENTRY_POINT = config.testnetEntryPointAddress;
const PAYMASTER = config.testnetPaymasterAddress;
const RELAYER = process.env.RELAYER_ADDRESS || ''; // optional bundler EOA
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 3000);
const SETTLE_TIMEOUT_MS = Number(process.env.SETTLE_TIMEOUT_MS || 25 * 60 * 1000);
const PROJECT_TO = Number(process.env.PROJECT_TO || 1000); // userOps the real run targets
const SAFETY = Number(process.env.SAFETY || 1.5); // top-up target = projected * SAFETY

// Per-chain: rpc + the contract/function to exercise. All amounts are native
// token with 18 decimals (ETH/POL/AVAX/tBNB/CELO all qualify), so formatEther
// is correct everywhere.
const noArgs = () => [];
const oneUint = (i) => [i];
const CHAINS = {
  sepolia:     { chainId: 11155111, symbol: 'ETH',  rpc: process.env.SEPOLIA_RPC_URL || 'https://11155111.rpc.thirdweb.com/28eb15303fc228ba1379cfc8dd0181c4', contract: '0x98F811D169F8A87AF29015ac170B709135c5CC07', fn: 'function increment()', args: noArgs },
  amoy:        { chainId: 80002,    symbol: 'POL',  rpc: process.env.AMOY_RPC_URL || 'https://80002.rpc.thirdweb.com/28eb15303fc228ba1379cfc8dd0181c4', contract: '0xD3601131e5b98fab6326CC795e171252bA2Ae86C', fn: 'function increment()', args: noArgs },
  opsepolia:   { chainId: 11155420, symbol: 'ETH',  rpc: process.env.OP_SEPOLIA_RPC_URL || 'https://optimism-sepolia-rpc.publicnode.com', contract: '0x3caa944E4638c873b36638965521aBAf0d202bb9', fn: 'function set1(uint256 _x)', args: oneUint },
  basesepolia: { chainId: 84532,    symbol: 'ETH',  rpc: process.env.BASE_SEPOLIA_RPC_URL || 'https://base-sepolia-rpc.publicnode.com', contract: '0x0cC01096800d5DD37c42598832A3669295aE914C', fn: 'function set1(uint256 _x)', args: oneUint },
  avaxfuji:    { chainId: 43113,    symbol: 'AVAX', rpc: process.env.FUJI_RPC_URL || 'https://43113.rpc.thirdweb.com/28eb15303fc228ba1379cfc8dd0181c4', contract: '0x98907e0dAf5E358B9569F2C57D8B06Ffad21028F', fn: 'function set1(uint256 _x)', args: oneUint },
  bnbtestnet:  { chainId: 97,       symbol: 'tBNB', rpc: process.env.BNB_TESTNET_RPC_URL || 'https://bsc-testnet-rpc.publicnode.com', contract: '0x88C93C890C3C4355b7fF506e1ef19bCBaee8aDdF', fn: 'function set1(uint256 _x)', args: oneUint },
  celosepolia: { chainId: 11142220, symbol: 'CELO', rpc: process.env.CELO_SEPOLIA_RPC_URL || 'https://11142220.rpc.thirdweb.com/28eb15303fc228ba1379cfc8dd0181c4', contract: '0x7a5F2c113c247E8196DD453a7b7C57dbFc20793B', fn: 'function set1(uint256 _x)', args: oneUint },
};
const ALIASES = { eth: 'sepolia', op: 'opsepolia', 'op-sepolia': 'opsepolia', base: 'basesepolia', fuji: 'avaxfuji', avax: 'avaxfuji', bnb: 'bnbtestnet', bsc: 'bnbtestnet', celo: 'celosepolia', polygon: 'amoy', matic: 'amoy' };

const EP_ABI = ['function balanceOf(address) view returns (uint256)'];
const TERMINAL = new Set(['success', 'failed', 'execution_failed', 'validation_failed']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (wei) => ethers.formatEther(wei);

function providerFor(key) {
  return new ethers.JsonRpcProvider(CHAINS[key].rpc, undefined, { staticNetwork: true });
}

async function readDeposit(key) {
  const ep = new ethers.Contract(ENTRY_POINT, EP_ABI, providerFor(key));
  return ep.balanceOf(PAYMASTER); // BigInt wei
}

async function readRelayer(key) {
  if (!RELAYER) return null;
  return providerFor(key).getBalance(RELAYER);
}

async function postUserOp(key, idx) {
  const c = CHAINS[key];
  try {
    const res = await fetch(`${QM_URL}/queue/transaction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        functionSignature: c.fn,
        args: c.args(idx),
        contractAddress: c.contract,
        chainId: c.chainId,
        smartWallet: '', // chain default wallet
      }),
    });
    const body = await res.json().catch(() => ({}));
    return res.ok ? { ok: true, queue_id: body.queue_id } : { ok: false, status: res.status };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function waitTerminal(queueIds) {
  if (queueIds.length === 0) return [];
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  for (;;) {
    const { rows } = await pool.query(
      `SELECT queue_id, status FROM smart_wallet_transactions WHERE queue_id = ANY($1)`,
      [queueIds]
    );
    if (rows.length === queueIds.length && rows.every((r) => TERMINAL.has(r.status))) return rows;
    if (Date.now() > deadline) return rows; // give up; report whatever we have
    await sleep(POLL_INTERVAL_MS);
  }
}

async function calibrateChain(key, n) {
  const c = CHAINS[key];
  const out = { key, chainId: c.chainId, symbol: c.symbol, n, success: 0, failed: 0, before: 0n, after: 0n, relBefore: null, relAfter: null, error: '' };
  try {
    out.before = await readDeposit(key);
    out.relBefore = await readRelayer(key);

    const results = await Promise.all(Array.from({ length: n }, (_, i) => postUserOp(key, i + 1)));
    const ids = results.filter((r) => r.ok && r.queue_id).map((r) => r.queue_id);
    const rows = await waitTerminal(ids);
    out.success = rows.filter((r) => r.status === 'success').length;
    out.failed = rows.filter((r) => r.status !== 'success').length;

    out.after = await readDeposit(key);
    out.relAfter = await readRelayer(key);
  } catch (e) {
    out.error = e.shortMessage || e.message;
  }
  return out;
}

function writeCsv(rows, file) {
  const header = 'chain,chain_id,symbol,n_submitted,n_success,n_failed,deposit_before,deposit_after,spent,cost_per_op,projected_for_target,current_deposit,covers_target,recommended_topup';
  const lines = rows.map((r) => {
    const spent = r.before - r.after;
    const perOp = r.success > 0 ? spent / BigInt(r.success) : 0n;
    const projected = perOp * BigInt(PROJECT_TO);
    const covers = r.after >= projected;
    const target = (projected * BigInt(Math.round(SAFETY * 100))) / 100n;
    const topup = target > r.after ? target - r.after : 0n;
    return [r.key, r.chainId, r.symbol, r.n, r.success, r.failed, fmt(r.before), fmt(r.after), fmt(spent), fmt(perOp), fmt(projected), fmt(r.after), covers, fmt(topup)].join(',');
  });
  fs.writeFileSync(file, [header, ...lines].join('\n') + '\n');
  console.log(`\nCSV written: ${file}`);
}

function printResults(rows) {
  console.log(`\n=== CALIBRATION (n per chain, projected to ${PROJECT_TO} userOps, safety x${SAFETY}) ===`);
  for (const r of rows) {
    if (r.error) { console.log(`  ${r.key.padEnd(12)} ERROR: ${r.error}`); continue; }
    const spent = r.before - r.after;
    const perOp = r.success > 0 ? spent / BigInt(r.success) : 0n;
    const projected = perOp * BigInt(PROJECT_TO);
    const covers = r.after >= projected;
    const target = (projected * BigInt(Math.round(SAFETY * 100))) / 100n;
    const topup = target > r.after ? target - r.after : 0n;
    console.log(
      `  ${r.key.padEnd(12)} ${String(r.success)}/${r.n} ok | cost/op=${Number(fmt(perOp)).toFixed(6)} ${r.symbol} | ` +
      `proj ${PROJECT_TO}=${Number(fmt(projected)).toFixed(4)} | deposit=${Number(fmt(r.after)).toFixed(4)} | ` +
      `${covers ? '✅ covers' : '❌ SHORT'}${topup > 0n ? ` | top up +${Number(fmt(topup)).toFixed(4)} ${r.symbol}` : ''}`
    );
  }
}

async function checkOnly(keys) {
  console.log(`Current paymaster deposits (EntryPoint.balanceOf) — paymaster ${PAYMASTER}`);
  const rows = await Promise.all(keys.map(async (key) => {
    try {
      const dep = await readDeposit(key);
      const rel = await readRelayer(key);
      return { key, symbol: CHAINS[key].symbol, dep, rel };
    } catch (e) { return { key, error: e.shortMessage || e.message }; }
  }));
  for (const r of rows) {
    if (r.error) { console.log(`  ${r.key.padEnd(12)} ERROR: ${r.error}`); continue; }
    console.log(`  ${r.key.padEnd(12)} deposit=${Number(fmt(r.dep)).toFixed(6)} ${r.symbol}${r.rel != null ? ` | relayer=${Number(fmt(r.rel)).toFixed(6)} ${r.symbol}` : ''}`);
  }
}

function resolveKeys(arg) {
  if (!arg) return Object.keys(CHAINS);
  return arg.split(',').map((s) => s.trim().toLowerCase()).map((s) => (CHAINS[s] ? s : ALIASES[s])).filter(Boolean);
}

(async () => {
  const mode = process.argv[2] || 'check';

  if (mode === 'check') {
    await checkOnly(resolveKeys(process.argv[3]));
    await closePool().catch(() => {});
    return;
  }

  // run mode
  const n = Number(process.argv[3] || 10);
  const keys = resolveKeys(process.argv[4]);
  console.log(`Calibration: ${n} userOps/chain on [${keys.join(', ')}] via ${QM_URL}`);
  console.log(`  entryPoint=${ENTRY_POINT} paymaster=${PAYMASTER}`);

  try {
    const h = await fetch(`${QM_URL}/health`);
    if (!h.ok) throw new Error(`/health -> ${h.status}`);
  } catch (e) {
    console.error(`Queue Manager not reachable at ${QM_URL}: ${e.message}`);
    await closePool().catch(() => {});
    process.exit(1);
  }

  const startIso = new Date().toISOString();
  const csv = path.resolve(process.env.CSV_PATH || `calibration-${startIso.replace(/[:.]/g, '-')}.csv`);

  // All chains concurrently — each chain's paymaster deposit is independent.
  const rows = await Promise.all(keys.map((key) => calibrateChain(key, n)));

  printResults(rows);
  writeCsv(rows, csv);
  await closePool().catch(() => {});
})();
