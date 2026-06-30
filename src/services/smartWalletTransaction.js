import { randomUUID } from 'node:crypto';
import { pool } from '../utils/db.js';
import { chainInfo } from '../config/chainInfo.js';
import { config } from '../config/config.js';
import { contractDeployviaSW } from '../utils/deployBytecode.js';

// nonce is NOT NULL in the shared schema but is genuinely set by the Bundler
// later, so we write a placeholder at queue time. It is never read by the
// Queue Manager (the Bundler dispatch payload does not include nonce).
const NONCE_PLACEHOLDER = '0';

// A deploy is dispatched as a CALL to the universal deployer contract's
// deploy(traceId, bytecode) function — the Bundler/EntryPoint build the UserOp
// exactly as for any call, and resolve the deployed address from the event.
const DEPLOY_FUNCTION_SIGNATURE = 'function deploy(string memory traceId, bytes memory bytecode)';

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

/**
 * Persists a contract deployment as a 'queued' deploy transaction.
 *
 * A deploy is modeled as a call to the universal deployer contract:
 *   target_contract   = config.universalContractDeployer
 *   function_signature= deploy(string traceId, bytes bytecode)
 *   args              = [traceId, <bytecode + abi-encoded constructor args>]
 *   transaction_type  = 'deploy'
 *
 * Inserts the smart_wallet_transactions row AND the smart_wallet_deployments
 * row (tx_id, constructor_args) atomically. The Bundler later fills
 * deployed_address from the on-chain Deployed event.
 *
 * @param {object} input - already-validated request fields
 * @param {string} input.abiEncoded       - base64-encoded ABI JSON
 * @param {string} input.bytecode         - contract creation bytecode
 * @param {Array}  input.constructorArgs
 * @param {number} input.chainId          - guaranteed present in chainInfo
 * @param {string} input.traceId          - required, supplied by KWALA
 * @param {string} [input.smartWallet]    - empty/absent => chain default
 * @returns {Promise<object>} the inserted transaction row (DB column names)
 */
export async function createDeployTransaction(input) {
  const chain = chainInfo[input.chainId];

  const smartWallet =
    input.smartWallet && input.smartWallet.trim() !== ''
      ? input.smartWallet.trim()
      : chain.smartWallet;

  const deployBytecode = contractDeployviaSW({
    bytecode: input.bytecode,
    abiEncoded: input.abiEncoded,
    constructorArgs: input.constructorArgs,
  });

  const id = randomUUID();
  const args = [input.traceId, deployBytecode];

  const txParams = [
    id, // $1  id
    id, // $2  queue_id
    'deploy', // $3  transaction_type
    input.chainId, // $4  chain_id
    chain.entryPoint, // $5  entry_point_address
    chain.paymasterAddress, // $6  paymaster_address
    smartWallet, // $7  smart_wallet_address
    config.universalContractDeployer, // $8  target_contract (the deployer)
    DEPLOY_FUNCTION_SIGNATURE, // $9  function_signature
    JSON.stringify(args), // $10 args (jsonb): [traceId, deployBytecode]
    NONCE_PLACEHOLDER, // $11 nonce
  ];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(INSERT_SQL, txParams);
    await client.query(
      `INSERT INTO smart_wallet_deployments (tx_id, constructor_args, deployed_address)
       VALUES ($1, $2::jsonb, NULL)`,
      [id, JSON.stringify(input.constructorArgs ?? [])]
    );
    await client.query('COMMIT');
    return rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
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
