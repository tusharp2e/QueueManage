import { Router } from 'express';
import { createTransaction, getTransactionByQueueId } from '../services/smartWalletTransaction.js';
import { chainInfo } from '../config/chainInfo.js';
import { logger } from '../utils/logger.js';

export const transactionRouter = Router();

const ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;
const VALID_TYPES = ['call', 'deploy'];

// Returns an array of human-readable validation errors (empty => valid).
function validate(body) {
  const errors = [];

  if (typeof body.functionSignature !== 'string' || body.functionSignature.trim() === '') {
    errors.push('functionSignature is required and must be a non-empty string');
  }

  if (body.args !== undefined && !Array.isArray(body.args)) {
    errors.push('args must be an array');
  }

  if (typeof body.contractAddress !== 'string' || !ADDRESS_REGEX.test(body.contractAddress)) {
    errors.push('contractAddress is required and must be a 0x-prefixed 20-byte hex address');
  }

  if (!Number.isInteger(body.chainId)) {
    errors.push('chainId is required and must be an integer');
  } else if (!chainInfo[body.chainId]) {
    errors.push(`Unsupported chainId: ${body.chainId}`);
  }

  // smartWallet is optional; empty string means "use chain default".
  if (
    body.smartWallet !== undefined &&
    body.smartWallet !== '' &&
    !ADDRESS_REGEX.test(body.smartWallet)
  ) {
    errors.push('smartWallet, when provided, must be a 0x-prefixed 20-byte hex address');
  }

  if (body.transactionType !== undefined && !VALID_TYPES.includes(body.transactionType)) {
    errors.push("transactionType, when provided, must be 'call' or 'deploy'");
  }

  return errors;
}

transactionRouter.post('/queue/transaction', async (req, res) => {
  const body = req.body;

  const errors = validate(body);
  if (errors.length > 0) {
    return res.status(400).json({ success: false, error: 'VALIDATION_ERROR', message: errors.join('; ') });
  }

  try {
    const row = await createTransaction(body);
    logger.info('Transaction queued', {
      id: row.id,
      smartWallet: row.smart_wallet_address,
      chainId: body.chainId,
    });
    return res.status(200).json({
      success: true,
      queue_id: row.queue_id,
      status: row.status,
    });
  } catch (err) {
    logger.error('Failed to queue transaction', err);
    return res.status(500).json({ success: false, error: 'INTERNAL_ERROR', message: 'Failed to queue transaction' });
  }
});

transactionRouter.get('/queue/transaction/:queueId', async (req, res) => {
  try {
    const row = await getTransactionByQueueId(req.params.queueId);
    if (!row) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Transaction not found' });
    }
    return res.status(200).json({
      id: row.id,
      status: row.status,
      smartWallet: row.smart_wallet_address,
      chainId: Number(row.chain_id),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  } catch (err) {
    logger.error('Failed to fetch transaction', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to fetch transaction' });
  }
});
