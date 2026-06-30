#!/usr/bin/env bash
# Crafts a MIXED batch  [deploy, call, deploy]  in ONE handleOps to break a
# lockstep / "+1 for both" Deployed<->UserOperationEvent pairing in the bundler.
#
# Why it breaks lockstep:
#   on-chain logs come out as
#     Deployed(op0)            <- deploy #1
#     UserOperationEvent(op0)
#     UserOperationEvent(op1)  <- the CALL: a UserOperationEvent with NO Deployed
#     Deployed(op2)            <- deploy #2
#     UserOperationEvent(op2)
#   Deployed list = [op0, op2] ; UserOpEvent list = [op0, op1(call), op2]
#   Lockstep pairs Deployed[1] (op2's addr) with UserOpEvent[1] = the CALL op
#   -> the CALL row wrongly gets a deployed_address, and deploy #2 gets the wrong/none.
#
# Run when the Sepolia default wallet is FREE so all 3 queue before the next tick.
# Requires curl + jq. Run from the project dir (or set PAYLOAD).
set -euo pipefail

QM_URL="${QM_URL:-http://localhost:3000}"
PAYLOAD="${PAYLOAD:-scripts/deploy-payload.json}"
CHAIN_ID="${CHAIN_ID:-11155111}"                                   # sepolia
CALL_CONTRACT="${CALL_CONTRACT:-0x98F811D169F8A87AF29015ac170B709135c5CC07}"  # sepolia increment()

deploy_body () {
  jq -c --arg t "$(cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen)" --argjson c "$CHAIN_ID" \
    '{abiEncoded:.abiEncoded,bytecode:.bytecode,constructorArgs:.constructorArgs,chainId:$c,traceId:$t,smartWallet:""}' \
    "$PAYLOAD"
}
call_body () {
  jq -nc --argjson c "$CHAIN_ID" --arg addr "$CALL_CONTRACT" \
    '{functionSignature:"function increment()", args:[], contractAddress:$addr, chainId:$c, smartWallet:""}'
}

echo "Submitting [deploy, call, deploy] fast (one batch expected)..."
curl -s -X POST "$QM_URL/queue/deploy"      -H 'Content-Type: application/json' -d "$(deploy_body)" | jq -c '{op:"deploy#1", queue_id:.queue_id, status:.status}'
curl -s -X POST "$QM_URL/queue/transaction" -H 'Content-Type: application/json' -d "$(call_body)"   | jq -c '{op:"call",    queue_id:.queue_id, status:.status}'
curl -s -X POST "$QM_URL/queue/deploy"      -H 'Content-Type: application/json' -d "$(deploy_body)" | jq -c '{op:"deploy#2", queue_id:.queue_id, status:.status}'
echo "Done. After ~40s inspect the batch — under lockstep, the CALL row will carry a deployed_address."
