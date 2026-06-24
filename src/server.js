import { app } from './app.js';
import { config } from './config/config.js';
import { logger } from './utils/logger.js';
import { healthCheck, closePool } from './utils/db.js';
import { startDispatcher, stopDispatcher } from './jobs/dispatcher.js';
import { startStaleDetector, stopStaleDetector } from './jobs/staleDetector.js';

// Fail fast if the DB is unreachable at boot — this service is useless without
// it, and a clean crash-at-startup beats accepting work we can't dispatch.
try {
  await healthCheck();
  logger.info('Database connection OK');
} catch (err) {
  logger.error('Database unreachable at startup', err);
  process.exit(1);
}

const server = app.listen(config.port, () => {
  logger.info('Queue Manager listening', { port: config.port });
});

startDispatcher();
startStaleDetector();

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('Shutting down gracefully', { signal });

  // Backstop: if draining hangs (e.g. a stuck keep-alive socket), force exit.
  const forceExit = setTimeout(() => {
    logger.error('Graceful shutdown timed out after 10s, forcing exit');
    process.exit(1);
  }, 10000);
  forceExit.unref();

  try {
    // Order matters — reverse of dependency:
    // 1. Stop background loops, draining any in-flight tick/sweep so we never
    //    abandon a half-done dispatch.
    await Promise.all([stopDispatcher(), stopStaleDetector()]);
    // 2. Stop accepting HTTP and let in-flight requests finish.
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    // 3. Close the pool last — nothing else needs the DB now.
    await closePool();
    logger.info('Shutdown complete');
  } catch (err) {
    logger.error('Error during shutdown', err);
    process.exitCode = 1;
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
