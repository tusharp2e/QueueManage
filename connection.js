import pg from "pg";
import dotenv from "dotenv";
import { logger } from "./lib/logger.js";
dotenv.config();

const { Pool } = pg;

// Create a connection pool
const pool = new Pool({
  user: process.env.POSTGRES_USER,
  host: process.env.POSTGRES_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
  ssl: {
    rejectUnauthorized: false
  }
});

async function connectDB() {
  try {
    const client = await pool.connect();
    logger.info("PostgreSQL connected successfully");
    client.release();
  } catch (err) {
    logger.error("PostgreSQL connection error:", err.stack);
  }
}

connectDB();

export default pool;
