import dotenv from 'dotenv';

dotenv.config();

export const config = {
  port: Number(process.env.PORT) || 3000,

  db: {
    user: process.env.POSTGRES_USER,
    host: process.env.POSTGRES_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: Number(process.env.DB_PORT) || 5432,
  },

  bundlerUrl: process.env.BUNDLER_URL,
  bundlerAuthToken: process.env.BUNDLER_AUTH_TOKEN,

  dispatcherIntervalMs: Number(process.env.DISPATCHER_INTERVAL_MS) || 5000,
  maxBatchSize: Number(process.env.MAX_BATCH_SIZE) || 10,

  staleIntervalMs: Number(process.env.STALE_INTERVAL_MS) || 60000,
  staleTimeoutMinutes: Number(process.env.STALE_TIMEOUT_MINUTES) || 5,

  testnetEntryPointAddress: process.env.TESTNET_ENTRYPOINT_ADDRESS,
  testnetPaymasterAddress: process.env.TESTNET_PAYMASTER_ADDRESS,
  defaultTestnetSmartWalletAddress: process.env.TESTNET_DEFAULT_SMARTWALLET_ADDRESS,
  universalContractDeployer: process.env.UNIVERSAL_CONTRACT_DEPLOYER,
};

const requiredVars = [
  'POSTGRES_USER',
  'POSTGRES_HOST',
  'DB_NAME',
  'DB_PASSWORD',
  'BUNDLER_URL',
  'BUNDLER_AUTH_TOKEN',
  'TESTNET_ENTRYPOINT_ADDRESS',
  'TESTNET_PAYMASTER_ADDRESS',
  'TESTNET_DEFAULT_SMARTWALLET_ADDRESS',
];

const missing = requiredVars.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(`Missing required environment variables: ${missing.join(', ')}`);
  process.exit(1);
}
