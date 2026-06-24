import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import {
  pool,
  cleanDB,
  closeAll,
  insertTestTxn,
  getTxn,
  getTxnsForWallet,
} from './helpers/setup.js';

describe('Layer 1 — test infrastructure smoke test', () => {
  beforeEach(cleanDB);
  afterAll(closeAll);

  it('connects to the test DB', async () => {
    const { rows } = await pool.query('SELECT 1 AS ok');
    expect(rows[0].ok).toBe(1);
  });

  it('inserts a row and reads it back with the expected defaults', async () => {
    const id = await insertTestTxn();
    const row = await getTxn(id);

    expect(row).not.toBeNull();
    expect(row.id).toBe(id);
    expect(row.queue_id).toBe(id);
    expect(row.status).toBe('queued');
    expect(row.transaction_type).toBe('call');
    expect(row.chain_id).toBe(80002);
    // args round-trips through JSONB as a real array, not a string.
    expect(Array.isArray(row.args)).toBe(true);
  });

  it('respects overrides, including a back-dated created_at', async () => {
    const old = new Date('2020-01-01T00:00:00Z');
    const id = await insertTestTxn({
      smart_wallet_address: '0xabc0000000000000000000000000000000000001',
      status: 'sent',
      created_at: old,
    });

    const row = await getTxn(id);
    expect(row.status).toBe('sent');
    expect(row.smart_wallet_address).toBe('0xabc0000000000000000000000000000000000001');
    expect(new Date(row.created_at).getTime()).toBe(old.getTime());
  });

  it('getTxnsForWallet returns only that wallet, oldest first', async () => {
    const wallet = '0xdef0000000000000000000000000000000000002';
    await insertTestTxn({ smart_wallet_address: wallet, created_at: new Date('2021-01-02') });
    await insertTestTxn({ smart_wallet_address: wallet, created_at: new Date('2021-01-01') });
    await insertTestTxn({ smart_wallet_address: '0x9990000000000000000000000000000000000003' });

    const rows = await getTxnsForWallet(wallet);
    expect(rows).toHaveLength(2);
    expect(new Date(rows[0].created_at).getTime()).toBeLessThan(
      new Date(rows[1].created_at).getTime()
    );
  });

  it('the status enum rejects an unknown value (schema is faithful, not a loose VARCHAR)', async () => {
    await expect(insertTestTxn({ status: 'not_a_real_status' })).rejects.toThrow();
  });
});
