import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, closePool } from '../src/utils/db.js';
import { logger } from '../src/utils/logger.js';

const migrationsDir = path.dirname(fileURLToPath(import.meta.url));

const files = (await readdir(migrationsDir))
  .filter((f) => f.endsWith('.sql'))
  .sort();

try {
  for (const file of files) {
    const sql = await readFile(path.join(migrationsDir, file), 'utf8');
    await pool.query(sql);
    logger.info('Migration applied', { file });
  }
} catch (err) {
  logger.error('Migration failed', err);
  process.exitCode = 1;
} finally {
  await closePool();
}
