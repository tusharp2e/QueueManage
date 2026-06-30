// Verify the last batch of deploys: shows each op's traceId, batch_id, status,
// and resolved deployed_address. If all rows in one batch_id share the SAME
// deployed_address -> the resolution bug is still present. Distinct addresses
// per op -> fixed.
//
//   node scripts/check3deploys.js            # last 15 min of deploys
//   SINCE_MIN=60 node scripts/check3deploys.js

import { pool, closePool } from '../src/utils/db.js';
import { config } from '../src/config/config.js';

const WALLET = config.defaultTestnetSmartWalletAddress;
const SINCE_MIN = Number(process.env.SINCE_MIN || 15);

const { rows } = await pool.query(
  `SELECT t.batch_id, t.queue_id, t.args->>0 AS trace_id, t.status,
          t.transaction_hash, d.deployed_address
     FROM smart_wallet_transactions t
     LEFT JOIN smart_wallet_deployments d ON d.tx_id = t.id
    WHERE t.smart_wallet_address = $1 AND t.transaction_type = 'deploy'
      AND t.created_at >= NOW() - make_interval(mins => $2)
    ORDER BY t.created_at DESC`,
  [WALLET, SINCE_MIN]
);

// group by batch
const byBatch = new Map();
for (const r of rows) { const k = r.batch_id || '(none)'; (byBatch.get(k) || byBatch.set(k, []).get(k)).push(r); }

for (const [batch, ops] of byBatch) {
  const addrs = ops.map((o) => o.deployed_address).filter(Boolean);
  const distinct = new Set(addrs).size;
  const verdict = ops.length <= 1 ? '(single)' : distinct === ops.length ? '✅ DISTINCT (fixed)' : distinct === 1 ? '❌ ALL SAME (bug)' : `⚠️ ${distinct}/${ops.length} distinct`;
  console.log(`\nbatch ${batch.slice(0, 8)} — ${ops.length} deploys — ${verdict}`);
  for (const o of ops) console.log(`  trace=${o.trace_id} status=${o.status} addr=${o.deployed_address || '(pending)'}`);
}
await closePool().catch(() => {});
