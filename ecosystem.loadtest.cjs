// PM2 config for the load test.  Start:  pm2 start ecosystem.loadtest.cjs
// CommonJS (.cjs) on purpose — package.json is "type": "module".
module.exports = {
  apps: [
    {
      name: 'qm-loadtest',
      script: 'scripts/loadTest.js',
      cwd: __dirname, // project root, so dotenv finds .env
      autorestart: false, // self-stops when done; don't relaunch
      time: true, // timestamp each log line
      kill_timeout: 15000, // let the final CSV write + report finish on `pm2 stop`
      env: {
        QM_URL: 'http://localhost:3000',
        CHAINS: '80002,11155111', // Amoy + Ethereum Sepolia
        COUNT: '5', // txns per chain
        INTERVAL_MS: '5000',
        FUNCTION_SIGNATURE: 'function increment()',
        SMART_WALLET: '', // '' => chain default
        DRAIN_TIMEOUT_MS: String(45 * 60 * 1000), // generous: let slow Sepolia txns reach terminal
        POLL_INTERVAL_MS: '10000',
        // Per-chain target contracts are baked into the script as defaults:
        //   80002    -> 0xD3601131e5b98fab6326CC795e171252bA2Ae86C
        //   11155111 -> 0x98F811D169F8A87AF29015ac170B709135c5CC07
        // Override with CONTRACT_<chainId> if needed.
        // CSV_PATH: 'loadtest-results.csv',  // default: loadtest-<timestamp>.csv
      },
    },
  ],
};
