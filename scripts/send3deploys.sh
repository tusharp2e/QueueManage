#!/usr/bin/env bash
# Send 3 deploys in ONE batch (distinct traceIds, same payload) to test the
# bundler's per-op deployed_address resolution.
#
# IMPORTANT: run when the Sepolia default wallet is FREE (no in-flight tx for it),
# so all 3 queue before the next dispatcher tick and form a single batch.
#
# Requires: curl, jq. Run from the QueueManager dir (or set PAYLOAD).
#   ./scripts/send3deploys.sh
#   QM_URL=http://localhost:3000 CHAIN_ID=11155111 ./scripts/send3deploys.sh
set -euo pipefail

QM_URL="${QM_URL:-http://localhost:3000}"
PAYLOAD="${PAYLOAD:-scripts/deploy-payload.json}"   # { abiEncoded, bytecode, constructorArgs }
CHAIN_ID="${CHAIN_ID:-11155111}"                     # 11155111=sepolia, 80002=amoy

echo "Submitting 3 deploys concurrently to $QM_URL (chainId=$CHAIN_ID) ..."
for i in 1 2 3; do
  TRACE=$(cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen)
  BODY=$(jq -c --arg t "$TRACE" --argjson c "$CHAIN_ID" \
    '{abiEncoded:.abiEncoded, bytecode:.bytecode, constructorArgs:.constructorArgs, chainId:$c, traceId:$t, smartWallet:""}' \
    "$PAYLOAD")
  curl -s -X POST "$QM_URL/queue/deploy" -H 'Content-Type: application/json' -d "$BODY" \
    | jq -c --arg t "$TRACE" '{traceId:$t, queue_id:.queue_id, status:.status}' &
done
wait
echo "All 3 submitted. They should batch into one handleOps (wallet was free)."
echo "After ~40s, verify with:  node scripts/check3deploys.js"
