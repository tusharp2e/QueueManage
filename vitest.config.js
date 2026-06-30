import { defineConfig } from 'vitest/config';

// ---------------------------------------------------------------------------
// Test environment wiring
//
// The service reads DISCRETE connection vars (POSTGRES_USER/HOST/DB_NAME/...)
// in src/config/config.js, and that module calls process.exit(1) if any
// required var is missing. The pool in src/utils/db.js is then built FROM
// those vars AT IMPORT TIME. So by the time a test file imports anything from
// src/, the connection is already decided.
//
// We therefore parse a single TEST_DATABASE_URL into the discrete vars the
// service expects and inject them via `test.env`, which Vitest applies before
// any module is evaluated. config.js also calls dotenv.config(), which loads
// the project's REAL .env (production RDS creds) — but dotenv does NOT override
// vars that are already set, so the values below win and the prod creds never
// take effect during tests.
// ---------------------------------------------------------------------------

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL || 'postgres://postgres:test@localhost:5433/qm_test';

const u = new URL(TEST_DATABASE_URL);

const dbEnv = {
  TEST_DATABASE_URL,
  POSTGRES_USER: decodeURIComponent(u.username),
  POSTGRES_HOST: u.hostname,
  DB_NAME: u.pathname.replace(/^\//, ''),
  DB_PASSWORD: decodeURIComponent(u.password),
  DB_PORT: u.port || '5432',
};

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    // 15s so the Bundler-timeout tests (real 10s AbortSignal) have headroom.
    testTimeout: 15000,
    hookTimeout: 15000,
    // Every test file shares ONE physical database and calls cleanDB(). Running
    // files in parallel would let one file's cleanDB() wipe another file's rows
    // mid-test. Serialize files; tests within a file already run sequentially.
    fileParallelism: false,
    // Creates the schema once before any worker starts.
    globalSetup: './test/globalSetup.js',
    // Load scripts are excluded — they are manual perf harnesses, not unit tests.
    include: ['test/**/*.test.js'],
    exclude: ['test/load/**', 'node_modules/**'],
    env: {
      ...dbEnv,
      // Pin operational config so tests NEVER inherit these knobs from the
      // project's .env (which carries production-ish values). Without this, a
      // test asserting "14 queued -> 10 dispatched" or a 5-minute stale window
      // would silently depend on whatever .env happens to say. test.env is
      // applied before dotenv.config() runs, and dotenv won't override it.
      MAX_BATCH_SIZE: '10',
      STALE_TIMEOUT_MINUTES: '5',
      DISPATCHER_INTERVAL_MS: '5000',
      STALE_INTERVAL_MS: '60000',
      // Short so the "timeout" test exercises the real abort path in ~200ms
      // instead of the production 120s.
      BUNDLER_TIMEOUT_MS: '200',
      // Overridden per-test by the mock Bundler's actual URL; this placeholder
      // only exists so config.js's required-vars check passes at import.
      BUNDLER_URL: 'http://127.0.0.1:1',
      BUNDLER_AUTH_TOKEN: 'test-token',
      // Public testnet addresses (not secrets) so chainInfo defaults are valid
      // 0x addresses — needed by the "empty smartWallet -> chain default" test.
      TESTNET_ENTRYPOINT_ADDRESS: '0x437A904958Fcf25ad6a6A9BC7F28b2F02d2D8485',
      TESTNET_PAYMASTER_ADDRESS: '0xC0c93FB14810d5a6Ace26999b816F5c3522249E0',
      TESTNET_DEFAULT_SMARTWALLET_ADDRESS: '0xfee33972f37ec3a85254a4cda60b2b6adeeb7e12',
      UNIVERSAL_CONTRACT_DEPLOYER: '0xd4381E45cdBC31ABC8e413638b84e6FaE2138F2d',
    },
  },
});
