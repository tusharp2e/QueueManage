// ---------------------------------------------------------------------------
// Load-test environment bootstrap.
//
// MUST be imported FIRST (before any src/ import) in every load script, because
// src/config/config.js reads discrete env vars at import time and exits the
// process if required ones are missing. We map a single DB URL into those vars
// and supply placeholders for the rest, mirroring vitest.config.js.
//
// This file imports nothing from src/, so importing it has no side effects
// beyond setting process.env.
// ---------------------------------------------------------------------------

const DB_URL =
  process.env.LOAD_DATABASE_URL ||
  process.env.TEST_DATABASE_URL ||
  'postgres://postgres:test@localhost:5433/qm_test';

// Safety: a load test issues mass INSERTs and DELETEs. Never let it touch a
// non-local database, whatever the env says.
const host = new URL(DB_URL).hostname;
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1', 'postgres'];
if (!LOCAL_HOSTS.includes(host)) {
  console.error(
    `Refusing to run a load test against non-local DB host "${host}". ` +
      `Point LOAD_DATABASE_URL / TEST_DATABASE_URL at a local database.`
  );
  process.exit(1);
}

const u = new URL(DB_URL);
const setDefault = (key, value) => {
  if (process.env[key] === undefined) process.env[key] = value;
};

// Make the URL discoverable to helpers that read it directly.
setDefault('TEST_DATABASE_URL', DB_URL);

// DB connection (discrete vars consumed by src/config/config.js).
setDefault('POSTGRES_USER', decodeURIComponent(u.username));
setDefault('POSTGRES_HOST', u.hostname);
setDefault('DB_NAME', u.pathname.replace(/^\//, ''));
setDefault('DB_PASSWORD', decodeURIComponent(u.password));
setDefault('DB_PORT', u.port || '5432');

// Operational knobs (pinned so load numbers are reproducible, not inherited
// from the project .env).
setDefault('MAX_BATCH_SIZE', '10');
setDefault('STALE_TIMEOUT_MINUTES', '5');
setDefault('DISPATCHER_INTERVAL_MS', '5000');
setDefault('STALE_INTERVAL_MS', '60000');

// Bundler URL is overridden at runtime by the in-process mock; placeholder only
// satisfies config's required-vars check.
setDefault('BUNDLER_URL', 'http://127.0.0.1:1');
setDefault('BUNDLER_AUTH_TOKEN', 'load-test-token');
setDefault('BUNDLER_TIMEOUT_MS', '10000');

// Public testnet addresses (not secrets) so chainInfo defaults are valid.
setDefault('TESTNET_ENTRYPOINT_ADDRESS', '0x437A904958Fcf25ad6a6A9BC7F28b2F02d2D8485');
setDefault('TESTNET_PAYMASTER_ADDRESS', '0xC0c93FB14810d5a6Ace26999b816F5c3522249E0');
setDefault('TESTNET_DEFAULT_SMARTWALLET_ADDRESS', '0xfee33972f37ec3a85254a4cda60b2b6adeeb7e12');
setDefault('UNIVERSAL_CONTRACT_DEPLOYER', '0xd4381E45cdBC31ABC8e413638b84e6FaE2138F2d');
