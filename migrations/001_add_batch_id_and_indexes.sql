-- Queue Manager migration 001
-- Adds dispatch support to the existing shared smart_wallet_transactions table.
-- Idempotent: safe to run multiple times.

-- The dispatcher marks claimed transactions 'dispatched'; the enum predates it.
ALTER TYPE smart_wallet_status ADD VALUE IF NOT EXISTS 'dispatched';

-- Groups transactions claimed together for one Bundler call. NULL = not batched.
ALTER TABLE smart_wallet_transactions
  ADD COLUMN IF NOT EXISTS batch_id uuid;

-- Serves the dispatcher's two hot queries:
--   1. wallet discovery:  WHERE status = 'queued'            (index-only scan)
--   2. in-flight check:   WHERE smart_wallet_address = ? AND status IN (...)
CREATE INDEX IF NOT EXISTS idx_swt_status_wallet
  ON smart_wallet_transactions (status, smart_wallet_address);


