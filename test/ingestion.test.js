import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';

import { app } from '../src/app.js';
import { config } from '../src/config/config.js';
import { pool, cleanDB, closeAll, getTxn, insertTestTxn } from './helpers/setup.js';

// A syntactically valid POST body. Each test overrides only the field it probes,
// so a failure points at exactly one validation/persistence rule.
function validBody(overrides = {}) {
  return {
    functionSignature: 'transfer(address,uint256)',
    contractAddress: '0x2222222222222222222222222222222222222222',
    chainId: 80002,
    args: ['0x3333333333333333333333333333333333333333', '1000'],
    ...overrides,
  };
}

async function countRows() {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM smart_wallet_transactions');
  return rows[0].n;
}

// Hooks are registered ONCE at file scope. A describe-scoped afterAll runs when
// that block finishes, so closing the pools inside the first describe would
// break the second. beforeEach still runs before every individual test.
beforeEach(cleanDB);
afterAll(closeAll);

describe('Layer 2 — ingestion: POST /queue/transaction', () => {
  describe('happy path + persistence', () => {
    it('valid request -> 200 and a faithful row in the DB', async () => {
      const body = validBody();
      const res = await request(app).post('/queue/transaction').send(body);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.status).toBe('queued');
      expect(res.body.queue_id).toBeDefined();

      // The response only echoes a queue_id; the contract is what got PERSISTED,
      // because that row is what the dispatcher will later read and send.
      const row = await getTxn(res.body.queue_id);
      expect(row).not.toBeNull();
      expect(row.status).toBe('queued');
      expect(row.transaction_type).toBe('call');
      expect(row.chain_id).toBe(80002);
      expect(row.target_contract).toBe(body.contractAddress);
      expect(row.function_signature).toBe(body.functionSignature);
      expect(row.args).toEqual(body.args);
      // Chain defaults are filled in from chainInfo, not from the request.
      expect(row.entry_point_address).toBe(config.testnetEntryPointAddress);
      expect(row.paymaster_address).toBe(config.testnetPaymasterAddress);
      // queue_id mirrors id (legacy external identifier).
      expect(row.queue_id).toBe(row.id);
    });

    it('empty smartWallet -> resolved to the chain default', async () => {
      const res = await request(app).post('/queue/transaction').send(validBody({ smartWallet: '' }));
      expect(res.status).toBe(200);

      const row = await getTxn(res.body.queue_id);
      expect(row.smart_wallet_address).toBe(config.defaultTestnetSmartWalletAddress);
    });

    it('provided smartWallet -> stored as-is', async () => {
      const wallet = '0xAbC0000000000000000000000000000000000001';
      const res = await request(app)
        .post('/queue/transaction')
        .send(validBody({ smartWallet: wallet }));
      expect(res.status).toBe(200);

      const row = await getTxn(res.body.queue_id);
      expect(row.smart_wallet_address).toBe(wallet);
    });

    it("default transactionType is 'call' when omitted", async () => {
      const res = await request(app).post('/queue/transaction').send(validBody());
      expect(res.status).toBe(200);

      const row = await getTxn(res.body.queue_id);
      expect(row.transaction_type).toBe('call');
    });

    it("valid 'deploy' transactionType -> accepted and stored", async () => {
      const res = await request(app)
        .post('/queue/transaction')
        .send(validBody({ transactionType: 'deploy' }));
      expect(res.status).toBe(200);

      const row = await getTxn(res.body.queue_id);
      expect(row.transaction_type).toBe('deploy');
    });
  });

  describe('rejections (each is one malformed KWALA payload)', () => {
    it('missing functionSignature -> 400 and NO row written', async () => {
      const body = validBody();
      delete body.functionSignature;
      const res = await request(app).post('/queue/transaction').send(body);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('VALIDATION_ERROR');
      // A rejected request must leave the queue untouched — no poisoned partial row.
      expect(await countRows()).toBe(0);
    });

    it('missing contractAddress -> 400 and NO row written', async () => {
      const body = validBody();
      delete body.contractAddress;
      const res = await request(app).post('/queue/transaction').send(body);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('VALIDATION_ERROR');
      expect(await countRows()).toBe(0);
    });

    it('invalid contractAddress format -> 400', async () => {
      const res = await request(app)
        .post('/queue/transaction')
        .send(validBody({ contractAddress: '0x123' }));

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('VALIDATION_ERROR');
      expect(await countRows()).toBe(0);
    });

    it('missing chainId -> 400', async () => {
      const body = validBody();
      delete body.chainId;
      const res = await request(app).post('/queue/transaction').send(body);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('VALIDATION_ERROR');
    });

    it('unsupported chainId -> 400 (no entry_point/paymaster config for it)', async () => {
      const res = await request(app)
        .post('/queue/transaction')
        .send(validBody({ chainId: 999999 }));

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('VALIDATION_ERROR');
      expect(res.body.message).toMatch(/Unsupported chainId/);
    });

    it('invalid smartWallet format -> 400', async () => {
      const res = await request(app)
        .post('/queue/transaction')
        .send(validBody({ smartWallet: 'not-an-address' }));

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('VALIDATION_ERROR');
    });

    it('args not an array -> 400', async () => {
      const res = await request(app)
        .post('/queue/transaction')
        .send(validBody({ args: 'transfer' }));

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('VALIDATION_ERROR');
    });

    it('invalid transactionType -> 400', async () => {
      const res = await request(app)
        .post('/queue/transaction')
        .send(validBody({ transactionType: 'destroy' }));

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('VALIDATION_ERROR');
    });
  });
});

describe('Layer 2 — ingestion: GET /queue/transaction/:queueId', () => {
  it('existing transaction -> 200 with the fields KWALA polls on', async () => {
    const wallet = '0x4444444444444444444444444444444444444444';
    const id = await insertTestTxn({ smart_wallet_address: wallet, status: 'queued' });

    const res = await request(app).get(`/queue/transaction/${id}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(id);
    expect(res.body.status).toBe('queued');
    expect(res.body.smartWallet).toBe(wallet);
    // chainId is coerced back to a Number in the response.
    expect(res.body.chainId).toBe(80002);
    expect(typeof res.body.chainId).toBe('number');
    expect(res.body.createdAt).toBeDefined();
    expect(res.body.updatedAt).toBeDefined();
  });

  it('nonexistent transaction -> 404 (distinct from 200 so KWALA can tell them apart)', async () => {
    const res = await request(app).get(
      '/queue/transaction/00000000-0000-0000-0000-000000000000'
    );

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });
});
