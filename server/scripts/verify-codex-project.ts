/** Real Codex host acceptance against an existing project's frozen source; no automatic review. */
import {config} from 'dotenv';
import {mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
const args=process.argv.slice(2),value=(key:string)=>args[args.indexOf(key)+1];
if(!args.includes('--real')||!args.includes('--project')||!args.includes('--source-run')||!args.includes('--source-revision'))throw new Error('--real --project --source-run --source-revision are required');
const root=resolve(import.meta.dirname,'../..');config({path:join(root,'server/.env'),quiet:true} as any);
const projectId=value('--project'),sourceRun=value('--source-run'),sourceRevision=value('--source-revision');
const runId=args.includes('--run')?value('--run'):`run-${randomUUID()}`;
const evidence=resolve(process.env.TP_EVIDENCE_DIR??join(root,'docs/v3/evidence/codex-project',runId));
const {runLedger,registerHostRun}=await import('../src/runService.js');
const {stageEvent}=await import('../src/workflowControls.js');
const {dataPath}=await import('../src/datadir.js');
const codex=await import('../src/codex.js');
const {generationMessage}=await import('../src/runtime/skill-launch.js');
const {registeredStageProducts}=await import('../src/runStages.js');
const source=runLedger().readRevision(sourceRevision,projectId);
if(source.revision.runId!==sourceRun||source.revision.kind!=='material'||typeof source.content!=='string')throw new Error('source_material_mismatch');
const workspace=dataPath(`host-workspaces/${runId}`),materialsDir=join(workspace,'materials'),outDir=join(workspace,'runs',runId);
mkdirSync(materialsDir,{recursive:true,mode:0o700});mkdirSync(evidence,{recursive:true});
writeFileSync(join(materialsDir,'exploration.md'),source.content,{mode:0o600});
const registration=registerHostRun(projectId,{runtime:'codex',externalId:runId,idempotencyKey:runId,
 materials:[{name:'exploration.md',text:source.content}],parameters:{sourceKind:'explore',sourceReuse:{runId:sourceRun,revisionId:sourceRevision,contentHash:source.revision.contentHash},stageControlVersion:1,outputLanguage:'zh',limit:6}},runId);
const material=registration.run.revisions.find(r=>r.kind==='material')!;
stageEvent(runId,projectId,'source','done','Reused the frozen Explore material; no fresh exploration in this run.',material.id);
writeFileSync(join(evidence,'launch.json'),JSON.stringify({runId,projectId,sourceRun,sourceRevision,sourceContentHash:source.revision.contentHash,materialRevision:material.id,materialHash:material.contentHash,workspace,runtime:'codex',planner:'native host configuration',executor:'existing project profile',startedAt:new Date().toISOString()},null,2));
console.log(JSON.stringify({runId,projectId,status:'starting',workspace}));
let failure:string|undefined;
try {
 const started=await codex.startRun({runId,workspace,materialsDir,scopeProjectId:projectId,limit:6,
  message:generationMessage({materialsDir,outDir,limit:6})+'\nProduce story/case prose in Chinese while preserving actual UI labels. Treat the material as observations, not authoritative product requirements. Cover only supported unauthenticated behavior; do not invent wallet/trading rules. Use precise actionable steps and independently checkable oracles. Do not connect a wallet, place trades, approve cases or execute cases. Do not read outside the provided materials and installed TestPilot skills.'});
 console.log(JSON.stringify({runId,status:'native_started',sessionId:started.sessionId}));
 const result=await new Promise<{status:string;error?:string}>(done=>codex.watchRun({...started,scopeProjectId:projectId,timeoutMs:900_000,pollMs:1000,onDone:done,onEvent:e=>console.log(JSON.stringify({node:e.node,phase:e.phase,at:e.at}))}));
 if(result.status!=='done')failure=result.error??'not_finalized';
 const end=Date.now()+30_000;while(codex.isRunning(runId)&&Date.now()<end)await new Promise(r=>setTimeout(r,500));
 if(codex.isRunning(runId))codex.cancelRun(runId);
 if(!registeredStageProducts(runId).finalized)failure??='not_finalized';
}catch(e){failure=e instanceof Error?e.message:'host_failed';codex.cancelRun(runId);}
const trace=join(outDir,'codex-events.jsonl');
const events=existsSync(trace)?readFileSync(trace,'utf8').split('\n').flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}}):[];
const run=runLedger().getRun(runId,projectId);
const result={runId,projectId,status:run.status,finalized:registeredStageProducts(runId).finalized,failure,
 identity:existsSync(join(outDir,'host-identity.json'))?JSON.parse(readFileSync(join(outDir,'host-identity.json'),'utf8')):null,
 toolCalls:events.filter(e=>e.type==='item.completed'&&e.item?.type==='mcp_tool_call').map(e=>({server:e.item.server,tool:e.item.tool,status:e.item.status})),
 usage:events.filter(e=>e.type==='turn.completed').map(e=>e.usage),
 nodes:run.nodes,revisions:run.revisions.map(r=>({id:r.id,name:r.name,kind:r.kind,revision:r.revision,contentHash:r.contentHash})),finishedAt:new Date().toISOString()};
writeFileSync(join(evidence,'generation.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify({runId,status:run.status,finalized:result.finalized,failure,toolCalls:result.toolCalls.length,evidence}));
process.exit(failure?1:0);
