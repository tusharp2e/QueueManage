import pg from 'pg';
import express from 'express';
import { randomUUID } from 'node:crypto';

import { config } from '../../src/config/config.js';
import { closePool as closeServicePool } from '../../src/utils/db.js';
import { logger } from '../../src/utils/logger.js';

// Keep the winston console/file transports quiet during tests. The service logs
// freely on every dispatch/revert/sweep; left on, that noise drowns the test
// reporter and writes junk into logs/. Errors that matter surface as failing
// assertions, not log lines.
logger.silent = true;

// ---------------------------------------------------------------------------
// Test DB pool
//
// The helper owns a SEPARATE pool from the service's pool (src/utils/db.js).
// Both point at the same physical test DB, so a row the service writes is a row
// these helpers can read. Reading TEST_DATABASE_URL directly (rather than the
// discrete POSTGRES_* vars) keeps the test harness's connection explicit.
// ---------------------------------------------------------------------------
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL || 'postgres://postgres:test@localhost:5433/qm_test';

// Defense in depth (the same guard runs in globalSetup): never let cleanDB's
// DELETE statements reach a non-local database, whatever the env happens to say.
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1', 'postgres'];
const host = new URL(TEST_DATABASE_URL).hostname;
if (!LOCAL_HOSTS.includes(host)) {
  throw new Error(
    `Refusing to connect tests to non-local DB host "${host}". ` +
      `cleanDB() issues DELETEs — point TEST_DATABASE_URL at a local test DB.`
  );
}

export const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });

/** Re-exported so tests can repoint the Bundler URL at a mock per scenario. */
export { config };

/** Deletes every row. Call in beforeEach so each test starts from empty. */
export async function cleanDB() {
  await pool.query('DELETE FROM smart_wallet_transactions');
}

/** Closes both pools. Call in afterAll to avoid leaked connection handles. */
export async function closeAll() {
  await pool.end();
  await closeServicePool();
}

// Sensible defaults for a queued 'call' transaction. Anything here can be
// overridden per call — including created_at/updated_at, which the ordering and
// stale-detector tests must back-date.
function defaults(id) {
  return {
    id,
    queue_id: id,
    status: 'queued',
    transaction_type: 'call',
    chain_id: 80002,
    entry_point_address: config.testnetEntryPointAddress,
    paymaster_address: config.testnetPaymasterAddress,
    smart_wallet_address: '0x1111111111111111111111111111111111111111',
    target_contract: '0x2222222222222222222222222222222222222222',
    function_signature: 'transfer(address,uint256)',
    args: ['0x3333333333333333333333333333333333333333', '1000'],
    nonce: '0',
  };
}

/**
 * Inserts one transaction, returning its id. Builds the INSERT dynamically from
 * the merged row so callers can set ANY column (e.g. status: 'dispatched',
 * created_at: new Date(...)) without a bespoke helper per scenario.
 *
 * @param {object} overrides - columns to override (DB column names)
 * @returns {Promise<string>} the inserted row's id
 */
export async function insertTestTxn(overrides = {}) {
  const id = overrides.id ?? randomUUID();
  const row = { ...defaults(id), ...overrides, id };
  // queue_id defaults to the (possibly generated) id unless explicitly given.
  row.queue_id = overrides.queue_id ?? id;

  const cols = Object.keys(row);
  const values = cols.map((c) => (c === 'args' ? JSON.stringify(row[c]) : row[c]));
  const placeholders = cols.map((c, i) => (c === 'args' ? `$${i + 1}::jsonb` : `$${i + 1}`));

  const { rows } = await pool.query(
    `INSERT INTO smart_wallet_transactions (${cols.join(', ')})
     VALUES (${placeholders.join(', ')})
     RETURNING id`,
    values
  );
  return rows[0].id;
}

/** Reads one transaction by id (full row), or null. */
export async function getTxn(id) {
  const { rows } = await pool.query('SELECT * FROM smart_wallet_transactions WHERE id = $1', [id]);
  return rows[0] ?? null;
}

/** Reads all transactions for a wallet, oldest first. */
export async function getTxnsForWallet(wallet) {
  const { rows } = await pool.query(
    `SELECT * FROM smart_wallet_transactions
      WHERE smart_wallet_address = $1
      ORDER BY created_at ASC`,
    [wallet]
  );
  return rows;
}

/**
 * A controllable stand-in for the Bundler — the one external service we mock.
 * Each test picks the behavior it needs; nothing leaks between tests because
 * received payloads are reset with clearReceived() (or a fresh instance).
 *
 *   const bundler = createMockBundler();
 *   const port = await bundler.start();        // ephemeral port
 *   config.bundlerUrl = bundler.url();          // point the service at it
 *   bundler.rejectAll();                        // simulate Bundler down
 *   ...
 *   await bundler.stop();
 */
export function createMockBundler() {
  const received = [];
  let mode = 'accept'; // 'accept' | 'reject' | 'timeout' | 'custom'
  let customHandler = null;
  let server = null;

  const appInstance = express();
  appInstance.use(express.json({ limit: '5mb' }));
  appInstance.all('*', (req, res) => {
    // Record before responding so even the timeout path captures the payload.
    received.push(req.body);
    if (mode === 'custom' && customHandler) return customHandler(req, res);
    if (mode === 'timeout') return; // never respond — client aborts on its deadline
    if (mode === 'reject') return res.status(500).json({ error: 'BUNDLER_DOWN' });
    return res.status(200).json({ status: 'ACCEPTED' });
  });

  return {
    /** Starts on `port` (default 0 = ephemeral). Returns the bound port. */
    async start(port = 0) {
      await new Promise((resolve) => {
        server = appInstance.listen(port, resolve);
      });
      return server.address().port;
    },
    async stop() {
      if (server) await new Promise((resolve) => server.close(resolve));
      server = null;
    },
    /** Full URL to the running mock (use as config.bundlerUrl). */
    url(path = '/') {
      if (!server) throw new Error('mock bundler not started');
      return `http://127.0.0.1:${server.address().port}${path}`;
    },
    acceptAll() {
      mode = 'accept';
      customHandler = null;
    },
    rejectAll() {
      mode = 'reject';
      customHandler = null;
    },
    timeout() {
      mode = 'timeout';
      customHandler = null;
    },
    /** Custom (req,res) handler for bespoke scenarios (status codes, bodies). */
    setHandler(fn) {
      mode = 'custom';
      customHandler = fn;
    },
    getReceivedBatches() {
      return received;
    },
    clearReceived() {
      received.length = 0;
    },
  };
}
