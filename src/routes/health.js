import { Router } from 'express';
import { healthCheck } from '../utils/db.js';
import { logger } from '../utils/logger.js';

export const healthRouter = Router();

healthRouter.get('/health', async (req, res) => {
  try {
    await healthCheck();
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  } catch (err) {
    logger.error('Health check failed', err);
    res.status(503).json({ status: 'unavailable', timestamp: new Date().toISOString() });
  }
});
