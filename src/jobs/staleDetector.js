import { pool } from '../utils/db.js';
import { config } from '../config/config.js';
import { logger } from '../utils/logger.js';

// Non-terminal statuses that can get "stuck" if the Bundler or our own process
// dies mid-batch. 'queued' is excluded: a queued row isn't stuck, it's waiting
// for its wallet to free up — failing the stuck batch releases it naturally.
const STUCK_STATUSES = ['dispatched', 'sent'];
const STALE_MESSAGE = 'Stale timeout: stuck in a non-terminal status past the threshold';

let timer = null;
let stopped = false;
let inFlightSweep = null;

export function startStaleDetector() {
  stopped = false;
  timer = setTimeout(sweepTick, config.staleIntervalMs);
  logger.info('Stale detector started', {
    intervalMs: config.staleIntervalMs,
    timeoutMinutes: config.staleTimeoutMinutes,
  });
}

export async function stopStaleDetector() {
  stopped = true;
  if (timer) clearTimeout(timer);
  if (inFlightSweep) await inFlightSweep;
  logger.info('Stale detector stopped');
}

async function sweepTick() {
  inFlightSweep = sweepStale().catch((err) => logger.error('Stale sweep failed', err));
  await inFlightSweep;
  inFlightSweep = null;
  if (!stopped) timer = setTimeout(sweepTick, config.staleIntervalMs);
}

/**
 * One atomic pass: fail every transaction stuck in a non-terminal status longer
 * than the configured threshold. Single UPDATE...RETURNING — safe to run from
 * multiple instances (each row is failed exactly once).
 * @returns {Promise<Array<{id: string, smart_wallet_address: string}>>}
 */
export async function sweepStale() {
  const { rows } = await pool.query(
    `UPDATE smart_wallet_transactions
        SET status = 'failed', message = $1, updated_at = NOW()
      WHERE status = ANY($2)
        AND updated_at < NOW() - make_interval(mins => $3)
      RETURNING id, smart_wallet_address`,
    [STALE_MESSAGE, STUCK_STATUSES, config.staleTimeoutMinutes]
  );

  if (rows.length > 0) {
    logger.warn('Failed stale transactions', {
      count: rows.length,
      ids: rows.map((row) => row.id),
    });
    // KWALA callback hook: once a KWALA callback URL + contract is defined,
    // notify KWALA of each FAILED txn here. Not wired — no endpoint configured.
  }

  return rows;
}
