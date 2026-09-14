/** Explicit real continuation after a separate reviewer has approved the run's revisions. */
import {config} from 'dotenv';
import {existsSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
const args=process.argv.slice(2),value=(key:string)=>args[args.indexOf(key)+1];
if(!args.includes('--real')||!args.includes('--project')||!args.includes('--run'))throw new Error('--real --project --run required');
const root=resolve(import.meta.dirname,'../..');config({path:join(root,'server/.env'),quiet:true} as any);
const projectId=value('--project'),runId=value('--run'),envRef=args.includes('--env')?value('--env'):undefined;
const {dataPath}=await import('../src/datadir.js'),codex=await import('../src/codex.js');
const {reviewRevisions}=await import('../src/approvedRuns.js');
const cases=reviewRevisions(runId,projectId);if(!cases.length||cases.some(c=>!c.approval))throw new Error('separate_review_required');
const workspace=dataPath(`host-workspaces/${runId}`),outDir=join(workspace,'runs',runId),trace=join(outDir,'codex-events.jsonl');
if(!existsSync(workspace))throw new Error('native_workspace_missing');
const evidence=resolve(process.env.TP_EVIDENCE_DIR??join(root,'docs/v3/evidence/codex-project',runId));mkdirSync(evidence,{recursive:true});
const oldLines=existsSync(trace)?readFileSync(trace,'utf8').split('\n').filter(Boolean).length:0;
await codex.startRun({runId,scopeProjectId:projectId,workspace,materialsDir:join(workspace,'materials'),envRef,
 message:`Continue existing TestPilot run ${runId} in project ${projectId}. A separate local acceptance reviewer has reviewed all revisions; this is engineering acceptance, not human Gold. Do not write, revise or approve cases, and do not invoke any generation pipeline.\nUse only TestPilot MCP: read get_project_run; call generate_execution for this run's approved cases; if it returns ready_to_execute, call execute_approved with the returned code revision, idempotencyKey=${JSON.stringify(`codex-host-execute-${runId}`)}${envRef?`, envRef=${JSON.stringify(envRef)}`:''}. Stop after the execution is accepted and report its execution ID. If any tool returns paused/failed or an error, report it without bypassing. Do not read credentials, connect a wallet or place trades.`});
console.log(JSON.stringify({runId,status:'native_execution_dispatch_started'}));
const deadline=Date.now()+300_000;while(codex.isRunning(runId)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,1000));
if(codex.isRunning(runId)){codex.cancelRun(runId);throw new Error('native_dispatch_timeout');}
const events=readFileSync(trace,'utf8').split('\n').filter(Boolean).slice(oldLines).flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
const toolCalls=events.filter(e=>e.type==='item.completed'&&e.item?.type==='mcp_tool_call').map(e=>({tool:e.item.tool,status:e.item.status}));
const executions=await (await fetch(`${process.env.TP_SERVER_URL??'http://127.0.0.1:5301'}/api/projects/${projectId}/workflow-runs/${runId}/executions`)).json() as {executions:{id:string;status:string}[]};
const evidenceResult={runId,projectId,toolCalls,usage:events.filter(e=>e.type==='turn.completed').map(e=>e.usage),executions:executions.executions,
 identity:JSON.parse(readFileSync(join(outDir,'host-identity.json'),'utf8')),dispatchedByNativeMcp:toolCalls.some(t=>t.tool==='execute_approved')&&executions.executions.length>0};
writeFileSync(join(evidence,'native-execution-dispatch.json'),JSON.stringify(evidenceResult,null,2));
console.log(JSON.stringify(evidenceResult));process.exit(evidenceResult.dispatchedByNativeMcp?0:1);
