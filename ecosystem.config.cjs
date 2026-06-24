// PM2 config for the Queue Manager service.  Start:  pm2 start ecosystem.config.cjs
// CommonJS (.cjs) on purpose — package.json is "type": "module".
module.exports = {
  apps: [
    {
      name: 'queue-manager',
      script: 'src/server.js',
      cwd: __dirname, // project root, so dotenv finds .env

      // MUST be a single instance. Cluster mode / instances > 1 would run
      // multiple dispatchers against the same DB and double-dispatch batches.
      instances: 1,
      exec_mode: 'fork',

      autorestart: true, // long-running service — restart on crash
      time: true, // timestamp each log line
      kill_timeout: 12000, // > the server's 10s graceful-shutdown backstop

      // All config (PORT, DB, BUNDLER_URL, ...) is read from .env by the app.
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
