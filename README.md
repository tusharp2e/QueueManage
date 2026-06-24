# queue-manager

Smart wallet transaction queue manager. Sits between KWALA and the Bundler in the ERC-4337 pipeline:

1. Accepts transaction requests from KWALA (`POST /queue/transaction`), persists them as `QUEUED` in the shared `smart_wallet_transactions` table.
2. Every 5 seconds, dispatches batches (up to 10 transactions per wallet) to the Bundler — at most one in-flight batch per wallet.
3. Marks transactions stuck in a non-terminal status for too long as `FAILED`.

No blockchain logic lives here: no RPC calls, no UserOp construction, no signing.

## Setup

```bash
npm install
cp .env.example .env   # fill in real values
npm run dev            # dev with auto-reload
npm start              # production
```

## Structure

```
src/
├── config/      # env validation, per-chain config
├── routes/      # express route handlers
├── jobs/        # dispatcher + stale detector (periodic background loops)
├── services/    # bundler client, transaction persistence
├── utils/       # logger, db pool
└── server.js    # entrypoint
migrations/      # SQL migrations (adds batch_id column + indexes)
```

## Configuration

All configuration is via environment variables — see `.env.example` for the full list. The service exits at startup if a required variable is missing or malformed.

## API

Base URL defaults to `http://localhost:3000` (set via `PORT`). Replace the `<…>` placeholders.

### `GET /health`
```bash
curl -s http://localhost:3000/health
# -> { "status": "ok", "timestamp": "..." }   (503 if the DB is unreachable)
```

### `POST /queue/transaction`
Enqueue a transaction. `smartWallet: ""` resolves to the chain's default wallet.
```bash
curl -s -X POST http://localhost:3000/queue/transaction \
  -H 'Content-Type: application/json' \
  -d '{
    "functionSignature": "<FUNCTION_SIGNATURE>",
    "args": [<ARG1>, <ARG2>],
    "contractAddress": "<0x_CONTRACT_ADDRESS>",
    "chainId": <CHAIN_ID>,
    "smartWallet": "<0x_SMART_WALLET_OR_EMPTY>"
  }'
# -> { "success": true, "queue_id": "<uuid>", "status": "queued" }
# errors -> { "success": false, "error": "VALIDATION_ERROR" | "INTERNAL_ERROR", "message": "..." }
```
Concrete example:
```bash
curl -s -X POST http://localhost:3000/queue/transaction \
  -H 'Content-Type: application/json' \
  -d '{
    "functionSignature": "function set(uint256 x)",
    "args": [115],
    "contractAddress": "0x7Ae020A9423d63315F2266d53bBE50ee4749e7Fb",
    "chainId": 80002,
    "smartWallet": ""
  }'
```

### `GET /queue/transaction/:queueId`
```bash
curl -s http://localhost:3000/queue/transaction/<QUEUE_ID>
# -> { "id", "status", "smartWallet", "chainId", "createdAt", "updatedAt" }   (404 if not found)
```

### Postman
Import `postman/queue-manager.postman_collection.json`. Fill in the collection **Variables** (`baseUrl`, `contractAddress`, `chainId`, `smartWallet`, …) — those are your placeholders. "Queue Transaction" auto-saves the returned `id` into `{{queueId}}`, so "Get Transaction Status" works immediately after.
