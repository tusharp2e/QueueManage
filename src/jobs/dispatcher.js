import { randomUUID } from 'node:crypto';
import { pool } from '../utils/db.js';
import { config } from '../config/config.js';
import { logger } from '../utils/logger.js';
import { sendBatchToBundler, BundlerError } from '../services/dispatchToBundler.js';

// Statuses that mean "a batch is already in progress for this wallet". The
// in-flight check blocks a new batch while any of these exist (wallet-level
// serialization: at most one batch per wallet at a time).
const IN_FLIGHT_STATUSES = ['dispatched', 'sent'];

let timer = null;
let stopped = false;
let inFlightTick = null;

export function startDispatcher() {
  stopped = false;
  timer = setTimeout(tick, config.dispatcherIntervalMs);
  logger.info('Dispatcher started', { intervalMs: config.dispatcherIntervalMs });
}

export async function stopDispatcher() {
  stopped = true;
  if (timer) clearTimeout(timer);
  // Let an in-progress tick finish so we never abandon a half-done dispatch.
  if (inFlightTick) await inFlightTick;
  logger.info('Dispatcher stopped');
}

// Scheduling the next tick only AFTER the current one resolves makes
// overlapping ticks structurally impossible — no re-entrancy flag needed.
async function tick() {
  inFlightTick = dispatchOnce().catch((err) => logger.error('Dispatcher tick failed', err));
  await inFlightTick;
  inFlightTick = null;
  if (!stopped) timer = setTimeout(tick, config.dispatcherIntervalMs);
}

/**
 * One dispatch pass: find every (wallet, chain) with queued work and process
 * them concurrently. Exported for testing — note it touches ALL queued work.
 *
 * Serialization is per (wallet, chain): the same wallet address on two chains
 * is two independent units (chains have independent nonces), so they dispatch
 * concurrently and never share a batch.
 */
export async function dispatchOnce() {
  const { rows } = await pool.query(
    `SELECT DISTINCT smart_wallet_address, chain_id
       FROM smart_wallet_transactions
      WHERE status = 'queued'`
  );
  if (rows.length === 0) return;

  await Promise.all(rows.map((r) => dispatchWalletChain(r.smart_wallet_address, r.chain_id)));
}

/**
 * Claims and dispatches at most one batch for a single (wallet, chain).
 *
 * Multi-instance note: with several instances, two could pass the in-flight
 * check simultaneously. To harden later, wrap the check+claim in a transaction
 * using `pg_advisory_xact_lock(hashtext(wallet || chain))` and
 * `FOR UPDATE SKIP LOCKED`. For a single instance the tick guard suffices.
 */
export async function dispatchWalletChain(wallet, chainId) {
  try {
    const inFlight = await pool.query(
      `SELECT 1 FROM smart_wallet_transactions
        WHERE smart_wallet_address = $1 AND chain_id = $2 AND status = ANY($3) LIMIT 1`,
      [wallet, chainId, IN_FLIGHT_STATUSES]
    );
    if (inFlight.rowCount > 0) return; // a batch is already in flight for this wallet+chain — skip

    const claim = await pool.query(
      `SELECT id, chain_id, target_contract, function_signature, args,
              transaction_type, paymaster_address, entry_point_address
         FROM smart_wallet_transactions
        WHERE smart_wallet_address = $1 AND chain_id = $2 AND status = 'queued'
        ORDER BY created_at ASC
        LIMIT $3`,
      [wallet, chainId, config.maxBatchSize]
    );
    if (claim.rowCount === 0) return;

    const ids = claim.rows.map((row) => row.id);
    const batchId = randomUUID();

    await pool.query(
      `UPDATE smart_wallet_transactions
          SET status = 'dispatched', batch_id = $1, updated_at = NOW()
        WHERE id = ANY($2::uuid[])`,
      [batchId, ids]
    );

    const batch = buildBatchPayload(batchId, wallet, claim.rows);

    try {
      await sendBatchToBundler(batch);
      logger.info('Batch dispatched', { batchId, wallet, chainId: Number(chainId), count: ids.length });
    } catch (err) {
      // Revert by primary key (the ids we just claimed) so these rows return
      // to the queue and the next tick retries them.
      await pool.query(
        `UPDATE smart_wallet_transactions
            SET status = 'queued', batch_id = NULL, updated_at = NOW()
          WHERE id = ANY($1::uuid[])`,
        [ids]
      );
      if (err instanceof BundlerError) {
        logger.warn('Batch dispatch failed, reverted to queued', {
          batchId,
          wallet,
          chainId: Number(chainId),
          kind: err.kind,
          status: err.status,
          responseBody: err.responseBody,
        });
      } else {
        // Not a BundlerError => a bug in our own code, not the Bundler being down.
        logger.error('Unexpected error dispatching batch, reverted to queued', err);
      }
    }
  } catch (err) {
    // A DB failure in the check/claim/mark path. Retried next tick.
    logger.error(`Failed to process wallet ${wallet} on chain ${chainId}`, err);
  }
}

function buildBatchPayload(batchId, wallet, rows) {
  return {
    batchId,
    smartWallet: wallet,
    chainId: Number(rows[0].chain_id),
    transactions: rows.map((row) => ({
      id: row.id,
      // Stable idempotency key — the queue_id (= id), which never changes across
      // retries. The Bundler MUST pass this verbatim to thirdweb (NOT queue_id +
      // timestamp, and NOT batch_id, both of which change per attempt).
      idempotencyKey: row.id,
      contractAddress: row.target_contract,
      functionSignature: row.function_signature,
      args: row.args,
      transactionType: row.transaction_type,
      paymasterAddress: row.paymaster_address,
      entryPointAddress: row.entry_point_address,
    })),
  };
}
