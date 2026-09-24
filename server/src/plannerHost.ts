import {execFile,spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {db,getProject} from './db.js';
import {codexBin} from './codex.js';
import {claudeBin} from './claudecode.js';
import {LedgerError} from './runLedger.js';
import type {ChatRequest,ChatResponse} from '@testpilot/harness-core';
export type NativeHost='codex'|'claude-code';
const bin=(host:NativeHost)=>host==='codex'?codexBin():claudeBin();
export async function probeHost(host:NativeHost){
 return new Promise<{runtime:NativeHost;state:'ready'|'unavailable'|'signed-out'|'unknown';model:null}>(resolve=>{
  execFile(bin(host),host==='codex'?['login','status']:['auth','status','--json'],{timeout:8000,maxBuffer:65536},(error,stdout,stderr)=>{
   let ready=false;try{ready=host==='codex'?/logged in/i.test(stdout+stderr):JSON.parse(stdout).loggedIn===true;}catch{}
   resolve({runtime:host,state:!error&&ready?'ready':(error as NodeJS.ErrnoException)?.code==='ENOENT'?'unavailable':!error||/not logged in/i.test(stdout+stderr)?'signed-out':'unknown',model:null});
  });
 });
}
function table(){db.exec('CREATE TABLE IF NOT EXISTS project_planner_hosts (projectId TEXT PRIMARY KEY,runtime TEXT NOT NULL)');}
export function savedHost(projectId:string):NativeHost|null{table();return (db.prepare('SELECT runtime FROM project_planner_hosts WHERE projectId=?').get(projectId) as {runtime:NativeHost}|undefined)?.runtime??null;}
export async function hostStatus(projectId:string){
 if(!getProject(projectId))throw new LedgerError(404,'project_missing');
 const hosts=await Promise.all([probeHost('codex'),probeHost('claude-code')]),saved=savedHost(projectId);
 // Do not guess between two authenticated hosts. The user selects once per project.
 const ready=hosts.filter(h=>h.state==='ready');
 return {hosts,selected:saved??(ready.length===1?ready[0]!.runtime:null),modelSource:'host',sessionMode:'independent-task',checkedAt:new Date().toISOString()};
}
export async function selectHost(projectId:string,runtime:unknown){
 if(runtime!=='codex'&&runtime!=='claude-code')throw new LedgerError(400,'invalid_planner_host');
 if(!getProject(projectId))throw new LedgerError(404,'project_missing');
 if((await probeHost(runtime)).state!=='ready')throw new LedgerError(409,'planner_host_not_ready');
 table();db.prepare('INSERT INTO project_planner_hosts VALUES (?,?) ON CONFLICT(projectId) DO UPDATE SET runtime=excluded.runtime').run(projectId,runtime);
 return hostStatus(projectId);
}
export async function requireHost(projectId:string){const status=await hostStatus(projectId);if(!status.selected)throw new LedgerError(409,'planner_host_selection_required');if(status.hosts.find(h=>h.runtime===status.selected)?.state!=='ready')throw new LedgerError(409,'planner_host_not_ready');return status.selected;}
export function nativeDraftArgs(host:NativeHost){return host==='codex'
 ? ['-a','never','exec','--json','--ephemeral','--skip-git-repo-check','--sandbox','read-only','-c','mcp_servers={}','-c','features.shell_tool=false','-c','web_search="disabled"','-']
 : ['-p','--output-format','json','--tools','','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--no-session-persistence'];}
export async function nativeHostChat(host:NativeHost,request:ChatRequest, options:{timeoutMs?:number;signal?:AbortSignal}={}):Promise<ChatResponse>{
 const directory=mkdtempSync(join(tmpdir(),'testpilot-draft-')),started=Date.now();
 const env={...process.env};for(const key of Object.keys(env))if(/^(TP_PLANNER_|MIDSCENE_)/.test(key))delete env[key];
 const prompt=[request.stable,'Draft only from the supplied context. Do not use tools or access files. Return only the requested answer.',request.schema?`Return a JSON object matching this schema: ${JSON.stringify(request.schema)}`:'',request.variable].join('\n\n');
 try{return await new Promise<ChatResponse>((resolve,reject)=>{
  const child=spawn(bin(host),nativeDraftArgs(host),{cwd:directory,env,stdio:['pipe','pipe','pipe']});let output='',overflow=false,timedOut=false;
  const stop=()=>{child.kill('SIGTERM');const forced=setTimeout(()=>child.kill('SIGKILL'),3000);forced.unref();};
  const timeout=setTimeout(()=>{timedOut=true;stop();},options.timeoutMs??180000);timeout.unref();
  let aborted=false;const onAbort=()=>{aborted=true;stop();};if(options.signal?.aborted)onAbort();else options.signal?.addEventListener('abort',onAbort,{once:true});
  child.stdout.on('data',chunk=>{if(overflow)return;output+=chunk.toString();if(output.length>2000000){overflow=true;stop();}});child.stderr.on('data',()=>{});child.stdin.on('error',()=>{});
  child.on('error',()=>{clearTimeout(timeout);reject(new Error('planner_host_spawn_failed'));});
  child.on('close',code=>{clearTimeout(timeout);options.signal?.removeEventListener('abort',onAbort);if(aborted||timedOut||overflow||code!==0)return reject(new Error(aborted?'planner_host_cancelled':timedOut?'planner_host_timeout':overflow?'planner_host_output_too_large':'planner_host_request_failed'));
   try{let text='',tokens=0,model:string|undefined;
    if(host==='claude-code'){const result=JSON.parse(output);if(result.is_error)throw new Error();text=result.result??'';tokens=(result.usage?.input_tokens??0)+(result.usage?.output_tokens??0);model=Object.keys(result.modelUsage??{})[0];}
    else for(const line of output.split('\n')){if(!line.trim())continue;const event=JSON.parse(line);if(event.type==='item.completed'&&event.item?.type==='agent_message')text=event.item.text;if(event.type==='turn.completed')tokens=(event.usage?.input_tokens??0)+(event.usage?.output_tokens??0);}
    if(!text)throw new Error();resolve({text,tokens,ms:Date.now()-started,...(model?{model}:{})});
   }catch{reject(new Error('planner_host_invalid_response'));}
  });child.stdin.end(prompt);
 });}finally{rmSync(directory,{recursive:true,force:true});}
}
