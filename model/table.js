import pool from "../connection.js";
import { logger } from "../lib/logger.js";
export async function initTables() {
  logger.info("Initializing database tables...");
  const result = await pool.query(`
    CREATE TABLE IF NOT EXISTS wallet_transactions (
      uuid TEXT PRIMARY KEY,
      functionSignature TEXT,
      args TEXT[],
      contractAddress TEXT,
      chainId TEXT,
      smartWallet TEXT,
      status TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
  if (!result) {
    logger.info("wallet_transactions table not ensured.");
  }
  logger.info("Database tables initialized.");
}