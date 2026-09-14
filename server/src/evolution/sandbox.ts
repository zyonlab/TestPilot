import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,existsSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import type {RoleModelConnection,ChatRequest} from '@testpilot/harness-core';
// macOS first implementation. Other platforms fail closed until a verified sandbox adapter exists.
export async function isolatedChat(opts:{privateRoot:string;repoRoot:string;connection:RoleModelConnection;request:ChatRequest;timeoutMs:number;signal?:AbortSignal}){
 if(process.platform!=='darwin'||!existsSync('/usr/bin/sandbox-exec'))throw new Error('verified_candidate_sandbox_unavailable');
 const workspace=mkdtempSync(join(tmpdir(),'tp-candidate-'));const probe=join(opts.privateRoot,'isolation-canary');mkdirSync(opts.privateRoot,{recursive:true,mode:0o700});writeFileSync(probe,'private evaluation canary; never return this value',{mode:0o600});
 const escaped=(s:string)=>JSON.stringify(realpathSync(resolve(s)));
 const endpoint=new URL(opts.connection.endpoint);if(endpoint.hostname!=='127.0.0.1')throw new Error('candidate_requires_scoped_loopback_proxy');
 const policy=`(version 1)(allow default)(deny file-read* (subpath ${escaped(opts.privateRoot)}) (subpath ${escaped(join(opts.repoRoot,'benchmark'))}) (literal ${escaped(join(opts.repoRoot,'server/.env'))}))(deny file-write* (require-not (subpath ${escaped(workspace)})))(deny network*)(allow network-outbound (remote tcp "localhost:${endpoint.port}"))`;
 const env={PATH:process.env.PATH,TSX_DISABLE_CACHE:'1',TMPDIR:workspace,HOME:workspace};
 const child=spawn('/usr/bin/sandbox-exec',['-p',policy,process.execPath,'--import','tsx',join(opts.repoRoot,'server/src/evolution/worker.ts')],{cwd:join(opts.repoRoot,'server'),env,stdio:['ignore','ignore','pipe','ipc']});
 return new Promise<{response:any;isolation:any;workspace:string}>((resolveResult,reject)=>{
 let stderr='';child.stderr?.on('data',b=>{stderr=(stderr+b).slice(-500)});
 let settled=false;const end=(error?:Error,value?:any)=>{if(settled)return;settled=true;clearTimeout(timer);opts.signal?.removeEventListener('abort',abort);child.kill('SIGKILL');error?reject(error):resolveResult(value)};
 const abort=()=>end(new Error('BUDGET_EXHAUSTED'));const timer=setTimeout(abort,opts.timeoutMs);opts.signal?.addEventListener('abort',abort,{once:true});if(opts.signal?.aborted)return abort();
 child.on('message',(m:any)=>m.ok?end(undefined,{response:m.response,isolation:{reads:m.isolation,writes:m.writes},workspace}):end(new Error(m.error??'candidate_failed')));child.on('error',()=>end(new Error('candidate_spawn_failed')));child.on('exit',code=>end(new Error(`candidate_exit_${code}:${stderr.replaceAll(opts.connection.apiKey,'[redacted]').slice(-300)}`)));
 child.send({connection:opts.connection,request:opts.request,probes:[probe]},e=>{if(e)end(new Error('candidate_ipc_failed'))});
 });
}
