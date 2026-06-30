import { Router } from 'express';
import { createDeployTransaction } from '../services/smartWalletTransaction.js';
import { chainInfo } from '../config/chainInfo.js';
import { logger } from '../utils/logger.js';

export const deployRouter = Router();

const ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;

// Returns an array of human-readable validation errors (empty => valid).
function validate(body) {
  const errors = [];

  if (typeof body.abiEncoded !== 'string' || body.abiEncoded.trim() === '') {
    errors.push('abiEncoded is required and must be a non-empty base64 string');
  }
  if (typeof body.bytecode !== 'string' || body.bytecode.trim() === '') {
    errors.push('bytecode is required and must be a non-empty string');
  }
  if (!Array.isArray(body.constructorArgs)) {
    errors.push('constructorArgs is required and must be an array (use [] for none)');
  }
  if (typeof body.traceId !== 'string' || body.traceId.trim() === '') {
    errors.push('traceId is required and must be a non-empty string');
  }
  if (!Number.isInteger(body.chainId)) {
    errors.push('chainId is required and must be an integer');
  } else if (!chainInfo[body.chainId]) {
    errors.push(`Unsupported chainId: ${body.chainId}`);
  }
  if (
    body.smartWallet !== undefined &&
    body.smartWallet !== '' &&
    !ADDRESS_REGEX.test(body.smartWallet)
  ) {
    errors.push('smartWallet, when provided, must be a 0x-prefixed 20-byte hex address');
  }

  return errors;
}

deployRouter.post('/queue/deploy', async (req, res) => {
  const body = req.body ?? {};

  const errors = validate(body);
  if (errors.length > 0) {
    return res.status(400).json({ success: false, error: 'VALIDATION_ERROR', message: errors.join('; ') });
  }

  try {
    const row = await createDeployTransaction(body);
    logger.info('Deploy transaction queued', {
      id: row.id,
      smartWallet: row.smart_wallet_address,
      chainId: body.chainId,
      traceId: body.traceId,
    });
    return res.status(200).json({
      success: true,
      queue_id: row.queue_id,
      status: row.status,
    });
  } catch (err) {
    logger.error('Failed to queue deploy transaction', err);
    return res.status(500).json({ success: false, error: 'INTERNAL_ERROR', message: 'Failed to queue deploy transaction' });
  }
});