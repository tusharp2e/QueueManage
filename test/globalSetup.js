import pg from 'pg';

// ---------------------------------------------------------------------------
// Global setup: runs ONCE in the main process before any test worker starts.
//
// The base smart_wallet_transactions table + smart_wallet_status enum live in
// a "shared schema" that is NOT in this repo (migrations/001 only ALTERs an
// already-existing table). So for a test DB we bootstrap the schema ourselves,
// reproducing what production looks like AFTER migration 001 has run:
//   - the enum includes 'dispatched'
//   - the table has batch_id and the (status, smart_wallet_address) index
//
// We deliberately use the REAL enum type rather than a plain VARCHAR. A varchar
// column would silently accept any string; the production enum rejects values
// outside its set. Keeping the enum means a bug that writes an unknown status
// fails in tests exactly as it would in production.
// ---------------------------------------------------------------------------

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL || 'postgres://postgres:test@localhost:5433/qm_test';

const SCHEMA_SQL = `
  DO $$ BEGIN
    CREATE TYPE smart_wallet_status AS ENUM (
      'queued', 'dispatched', 'sent', 'success',
      'execution_failed', 'validation_failed', 'failed'
    );
  EXCEPTION WHEN duplicate_object THEN NULL; END $$;

  CREATE TABLE IF NOT EXISTS smart_wallet_transactions (
    id                    UUID PRIMARY KEY,
    queue_id              VARCHAR NOT NULL,
    batch_id              UUID,
    user_op_hash          VARCHAR(66),
    entry_point_queue_id  VARCHAR,
    transaction_hash      VARCHAR(66),
    status                smart_wallet_status NOT NULL DEFAULT 'queued',
    transaction_type      VARCHAR NOT NULL DEFAULT 'call',
    chain_id              INTEGER NOT NULL,
    entry_point_address   VARCHAR,
    paymaster_address     VARCHAR,
    smart_wallet_address  VARCHAR NOT NULL,
    target_contract       VARCHAR,
    function_signature    VARCHAR,
    args                  JSONB,
    nonce                 VARCHAR NOT NULL,
    simulation_result     JSONB,
    execution_id          VARCHAR,
    message               TEXT,
    created_at            TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMP NOT NULL DEFAULT NOW(),
    consumed_at           TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_swt_status_wallet
    ON smart_wallet_transactions (status, smart_wallet_address);
`;

export async function setup() {
  // Defense in depth: refuse to touch anything that isn't a local test DB, even
  // though vitest.config also points here. cleanDB() issues DELETEs; a misread
  // env must never let that hit the production RDS instance.
  const host = new URL(TEST_DATABASE_URL).hostname;
  const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1', 'postgres'];
  if (!LOCAL_HOSTS.includes(host)) {
    throw new Error(
      `Refusing to run tests against non-local DB host "${host}". ` +
        `Set TEST_DATABASE_URL to a local test database.`
    );
  }

  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
  try {
    await pool.query(SCHEMA_SQL);
  } finally {
    await pool.end();
  }
}
