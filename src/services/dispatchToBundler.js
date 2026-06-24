import { config } from '../config/config.js';

// How long a single dispatch call may take before we give up. Bounds how long
// a hung Bundler can wedge a wallet's pipeline (its txns sit in DISPATCHED).
// Promote to config if it needs to vary per environment.
const BUNDLER_TIMEOUT_MS = 120000;

/**
 * Error thrown for any failed Bundler call. `kind` lets the caller log/meter
 * failure modes distinctly, though all kinds currently trigger the same revert.
 * @typedef {'timeout'|'network'|'http_4xx'|'http_5xx'} BundlerErrorKind
 */
export class BundlerError extends Error {
  /** @param {string} message @param {BundlerErrorKind} kind @param {object} [meta] */
  constructor(message, kind, meta = {}) {
    super(message);
    this.name = 'BundlerError';
    this.kind = kind;
    this.status = meta.status;
    this.responseBody = meta.responseBody;
  }
}

/**
 * Sends one batch to the Bundler. Exactly one attempt — retry policy belongs
 * to the dispatcher loop, not here.
 *
 * @param {object} batch - { batchId, smartWallet, chainId, transactions: [...] }
 * @returns {Promise<object>} the Bundler's parsed JSON response on 2xx
 * @throws {BundlerError} on timeout, network failure, or non-2xx response
 */
export async function sendBatchToBundler(batch) {
  let res;
  try {
    res = await fetch(config.bundlerUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: config.bundlerAuthToken,
      },
      body: JSON.stringify(batch),
      // Self-aborting signal: cancels the request after the deadline so a hung
      // Bundler can't wedge a wallet's pipeline. Replaces the manual
      // AbortController + setTimeout + clearTimeout dance.
      signal: AbortSignal.timeout(BUNDLER_TIMEOUT_MS),
    });
  } catch (err) {
    // fetch rejects on timeout (TimeoutError) or low-level network failure
    // (DNS, connection refused, reset). Both mean "the call did not complete".
    if (err.name === 'TimeoutError') {
      throw new BundlerError(`Bundler call timed out after ${BUNDLER_TIMEOUT_MS}ms`, 'timeout');
    }
    throw new BundlerError(`Bundler unreachable: ${err.message}`, 'network');
  }

  if (!res.ok) {
    // Read the body best-effort for diagnostics; never let it mask the status.
    const responseBody = await res.text().catch(() => '');
    const kind = res.status >= 500 ? 'http_5xx' : 'http_4xx';
    throw new BundlerError(`Bundler responded ${res.status}`, kind, {
      status: res.status,
      responseBody: responseBody.slice(0, 500),
    });
  }

  return res.json().catch(() => ({}));
}
