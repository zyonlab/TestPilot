/** Independent read-only browser diagnostic. Never starts/resumes a preparation batch. */
import 'dotenv/config';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {executeRun,checkRun,resolveChainConfig} from '@testpilot/harness-testing';
import {snapshotExecutor} from '../src/modelSnapshots.js';
import {db} from '../src/db.js';
import {dataPath} from '../src/datadir.js';
import config from '../harness.config.js';
const [projectId,runId,target]=process.argv.slice(2);
if(!projectId||!runId||!target)throw new Error('Usage: check-preparation-facts.ts <projectId> <runId> <targetUrl>');
const guard=checkRun(target,[],config.guard);
if(!guard.allow)throw new Error('Target rejected by the configured guard');
const chain=resolveChainConfig();
const dir=dataPath(`diagnostics/preparation-facts-${Date.now()}`);mkdirSync(dir,{recursive:true});
try{
 const result=await executeRun(target,[],'',{
   executorModel:snapshotExecutor(runId,projectId),injected:true,captureObservations:true,
   signal:AbortSignal.timeout(90_000),modelBudget:{maxCalls:0,deadlineAt:Date.now()+90_000},
   preparation:{steps:[],checks:[{statement:'Requested target origin and provider installation agree with runtime configuration',checks:[
     {kind:'environment',fact:'target-origin',expected:new URL(target).origin},
     {kind:'environment',fact:'injected-wallet',expected:true},
     {kind:'environment',fact:'injected-chain',expected:chain.chainId},
   ]}]},
 });
 const {pngBuffers,screenshots,...receipt}=result;
 pngBuffers.forEach((bytes,i)=>writeFileSync(join(dir,`screen-${i}.png`),bytes));
 writeFileSync(join(dir,'result.json'),JSON.stringify(receipt,null,2));
 console.log(JSON.stringify({directory:dir,status:result.status,failureReason:result.failureReason,durationMs:result.durationMs,
   checks:result.prerequisiteChecks,environmentFacts:result.environmentFacts?.filter(f=>f.fact!=='injected-account'),
   forwardedModelCalls:result.modelRequests?.filter(r=>r.forwarded).length,screenshots:pngBuffers.length,
   notice:'Environment-source diagnostic only; no business actions, login proof, resource proof or case verification.'},null,2));
 if(result.status!=='passed')process.exitCode=1;
}finally{db.close();}
