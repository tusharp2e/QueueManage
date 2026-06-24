// End-to-end batch test client for the Queue Manager.
//
// Sends N transactions for the SAME smart wallet to a running Queue Manager.
// Because the dispatcher batches per wallet (up to MAX_BATCH_SIZE), all N land
// in ONE batch (as long as N <= MAX_BATCH_SIZE and they're posted before the
// next dispatcher tick). Pure HTTP client — does not touch the DB.
//
// Usage (start the QM server first):
//   node scripts/sendTestBatch.js
//   COUNT=8 SMART_WALLET=0xYourWallet QM_URL=http://localhost:3000 node scripts/sendTestBatch.js
//   POLL=false node scripts/sendTestBatch.js     # just enqueue, don't watch
//
// To confirm they landed in a single batch: the Bundler should receive ONE call
// containing all N transactions (check its logs), and the rows share one batch_id.

const QM_URL = process.env.QM_URL || 'http://localhost:3000';
const COUNT = Number(process.env.COUNT || 10);
const SMART_WALLET = process.env.SMART_WALLET ?? ''; // '' => chain default; same for all => one batch
const CHAIN_ID = Number(process.env.CHAIN_ID || 80002);
const CONTRACT = process.env.CONTRACT || '0x7Ae020A9423d63315F2266d53bBE50ee4749e7Fb';
const FUNCTION_SIGNATURE = process.env.FUNCTION_SIGNATURE || 'function set(uint256 x)';
const POLL = process.env.POLL !== 'false';
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 3000);
const POLL_TIMEOUT_MS = Number(process.env.POLL_TIMEOUT_MS || 90000);

const TERMINAL = new Set(['success', 'failed', 'execution_failed', 'validation_failed']);

async function postTxn(i) {
  const res = await fetch(`${QM_URL}/queue/transaction`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      functionSignature: FUNCTION_SIGNATURE,
      args: [i],
      contractAddress: CONTRACT,
      chainId: CHAIN_ID,
      smartWallet: SMART_WALLET,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`status ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

async function getStatus(queueId) {
  const res = await fetch(`${QM_URL}/queue/transaction/${queueId}`);
  if (!res.ok) return { status: `ERR_${res.status}` };
  return res.json();
}

function countByStatus(rows) {
  return rows.reduce((acc, r) => ((acc[r.status] = (acc[r.status] || 0) + 1), acc), {});
}

async function main() {
  console.log(`POSTing ${COUNT} txns -> ${QM_URL}`);
  console.log(`wallet="${SMART_WALLET || '<chain default>'}", chain=${CHAIN_ID}`);
  console.log('All share one wallet => the dispatcher should group them into a single batch.\n');

  // Post quickly (concurrently) so they all queue before the next dispatcher tick.
  const settled = await Promise.allSettled(
    Array.from({ length: COUNT }, (_, i) => postTxn(i + 1))
  );

  const ids = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      ids.push(r.value.queue_id);
      console.log(`  #${i + 1} ${r.value.status}  ${r.value.queue_id}`);
    } else {
      console.log(`  #${i + 1} FAILED  ${r.reason.message}`);
    }
  });

  if (ids.length === 0) {
    console.error('\nNothing queued — is the Queue Manager running at ' + QM_URL + ' ?');
    process.exit(1);
  }
  console.log(`\n${ids.length}/${COUNT} queued.`);
  if (!POLL) return;

  console.log('\nPolling status (Ctrl-C to stop)...');
  const start = Date.now();
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const rows = await Promise.all(ids.map(getStatus));
    const elapsed = Math.round((Date.now() - start) / 1000);
    console.log(`  [t+${elapsed}s] ${JSON.stringify(countByStatus(rows))}`);
    if (rows.every((r) => TERMINAL.has(r.status))) {
      console.log('\nAll transactions reached a terminal status.');
      return;
    }
  }
  console.log('\nPoll timeout reached (some txns not yet terminal).');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
