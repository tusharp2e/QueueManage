import pg from 'pg';
import { config } from '../config/config.js';
import { logger } from './logger.js';

const { Pool } = pg;

export const pool = new Pool({
  user: config.db.user,
  host: config.db.host,
  database: config.db.database,
  password: config.db.password,
  port: config.db.port,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// An idle client emitting 'error' (e.g. RDS failover, network blip) would
// otherwise crash the process as an unhandled error event.
pool.on('error', (err) => {
  logger.error('Unexpected error on idle PostgreSQL client', err);
});

export async function healthCheck() {
  await pool.query('SELECT 1');
}

export async function closePool() {
  await pool.end();
  logger.info('PostgreSQL pool closed');
}
