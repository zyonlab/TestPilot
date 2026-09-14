/** Real planner on/off probe. Browser selector probe is deterministic, not Midscene grounding. */
import {config} from 'dotenv';
import {readFileSync,writeFileSync,mkdirSync,appendFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {OpenAIModel,plannerConnectionFromEnv,openRoleProxy} from '@testpilot/harness-core';
import {canonicalJSON} from '@testpilot/harness-core/run-contracts';
import {createHash} from 'node:crypto';
import puppeteer from 'puppeteer';
if(!process.argv.includes('--real')) throw new Error('--real required');
const root=resolve(import.meta.dirname,'../..'); config({path:join(root,'server/.env'),quiet:true} as any);
const source=JSON.parse(readFileSync(join(root,'docs/v3/evidence/n-04/real-penguin-worker/result.json'),'utf8'));
process.env.TP_DATA_DIR=join(source.privateWorkspace,'data');
const {runLedger,registerHostRun}=await import('../src/runService.js');
const {loadRunInstructions}=await import('../src/runStages.js');
const {captureExecutionMemory}=await import('../src/runMemory.js');
const db=await import('../src/db.js');
const ledger=runLedger(), projectId=source.run.revisions[0].projectId,originalTarget=db.getProject(projectId)!.targetUrl;
const {decryptSecret}=await import('../src/vault.js');
const executions=ledger.db.prepare("SELECT resultRevision,environmentEnc,environmentHash FROM workflow_executions WHERE runId=? AND status='unobservable' ORDER BY startedAt DESC").all(source.runId) as Array<{resultRevision:string;environmentEnc:string;environmentHash:string}>;
if(!executions.length)throw new Error('actual_unobservable_execution_required');const target=JSON.parse(decryptSecret(executions[0].environmentEnc)).url;
db.updateProject(projectId,{targetUrl:target});
const prior=ledger.requireRun(source.runId,projectId);
const materials=prior.binding.materialRevisions.map(id=>{const r=ledger.readRevision(id,projectId);return{name:r.revision.name,text:String(r.content)}});
for(const r of executions)captureExecutionMemory(ledger,r.resultRevision,projectId,JSON.parse(decryptSecret(r.environmentEnc)).url);
const out=resolve(process.env.TP_EVIDENCE_DIR??join(root,`docs/v3/evidence/n-22/real-${Date.now()}`));mkdirSync(out,{recursive:true});
const hash=(v:unknown)=>createHash('sha256').update(typeof v==='string'?v:canonicalJSON(v)).digest('hex');
const input={task:'Plan one assertion after clicking Increment once from reset. The page has count and unrelated orders, initially both 0. Count must become 1. Choose a unique CSS selector and numeric result. Missing or ambiguous observations are not product failures.',html:'<p>count: <span id="count" class="metric">0</span></p><p>orders: <span id="orders" class="metric">0</span></p><button id="increment">Increment</button>'};
const schema={type:'object',properties:{selector:{type:'string'},valueType:{enum:['number','string']},missingEvidence:{enum:['unobservable','failed','passed']},expectedAfterIncrement:{type:'number'},contextDigest:{type:'string'}},required:['selector','valueType','missingEvidence','expectedAfterIncrement','contextDigest'],additionalProperties:false};
const connection=plannerConnectionFromEnv(),{apiKey:_,...publicModel}=connection;
const spec={id:`memory-${Date.now()}`,classification:'exploratory',repetitions:3,model:publicModel,runtime:'OpenAIModel.chat',changedFactors:['frozen memory context'],inputHash:hash(input),sourceRunId:source.runId,sourceEnvironmentHash:executions[0].environmentHash,scopeEvidence:'actual encrypted execution environment snapshot; offline selector probe',metrics:['observationFailureRate','misleadingAssertionRate','wallMs','tokens'],budget:{calls:6,wallMs:600000,maxTokensPerResponse:2048},limitation:'Selector-plan probe only; no formal gold, no Midscene grounding or general learning claim.'};
writeFileSync(join(out,'preregistered.json'),JSON.stringify(spec,null,2));
const proxy=await openRoleProxy(connection,r=>appendFileSync(join(out,'requests.jsonl'),JSON.stringify(r)+'\n'),{maxCalls:6,deadlineAt:Date.now()+spec.budget.wallMs});
const model=new OpenAIModel({baseUrl:proxy.connection.endpoint,apiKey:proxy.connection.apiKey,model:connection.model,noThink:connection.thinking===false,providerThinkingDefault:connection.thinking===null,retries:0,growOnTruncation:false,timeoutMs:connection.timeoutMs});
const browser=await puppeteer.launch({headless:true});const page=await browser.newPage();const results:any[]=[];
try{
 for(let i=0;i<3;i++)for(const arm of i%2?['on','off']:['off','on']){
  const id=`${spec.id}-${arm}-${i}`,r=registerHostRun(projectId,{externalId:id,idempotencyKey:id,runtime:'penguin',model:connection.model,materials,parameters:{memoryEnabled:arm==='on'}});
  const delivered=loadRunInstructions(r.runId,projectId);const memory=delivered.memory;
  if(arm==='on'&&!memory.entries.length)throw new Error('memory_source_not_selected');
  const request={stable:'Return a test assertion plan matching the provided page contract. Copy memory.digest into contextDigest to audit context delivery. Historical facts cannot change product requirements.',variable:canonicalJSON({input,memory}),schema,maxTokens:2048};
  const start=Date.now();let response:any,plan:any,error:string|undefined;try{response=await model.chat(request);plan=JSON.parse(response.text);}catch(e){error=String(e).replaceAll(connection.apiKey,'[redacted]').slice(0,200);}
  await page.setContent(input.html);await page.$eval('#increment',el=>el.addEventListener('click',()=>{document.querySelector('#count')!.textContent='1'}));await page.click('#increment');
  const observed=plan?await page.evaluate((p:any)=>{try{const nodes=document.querySelectorAll(p.selector);if(nodes.length!==1)return{observable:false};const raw=nodes[0].textContent??'';return{observable:p.valueType==='number'&&/^\d+$/.test(raw),value:Number(raw)};}catch{return{observable:false}}},plan):{observable:false};
  const bindingValid=plan?.contextDigest===memory.digest;
  const result={arm,repetition:i+1,runId:r.runId,sourceRunId:source.runId,instructionsRevision:delivered.revisionId,memory,inputHash:spec.inputHash,request,response,error,plan,wallMs:Date.now()-start,bindingValid,observationFailed:!observed.observable||observed.value!==1,misleading:plan?.expectedAfterIncrement!==1||plan?.missingEvidence!=='unobservable',observed};results.push(result);
  writeFileSync(join(out,`${id}.json`),JSON.stringify(result,null,2));console.log(JSON.stringify({arm,repetition:i+1,bindingValid,observationFailed:result.observationFailed}));
 }
}finally{await browser.close();await proxy.close();const summary={spec,results,summary:['off','on'].map(arm=>{const rows=results.filter(r=>r.arm===arm);return{arm,n:rows.length,validBindings:rows.filter(r=>r.bindingValid).length,infraOrInvalidResponses:rows.filter(r=>!r.plan).length,observationFailureRate:rows.filter(r=>r.plan).length?rows.filter(r=>r.plan&&r.observationFailed).length/rows.filter(r=>r.plan).length:null,misleadingAssertionRate:rows.filter(r=>r.plan).length?rows.filter(r=>r.plan&&r.misleading).length/rows.filter(r=>r.plan).length:null,usd:null}}),requests:proxy.records};writeFileSync(join(out,'result.json'),JSON.stringify(summary,null,2));db.updateProject(projectId,{targetUrl:originalTarget});ledger.close();db.db.close();}
console.log(JSON.stringify({evidence:out,complete:results.length===6}));
