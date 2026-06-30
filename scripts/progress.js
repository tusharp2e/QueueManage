// Read-only progress monitor for the multi-chain load test.
// Shows per-chain submitted / success / pending / failed and % of target.
//   node scripts/progress.js              # last 6h, default targets
//   SINCE_MIN=180 node scripts/progress.js
//   watch -n 15 'node scripts/progress.js'   # live refresh

import { pool, closePool } from '../src/utils/db.js';
import { config } from '../src/config/config.js';

const WALLET = config.defaultTestnetSmartWalletAddress;
const SINCE_MIN = Number(process.env.SINCE_MIN || 360);
const TARGETS = { 11155111: 1000, 80002: 1000, 11155420: 1000, 84532: 1000, 43113: 1000, 97: 800, 11142220: 1000 };
const NAME = { 11155111: 'sepolia', 80002: 'amoy', 11155420: 'opsepolia', 84532: 'basesepolia', 43113: 'avaxfuji', 97: 'bnbtestnet', 11142220: 'celosepolia' };

const { rows } = await pool.query(
  `SELECT chain_id,
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE status='success')::int AS success,
          COUNT(*) FILTER (WHERE status IN ('queued','dispatched','sent'))::int AS pending,
          COUNT(*) FILTER (WHERE status IN ('failed','execution_failed','validation_failed'))::int AS failed
     FROM smart_wallet_transactions
    WHERE smart_wallet_address = $1 AND created_at >= NOW() - make_interval(mins => $2)
    GROUP BY chain_id ORDER BY chain_id`,
  [WALLET, SINCE_MIN]
);

let t = 0, ok = 0;
console.log(`Progress (last ${SINCE_MIN}m, wallet ${WALLET}):`);
for (const r of rows) {
  const tgt = TARGETS[r.chain_id] || 1000;
  const pct = ((r.success / tgt) * 100).toFixed(0);
  t += r.total; ok += r.success;
  console.log(
    `  ${(NAME[r.chain_id] || r.chain_id).padEnd(12)} ${String(r.success).padStart(4)}/${tgt} (${pct.padStart(3)}%) ` +
    `| pending=${String(r.pending).padStart(2)} failed=${r.failed}`
  );
}
console.log(`  -- total submitted=${t} success=${ok}`);
await closePool().catch(() => {});
