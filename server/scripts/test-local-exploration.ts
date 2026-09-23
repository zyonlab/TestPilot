/** Local synthetic browser evidence only; no external SUT or model acceptance claims. */
import {createServer} from 'node:http';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {runObserve,partialObservationPath} from '@testpilot/harness-testing/exec';
import {explorationExecId,type ExplorationAttempt} from '@testpilot/harness-testing/domain';
const dir=mkdtempSync(join(tmpdir(),'tp-exploration-browser-'));
process.env.TP_DATA_DIR=dir;
let modelCalls=0;
const server=createServer((req,res)=>{
 if(req.url?.startsWith('/v1/')){modelCalls++;res.writeHead(500);res.end('No model calls allowed');return;}
 res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Local exploration</title><button id="open">Open</button><p>Ready</p>');
});
await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
const port=(server.address() as {port:number}).port,url=`http://127.0.0.1:${port}/`;
const {ARTIFACT_DIR}=await import('../src/db.js');
const {readPartialObservation}=await import('../src/workflowOps.js');
const attempt=():ExplorationAttempt=>({attemptId:randomUUID(),runId:'local-browser',projectId:'synthetic',entryUrl:url,scopeHash:'local-entry-only',startedAt:new Date().toISOString()});
const spec=(sourceAttempt:ExplorationAttempt)=>({execId:'browser-entry',projectId:'synthetic',sourceAttempt,url,artifactDir:ARTIFACT_DIR,deep:false,scenarioFirst:false,settleMs:50,maxSettleMs:1000,launch:{headless:true,executorModel:{role:'executor' as const,endpoint:`http://127.0.0.1:${port}/v1`,model:'forbidden-local-model',apiKey:'local-only',thinking:null}}});
try{
 const first=attempt(),result=await runObserve(spec(first),()=>{});
 assert.equal(result.screens,1);assert.equal(result.assessment?.status,'unknown');assert.deepEqual(result.sourceAttempt,first);
 assert.ok(result.graph?.states[0].controls.some(c=>c.includes('Open')));
 assert.equal(existsSync(partialObservationPath(ARTIFACT_DIR,explorationExecId(first))),false);
 const interrupted=attempt();
 await assert.rejects(runObserve(spec(interrupted),event=>{if(event.type==='log'&&String(event.message).startsWith('探索结束'))throw new Error('synthetic failure after captured screen');}),/synthetic failure/);
 const salvaged=readPartialObservation(interrupted);
 assert.equal(salvaged?.screens,1);assert.equal(salvaged?.stopped.kind,'failed');assert.ok(salvaged?.notes.includes('Open'));
 assert.equal(readPartialObservation(attempt()),undefined);
 const beforeFirst=attempt();
 await assert.rejects(runObserve({...spec(beforeFirst),url:'http://127.0.0.1:1/',sourceAttempt:{...beforeFirst,entryUrl:'http://127.0.0.1:1/'}},()=>{}));
 assert.equal(readPartialObservation(beforeFirst),undefined);
 assert.equal(modelCalls,0);
 console.log(JSON.stringify({scenarios:3,entryScreens:result.screens,partialScreens:salvaged?.screens,firstCaptureFailure:'no salvage',modelCalls,scope:'local synthetic browser only'}));
}finally{await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(dir,{recursive:true,force:true});}
