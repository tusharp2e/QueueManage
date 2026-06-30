import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

import { sendBatchToBundler, BundlerError } from '../src/services/dispatchToBundler.js';
import { config, createMockBundler, closeAll } from './helpers/setup.js';

// A realistic batch payload, shaped like dispatcher.js's buildBatchPayload output.
function sampleBatch() {
  return {
    batchId: '11111111-1111-1111-1111-111111111111',
    smartWallet: '0x1111111111111111111111111111111111111111',
    chainId: 80002,
    transactions: [
      {
        id: '22222222-2222-2222-2222-222222222222',
        contractAddress: '0x2222222222222222222222222222222222222222',
        functionSignature: 'transfer(address,uint256)',
        args: ['0x3333333333333333333333333333333333333333', '1000'],
        transactionType: 'call',
        paymasterAddress: config.testnetPaymasterAddress,
        entryPointAddress: config.testnetEntryPointAddress,
      },
    ],
  };
}

const bundler = createMockBundler();
let originalBundlerUrl;

beforeAll(async () => {
  await bundler.start(); // ephemeral port
  originalBundlerUrl = config.bundlerUrl;
});

afterAll(async () => {
  config.bundlerUrl = originalBundlerUrl; // restore shared config
  await bundler.stop();
  await closeAll();
});

beforeEach(() => {
  // Point the client at the live mock and reset behavior/recording per test.
  config.bundlerUrl = bundler.url();
  bundler.acceptAll();
  bundler.clearReceived();
});

describe('Layer 3 — Bundler client: sendBatchToBundler', () => {
  it('200 -> returns the parsed Bundler response and forwards the exact payload', async () => {
    const batch = sampleBatch();
    const result = await sendBatchToBundler(batch);

    // The Bundler's JSON body is surfaced to the caller (acceptAll -> ACCEPTED).
    expect(result).toEqual({ status: 'ACCEPTED' });

    // The Bundler received exactly one call, byte-for-byte the batch we sent.
    const received = bundler.getReceivedBatches();
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(batch);
  });

  it('200 -> sends the auth token and JSON content-type headers', async () => {
    // The real Bundler rejects unauthenticated calls; prove auth is wired.
    let captured;
    bundler.setHandler((req, res) => {
      captured = req.headers;
      res.status(200).json({ status: 'ACCEPTED' });
    });

    await sendBatchToBundler(sampleBatch());

    expect(captured.authorization).toBe(config.bundlerAuthToken);
    expect(captured['content-type']).toMatch(/application\/json/);
  });

  it('500 -> throws BundlerError with kind "http_5xx" (drives revert + retry)', async () => {
    bundler.rejectAll(); // 500

    const err = await sendBatchToBundler(sampleBatch()).catch((e) => e);
    expect(err).toBeInstanceOf(BundlerError);
    expect(err.kind).toBe('http_5xx');
    expect(err.status).toBe(500);
  });

  it('400 -> throws BundlerError with kind "http_4xx" (malformed payload, not an outage)', async () => {
    bundler.setHandler((_req, res) => res.status(400).json({ error: 'BAD_REQUEST' }));

    const err = await sendBatchToBundler(sampleBatch()).catch((e) => e);
    expect(err).toBeInstanceOf(BundlerError);
    expect(err.kind).toBe('http_4xx');
    expect(err.status).toBe(400);
  });

  it('no response -> throws BundlerError with kind "timeout"', async () => {
    bundler.timeout(); // accepts the connection but never responds

    // The abort deadline is now config-driven (BUNDLER_TIMEOUT_MS), pinned to
    // 200ms in vitest.config — so this exercises the real timeout path quickly,
    // no stubbing required.
    const err = await sendBatchToBundler(sampleBatch()).catch((e) => e);
    expect(err).toBeInstanceOf(BundlerError);
    expect(err.kind).toBe('timeout');
  });

  it('connection refused -> throws BundlerError with kind "network"', async () => {
    // Bind a port, capture it, then free it: connecting now yields ECONNREFUSED
    // deterministically (we know nothing is listening on a port we just held).
    const temp = createMockBundler();
    await temp.start();
    const deadUrl = temp.url();
    await temp.stop();
    config.bundlerUrl = deadUrl;

    const err = await sendBatchToBundler(sampleBatch()).catch((e) => e);
    expect(err).toBeInstanceOf(BundlerError);
    expect(err.kind).toBe('network');
  });
});
