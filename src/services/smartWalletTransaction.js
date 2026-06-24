import { randomUUID } from 'node:crypto';
import { pool } from '../utils/db.js';
import { chainInfo } from '../config/chainInfo.js';

// nonce is NOT NULL in the shared schema but is genuinely set by the Bundler
// later, so we write a placeholder at queue time. It is never read by the
// Queue Manager (the Bundler dispatch payload does not include nonce).
const NONCE_PLACEHOLDER = '0';

const INSERT_SQL = `
  INSERT INTO smart_wallet_transactions
    (id, queue_id, status, transaction_type, chain_id,
     entry_point_address, paymaster_address, smart_wallet_address,
     target_contract, function_signature, args, nonce,
     created_at, updated_at)
  VALUES
    ($1, $2, 'queued', $3, $4,
     $5, $6, $7,
     $8, $9, $10::jsonb, $11,
     NOW(), NOW())
  RETURNING id, queue_id, status, smart_wallet_address, chain_id, created_at, updated_at
`;

/**
 * Persists a new transaction as 'queued'.
 *
 * @param {object} input - already-validated request fields
 * @param {string} input.functionSignature
 * @param {Array}  input.args
 * @param {string} input.contractAddress
 * @param {number} input.chainId            - guaranteed present in chainInfo
 * @param {string} [input.smartWallet]      - empty/absent => chain default
 * @param {string} [input.transactionType]  - 'call' | 'deploy', defaults to 'call'
 * @returns {Promise<object>} the inserted row (DB column names)
 */
export async function createTransaction(input) {
  const chain = chainInfo[input.chainId];

  const smartWallet =
    input.smartWallet && input.smartWallet.trim() !== ''
      ? input.smartWallet.trim()
      : chain.smartWallet;

  const id = randomUUID();

  const params = [
    id, // $1  id
    id, // $2  queue_id (legacy external identifier = id)
    input.transactionType || 'call', // $3  transaction_type
    input.chainId, // $4  chain_id
    chain.entryPoint, // $5  entry_point_address
    chain.paymasterAddress, // $6  paymaster_address
    smartWallet, // $7  smart_wallet_address
    input.contractAddress, // $8  target_contract
    input.functionSignature, // $9  function_signature
    JSON.stringify(input.args ?? []), // $10 args (jsonb)
    NONCE_PLACEHOLDER, // $11 nonce
  ];

  const { rows } = await pool.query(INSERT_SQL, params);
  return rows[0];
}

const SELECT_BY_QUEUE_ID_SQL = `
  SELECT id, queue_id, status, smart_wallet_address, chain_id, created_at, updated_at
  FROM smart_wallet_transactions
  WHERE queue_id = $1
`;

/**
 * Looks up a transaction by its external queue_id.
 * @returns {Promise<object|null>} the row, or null if not found
 */
export async function getTransactionByQueueId(queueId) {
  const { rows } = await pool.query(SELECT_BY_QUEUE_ID_SQL, [queueId]);
  return rows[0] ?? null;
}
