import { fileURLToPath } from 'node:url';
/** Synthetic local runner evidence, not real product acceptance. No external SUT or model. The local HTTP model simulator returns predetermined clicks; it is not a vision-quality benchmark. */
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { EventBus, MemoryEventStore, Supervisor, Gate, lendGate } from '@testpilot/harness-core';
import type { ExecSpec, ExecResult } from '../../apps/runner/src/exec.js';
import { LifecycleSchema } from '@testpilot/harness-testing';
const root=fileURLToPath(new URL('../../',import.meta.url));
const dir=mkdtempSync(join(tmpdir(),'tp-lifecycle-runner-'));
let simulatedRequests=0;
const server=createServer(async(req,res)=>{
if(req.url?.startsWith('/v1/')){
 let text='';for await(const chunk of req)text+=chunk;
 const deleting=/Click Delete owned-/i.test(text);simulatedRequests++;
 res.setHeader('content-type','application/json');res.end(JSON.stringify({id:'local-simulated',object:'chat.completion',created:1,model:'local-simulated',choices:[{index:0,message:{role:'assistant',content:JSON.stringify({log:'Predetermined synthetic lifecycle action',action:{type:'Tap',param:{locate:{bbox:deleting?[150,80,250,120]:[20,80,120,120],prompt:deleting?'Delete':'Create'}}},more_actions_needed_by_instruction:false})},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}));return;
}
res.setHeader('content-type','text/html');res.end(`<!doctype html><style>#create{position:absolute;left:20px;top:80px;width:100px;height:40px}#delete{position:absolute;left:150px;top:80px;width:100px;height:40px}#resources{margin-top:120px}</style><body><h1>Ready</h1><button id="create">Create</button><button id="delete">Delete</button><div id="resources"></div><script>
const identity=new URL(location.href).searchParams.get('identity');
document.querySelector('#create').onclick=()=>{document.querySelector('#resources').textContent=identity+' owner-A';};
document.querySelector('#delete').onclick=()=>{document.querySelector('#resources').textContent='';};
</script></body>`);});
server.listen(0,'127.0.0.1');await once(server,'listening');
const url=`http://127.0.0.1:${(server.address() as {port:number}).port}/`;
const bus=new EventBus(new MemoryEventStore()),lending=lendGate(new Gate(1)),sup=new Supervisor(bus,{extendParentApi:id=>lending.api(id)});
const identity='owned-${env.TP_LIFECYCLE_ID}';
const check=(value:string,kind:'text'|'noText'='text')=>({statement:value,checks:[{kind:'screen' as const,statement:value,oracle:{kind,value}}]});
const contract=LifecycleSchema.parse({version:1,mode:'controlled',rationale:'Synthetic UI lifecycle',sourceRefs:['local-fixture#1'],supports:['$expected'],baseline:[check('Ready')],resources:[{id:'r1',sourceRef:'local-fixture#1',identity,establishAfterStep:2,established:check(identity),ownership:check(identity+' owner-A')}],cleanup:[{id:'delete',resourceId:'r1',postStep:1,verified:check(identity,'noText')}]});
mkdirSync(resolve(root,'server/.data/cache/midscene'),{recursive:true});
sup.register({id:'lifecycle-runner',kind:'node',entry:resolve(root,'apps/runner/src/main.ts'),execArgv:['--import','tsx'],restart:'never',heartbeatMs:1000,readyTimeoutMs:20000});
const results:Record<string,unknown>[]=[];
try{
 await sup.start('lifecycle-runner');
 const rpc=sup.rpc<{exec:(spec:ExecSpec)=>Promise<ExecResult>}>('lifecycle-runner')!;
 for(const scenario of ['success','business-failure','ownership-mismatch'] as const){
  const lifecycle=structuredClone(contract);if(scenario==='ownership-mismatch')lifecycle.resources[0].ownership=check(identity+' owner-B');
  const out=await rpc.exec({execId:'lifecycle-'+scenario,url,artifactDir:dir,steps:[`Open ${url}?identity=${identity}`,`Click Create ${identity}`],expected:'Ready screen',opts:{lifecycle,sourceRefs:['local-fixture#1'],postSteps:[`Click Delete ${identity}`],oracle:{kind:'text',value:scenario==='business-failure'?'Missing expected content':'Ready'},executorModel:{role:'executor',endpoint:url+'v1',apiKey:'local-simulated',model:'local-simulated',thinking:false,vlMode:'qwen-vl'},modelBudget:{maxCalls:10}}});
  if(scenario==='success'&&(out.status!=='passed'||out.lifecycle?.cleanup[0].status!=='pass'))throw new Error(JSON.stringify(out));
  if(scenario==='business-failure'&&(out.status!=='failed'||out.lifecycle?.cleanup[0].status!=='pass'||out.failure?.attribution!=='assert'))throw new Error(JSON.stringify(out));
  if(scenario==='ownership-mismatch'&&(out.status==='passed'||out.lifecycle?.pendingResources.length!==1||out.lifecycle?.cleanup[0].status!=='fail'))throw new Error(JSON.stringify(out));
  results.push({scenario,status:out.status,businessStatus:out.businessStatus,modelRequests:out.modelRequests?.length,lifecycle:out.lifecycle,observation:out.observation,screenshots:out.pngPaths});
 }
 writeFileSync(join(dir,'results.json'),JSON.stringify({kind:'synthetic-local-runner',realVisionModel:false,simulatedRequests,results},null,2));
 console.log(JSON.stringify({directory:dir,realVisionModel:false,simulatedRequests,scenarios:results.map(r=>({scenario:r.scenario,status:r.status,businessStatus:r.businessStatus,modelRequests:r.modelRequests}))},null,2));
} finally {await sup.stopAll();server.close();}
