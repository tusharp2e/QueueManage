// Adversarial test of the bundler's "+1 adjacency, hash-checked" deploy resolver.
// Submits a MIXED [deploy, call, deploy] batch to the same Sepolia wallet, waits
// for one handleOps to settle, then compares the +1-rule, the DB, and chain.
import { ethers } from 'ethers';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, closePool } from '../src/utils/db.js';
import { config } from '../src/config/config.js';

const QM = process.env.QM_URL || 'http://localhost:3000';
const CHAIN = 11155111;
const WALLET = config.defaultTestnetSmartWalletAddress;
const DEPLOYER = '0xd4381E45cdBC31ABC8e413638b84e6FaE2138F2d'.toLowerCase();
const ENTRY = '0x437A904958Fcf25ad6a6A9BC7F28b2F02d2D8485'.toLowerCase();
const CALL_CONTRACT = '0x98F811D169F8A87AF29015ac170B709135c5CC07';
const UOE = ethers.id('UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)');
const here = path.dirname(fileURLToPath(import.meta.url));
const payload = JSON.parse(fs.readFileSync(path.join(here, 'deploy-payload.json'), 'utf8'));
const prov = new ethers.JsonRpcProvider('https://11155111.rpc.thirdweb.com/28eb15303fc228ba1379cfc8dd0181c4', undefined, { staticNetwork: true });
const TERMINAL = new Set(['success', 'failed', 'execution_failed', 'validation_failed']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function busy() { const { rows } = await pool.query(`SELECT COUNT(*)::int n FROM smart_wallet_transactions WHERE smart_wallet_address=$1 AND chain_id=$2 AND status=ANY($3)`, [WALLET, CHAIN, ['queued','dispatched','sent']]); return rows[0].n; }
async function postDeploy() { const t = randomUUID(); const r = await fetch(`${QM}/queue/deploy`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ abiEncoded: payload.abiEncoded, bytecode: payload.bytecode, constructorArgs: payload.constructorArgs, chainId: CHAIN, traceId: t, smartWallet: '' }) }); const b = await r.json(); return { kind:'deploy', traceId:t, queue_id:b.queue_id }; }
async function postCall() { const r = await fetch(`${QM}/queue/transaction`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ functionSignature:'function increment()', args:[], contractAddress: CALL_CONTRACT, chainId: CHAIN, smartWallet: '' }) }); const b = await r.json(); return { kind:'call', queue_id:b.queue_id }; }

console.log('waiting for Sepolia wallet free...');
for (let i=0;i<200 && await busy()>0;i++) await sleep(3000);

console.log('submitting [deploy, call, deploy] fast...');
const ops = [await postDeploy(), await postCall(), await postDeploy()];
console.log('submitted:', ops.map(o=>`${o.kind}:${(o.queue_id||'').slice(0,8)}`).join('  '));
const ids = ops.map(o=>o.queue_id);

console.log('settling...');
for (let i=0;i<200;i++){ const { rows } = await pool.query(`SELECT status FROM smart_wallet_transactions WHERE queue_id=ANY($1)`,[ids]); if (rows.length===ids.length && rows.every(r=>TERMINAL.has(r.status))) break; await sleep(3000); }

const { rows } = await pool.query(`SELECT t.queue_id, t.transaction_type, t.status, t.user_op_hash, t.batch_id, t.transaction_hash, d.deployed_address FROM smart_wallet_transactions t LEFT JOIN smart_wallet_deployments d ON d.tx_id=t.id WHERE t.queue_id=ANY($1) ORDER BY t.created_at`,[ids]);
console.log('\n=== DB (chronological) ===');
const batchIds = new Set(rows.map(r=>r.batch_id));
for (const r of rows) console.log(`  ${r.transaction_type.padEnd(6)} ${r.status.padEnd(18)} uoh=${(r.user_op_hash||'').slice(0,12)} batch=${(r.batch_id||'').slice(0,8)} deployed=${r.deployed_address||'(none)'}`);
console.log('  distinct batch_ids:', batchIds.size, batchIds.size===1?'(one batch ✓)':'(SPLIT — not one batch ✗)');

const txh = rows[0].transaction_hash;
if (txh) {
  const rc = await prov.getTransactionReceipt(txh);
  const seq = [];
  for (const l of rc.logs){ const a=l.address.toLowerCase(); if(a===DEPLOYER){ const d=ethers.AbiCoder.defaultAbiCoder().decode(['string','address'],l.data); seq.push({ idx:l.index, t:'Deployed', addr:d[1] }); } else if(a===ENTRY && l.topics[0]===UOE){ seq.push({ idx:l.index, t:'UOE', uoh:l.topics[1] }); } }
  console.log('\n=== on-chain log sequence ===');
  for (const s of seq) console.log(`  ${s.idx} ${s.t}${s.t==='Deployed'?` addr=${s.addr.slice(0,12)}`:` uoh=${s.uoh.slice(0,12)}`}`);
  console.log('\n=== "+1 adjacency" rule (what the bundler computes) ===');
  const uoeByIdx = new Map(seq.filter(s=>s.t==='UOE').map(s=>[s.idx,s.uoh]));
  for (const d of seq.filter(s=>s.t==='Deployed')){ const uoh=uoeByIdx.get(d.idx+1); console.log(`  Deployed addr=${d.addr.slice(0,12)} -> idx+1 UOE=${(uoh||'(NONE -> would mark execution_failed)').slice(0,12)}`); }
}

const deployRows = rows.filter(r=>r.transaction_type==='deploy');
const callRows = rows.filter(r=>r.transaction_type==='call');
const dAddrs = deployRows.map(r=>r.deployed_address).filter(Boolean);
console.log('\n=== VERDICT ===');
console.log('  deploy ops:', deployRows.length, '| distinct deployed_address:', new Set(dAddrs).size, new Set(dAddrs).size===deployRows.length && deployRows.every(r=>r.status==='success')?'✅ each deploy distinct & correct':'⚠️ check above');
console.log('  call op deployed_address:', callRows.map(r=>r.deployed_address||'(none ✓)').join(','), callRows.some(r=>r.deployed_address)?'❌ CALL got an address (BUG)':'');
await closePool().catch(()=>{});
