import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, renameSync, symlinkSync, unlinkSync } from 'node:fs';
import { resolve, join, dirname, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { plannerModel, plannerConnectionFromEnv } from '@testpilot/harness-core';
import { chromium } from '@playwright/test';
import { buildExportFiles } from '../export.js';
import { dataPath } from '../datadir.js';
import { GenerationSchema, TaskSchema, validatePlan, sha, summarize, type Task, type Plan, type Trial } from './contracts.js';
import { fixture } from './fixture.js';
import {sealEvidence,verifyEvidence} from './integrity.js';

const repo=resolve(import.meta.dirname,'../../..');
const root=()=>dataPath('evidence-studies');
const write=(path:string,value:unknown)=>{mkdirSync(dirname(path),{recursive:true});writeFileSync(path,JSON.stringify(value,null,2));};
const folder=(id:string)=>{if(!/^study-[a-f0-9-]+$/.test(id))throw new Error('study_id_invalid');return join(root(),id);};
export function readStudy(id:string):any {return JSON.parse(readFileSync(join(folder(id),'state.json'),'utf8'));}
export function listStudies(){return existsSync(root())?readdirSync(root()).filter(x=>/^study-[a-f0-9-]+$/.test(x)).map(readStudy).sort((a,b)=>b.startedAt.localeCompare(a.startedAt)):[];}
function save(state:any){const f=join(folder(state.id),'state.json');write(f+'.tmp',state);renameSync(f+'.tmp',f);}
let active=false;
const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch{return false;}};
export function recoverStudies(){for(const s of listStudies()){if(s.review&&s.stage==='awaiting-evidence-review'){s.stage=s.review.decision==='accept-bounded'?'review-accepted':'review-rejected';save(s);}if(s.status==='running'&&(!s.ownerPid||!alive(s.ownerPid))){s.status='interrupted';s.error='server_restart';save(s);}}}
export function startStudy(){
  if(active)throw new Error('study_already_running');
  const connection=plannerConnectionFromEnv(); // fail before creating a job if configuration is absent
  mkdirSync(root(),{recursive:true});const lock=join(root(),'active.lock');
  if(existsSync(lock)){const pid=Number(readFileSync(lock,'utf8'));if(!pid||alive(pid))throw new Error('study_already_running');unlinkSync(lock);}
  try{writeFileSync(lock,String(process.pid),{flag:'wx'});}catch{throw new Error('study_already_running');}
  recoverStudies();
  const id='study-'+randomUUID(),state={id,ownerPid:process.pid,status:'running',startedAt:new Date().toISOString(),stage:'preregister',classification:'bounded-exporter-experiment'};
  save(state);active=true;
  void perform(id,connection).catch(e=>{const s=readStudy(id);s.status='failed';s.error=String(e.message).replaceAll(connection.apiKey||'__unused__','[redacted]').slice(0,500);s.finishedAt=new Date().toISOString();save(s);}).finally(()=>{active=false;if(existsSync(lock)&&readFileSync(lock,'utf8')===String(process.pid))unlinkSync(lock);});
  return state;
}
export function reviewStudy(id:string, raw:any){
  const note=String(raw?.note??'').trim();if(note.length<30)throw new Error('evidence_review_reason_required');
  const s=readStudy(id);if(s.status!=='done'||!s.summary)throw new Error('study_not_finished');
  if(s.review)throw new Error('study_already_reviewed');
  if(!['accept-bounded','reject'].includes(raw.decision))throw new Error('review_decision_invalid');
  if(raw.decision==='accept-bounded'&&s.summary.decision!=='bounded-improvement')throw new Error('improvement_not_established');
  const verified=verifyEvidence(folder(id));
  const recorded=JSON.parse(readFileSync(join(folder(id),'result.json'),'utf8'));
  if(JSON.stringify(recorded.summary)!==JSON.stringify(s.summary))throw new Error('evidence_summary_changed');
  if(!['local-operator','user-delegated-agent-review'].includes(raw.actor))throw new Error('review_source_required');
  s.stage=raw.decision==='accept-bounded'?'review-accepted':'review-rejected';
  s.review={decision:raw.decision,note,at:new Date().toISOString(),actor:raw.actor,independentHuman:false,productionPromotion:false,evidenceDigest:verified.digest};save(s);return s;
}
export function evidenceFile(id:string,file:string){
  if(!/^[a-zA-Z0-9_.-]+\.(json|png|txt)$/.test(file))throw new Error('evidence_file_invalid');
  const base=folder(id);const path=resolve(base,file);if(dirname(path)!==base||!existsSync(path))throw new Error('evidence_missing');return path;
}

async function perform(id:string,connection:ReturnType<typeof plannerConnectionFromEnv>){
  const dir=folder(id),state=readStudy(id);
  const stage=(name:string)=>{state.stage=name;save(state);};
  const raw=readFileSync(join(repo,'fixtures/export-contract-v1/tasks.json'),'utf8');
  const tasks:Task[]=JSON.parse(raw).tasks.map((x:unknown)=>TaskSchema.parse(x));
  const baselineRef='d2e62ce';
  const baseline=execFileSync('git',['show',`${baselineRef}:server/src/export.ts`],{cwd:repo,encoding:'utf8'});
  const candidate=readFileSync(join(repo,'server/src/export.ts'),'utf8');
  const dependencies=['server/src/exportLayers.ts','server/src/exportOracle.ts','server/src/exportIntegrity.ts','packages/harness-testing/src/exec/oracle.ts','server/src/evidenceStudy/runner.ts','server/src/evidenceStudy/fixture.ts','server/src/evidenceStudy/contracts.ts'].map(f=>({file:f,hash:sha(readFileSync(join(repo,f),'utf8'))}));
  const prereg={id,at:new Date().toISOString(),scope:'One changed component: historical vs working-tree exporter; shared dependencies held constant.',baselineRef,baselineHash:sha(baseline),candidateHash:sha(candidate),dependencies,datasetHash:sha(raw),fixtureHash:sha(readFileSync(join(repo,'server/src/evidenceStudy/fixture.ts'),'utf8')),scorerHash:sha(readFileSync(join(repo,'server/src/evidenceStudy/contracts.ts'),'utf8')),replicates:3,tasks:tasks.map(t=>({id:t.id,split:t.split,family:t.family})),schedule:'dev before reserved validation; AB/BA alternates by replicate; no reroll or candidate editing',criteria:'Complete trials; zero candidate false alarms or unobservable outcomes; stable defect detection strictly increases. All failures and invalid generations retained.',budget:{generationCalls:2,maxOutputTokensPerCall:8000,executionTimeoutMs:180000},review:{actor:'user-delegated-agent-review',independentHuman:false,note:'Requirements, visible fixture transitions and fault controls reviewed before execution. Reserved validation is author-known, not a secret independent test set.'},limits:['Tests target exporter lifecycle-assertion preservation.','Deterministic button adapter replaces Midscene action planning equally in both arms.','No claim about model quality, native-host execution or broad statistical significance.','No automatic production promotion.']};
  write(join(dir,'preregistered.json'),prereg);writeFileSync(join(dir,'dataset.json'),raw);writeFileSync(join(dir,'baseline-source.txt'),baseline);writeFileSync(join(dir,'candidate-source.txt'),candidate);
  state.preregistered=prereg;save(state);
  for(const d of dependencies){const dest=join(dir,'source-snapshots',d.file);mkdirSync(dirname(dest),{recursive:true});writeFileSync(dest,readFileSync(join(repo,d.file)));}
  // Only import location changes. The historical exporter source is kept verbatim above.
  const historicalFile=join(dir,'historical-export.ts');
  writeFileSync(historicalFile,baseline.replace(/from (['"])\.\/(.*?)\1/g,(_m,q,p)=>`from ${q}${pathToFileURL(join(repo,'server/src',p.replace(/\.js$/,'.ts'))).href}${q}`));
  const historical=(await import(pathToFileURL(historicalFile).href)).buildExportFiles as typeof buildExportFiles;
  const model=plannerModel({...connection,timeoutMs:180000});
  const generation:any[]=[];const trials:Trial[]=[];const controls:any[]=[];
  const browser=await chromium.launch({headless:true,channel:'chrome'});
  state.browser={version:browser.version(),channel:'chrome',viewport:{width:1440,height:1000}};save(state);
  try{
    for(const split of ['dev','validation']){
      stage(`generate-${split}`);
      const subset=tasks.filter(t=>t.split===split);
      const request={schema:GenerationSchema,stable:'Generate UI lifecycle tests as JSON {cases:[...]}. Use only the supplied public behavior contracts. For each task use its id, a title, exactly two steps with text "Click " followed by the exact button label, expected final state, top oracle {kind:"text",value:final state}, and assertions containing {statement,afterStep:1,oracle:{kind:"text",value:intermediate state}}. No markdown. Do not omit the intermediate assertion. This is a frozen-input exporter experiment, not an optimization task.',variable:JSON.stringify(subset.map(({split,family,...t})=>t)),maxTokens:8000,label:`export-study-${split}`};
      write(join(dir,`generation-${split}-request.json`),request);
      const response=await model.chat(request);write(join(dir,`generation-${split}-response.json`),response);
      generation.push({split,model:response.model??null,usage:response.usage??null,tokens:response.tokens,ms:response.ms,replayed:response.replayed??false});
      state.generation=generation;save(state);
      if(response.model!==connection.model)throw new Error('generation_model_binding_mismatch');
      if(response.replayed||response.truncated)throw new Error('generation_not_live_complete');
      const parsed=JSON.parse(response.text.replace(/^```(?:json)?\s*|\s*```$/g,''));
      if(!Array.isArray(parsed.cases)||parsed.cases.length!==subset.length)throw new Error('generation_case_count_mismatch');
      const plans:Plan[]=subset.map(t=>validatePlan(parsed.cases.find((c:any)=>c.id===t.id),t));
      write(join(dir,`frozen-${split}.json`),{hash:sha(JSON.stringify(plans)),plans,validation:{kind:'automated-contract-check',basis:'Exact actions and intermediate/final contracts match the preregistered protocol. This is not an independent human approval.'}});
      stage(`calibrate-${split}`);
      for(const task of subset)for(const variant of ['healthy','intermediate','final'] as const){
        const page=await browser.newPage();await page.setContent(fixture(task,variant));
        const seen=[];for(const button of task.buttons){await page.getByRole('button',{name:button,exact:true}).click();seen.push(await page.locator('output').innerText());}
        const expected=[variant==='intermediate'?'Transition unavailable':task.intermediate,variant==='final'?'Completion unavailable':task.final];
        controls.push({taskId:task.id,variant,observed:seen,expected,confirmed:JSON.stringify(seen)===JSON.stringify(expected)});await page.close();
      }
      write(join(dir,'injection-controls.json'),controls);if(controls.some(c=>!c.confirmed))throw new Error('fixture_calibration_failed');
      const cases=plans.map(p=>({...p,projectId:'export-contract-v1',priority:'P1',priorityReason:'Lifecycle contract',type:'functional',postSteps:[],steps:p.steps.map((s,i)=>({...s,order:i+1})),runStatus:'idle',hasCode:true,quarantined:false,createdAt:prereg.at}));
      const project={id:'export-contract-v1',name:'Export contract experiment',targetUrl:'http://fixture.test/single-page',targetPlatform:'web',createdAt:prereg.at};
      for(let repeat=0;repeat<3;repeat++)for(const arm of (repeat%2?['candidate','baseline']:['baseline','candidate']) as Trial['arm'][]){
        stage(`${split}-${arm}-${repeat+1}`);
        const runDir=join(dir,`${split}-${arm}-${repeat}`);mkdirSync(runDir,{recursive:true});
        const files=(arm==='baseline'?historical:buildExportFiles)(project as any,cases as any);
        for(const [file,content]of Object.entries(files)){mkdirSync(dirname(join(runDir,file)),{recursive:true});writeFileSync(join(runDir,file),content);}
        write(join(runDir,'exported-hashes.json'),Object.fromEntries(Object.entries(files).map(([k,v])=>[k,sha(v)])));
        // The only substituted export file is a documented, equal action fixture.
        writeFileSync(join(runDir,'tests/ai.ts'),adapterSource(subset,plans,arm,repeat,dir));
        writeFileSync(join(runDir,'playwright.config.ts'),`import {defineConfig} from '@playwright/test';export default defineConfig({testDir:'./tests',timeout:10000,workers:1,retries:0,reporter:'line',use:{headless:true,channel:'chrome',viewport:{width:1440,height:1000}},projects:['healthy','intermediate','final'].map(name=>({name}))});`);
        symlinkSync(join(repo,'server/node_modules'),join(runDir,'node_modules'),'dir');
        const result=await runPlaywright(runDir);writeFileSync(join(dir,`${split}-${arm}-${repeat}-process.txt`),result.output);
        const records=readdirSync(runDir).filter(f=>f.startsWith('trial-')&&f.endsWith('.json')).map(f=>JSON.parse(readFileSync(join(runDir,f),'utf8')));
        if(records.length!==subset.length*3)throw new Error(`incomplete_browser_execution:${split}:${arm}:${repeat}:${records.length}`);
        trials.push(...records);write(join(dir,'trials.json'),trials);state.completedTrials=trials.length;save(state);
      }
    }
    if(sha(readFileSync(join(repo,'server/src/export.ts'),'utf8'))!==prereg.candidateHash||sha(readFileSync(join(repo,'fixtures/export-contract-v1/tasks.json'),'utf8'))!==prereg.datasetHash)throw new Error('experiment_source_drift');
    if(dependencies.some(d=>sha(readFileSync(join(repo,d.file),'utf8'))!==d.hash))throw new Error('experiment_dependency_drift');
    state.summary=summarize(trials,tasks);state.generation=generation;state.cost={generationCalls:generation.length,tokens:generation.reduce((n,g)=>n+g.tokens,0),usd:null,executionModelCalls:0};write(join(dir,'result.json'),{summary:state.summary,generation,cost:state.cost});state.integrity=sealEvidence(dir);state.status='done';state.stage='awaiting-evidence-review';state.finishedAt=new Date().toISOString();save(state);
  }finally{await browser.close();}
}

function runPlaywright(cwd:string):Promise<{code:number|null;output:string}>{
  return new Promise((resolveResult,reject)=>{const child=spawn(process.execPath,[join(repo,'server/node_modules/@playwright/test/cli.js'),'test'],{cwd,env:{...process.env,BASE_URL:'http://fixture.test/single-page',FORCE_COLOR:'0'},stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);const timer=setTimeout(()=>{child.kill('SIGTERM');reject(new Error('execution_budget_exhausted'));},180000);child.on('error',e=>{clearTimeout(timer);reject(e)});child.on('exit',code=>{clearTimeout(timer);resolveResult({code,output})});});
}

function adapterSource(tasks:Task[],plans:Plan[],arm:string,repeat:number,evidenceDir:string){
  const mapping=Object.fromEntries(plans.map(p=>[p.title,tasks.find(t=>t.id===p.id)]));
  const html=Object.fromEntries(tasks.map(t=>[t.id,Object.fromEntries((['healthy','intermediate','final'] as const).map(v=>[v,fixture(t,v)]))]));
  return `import {test as base} from '@playwright/test';import {writeFileSync} from 'node:fs';import {join} from 'node:path';
const tasks=${JSON.stringify(mapping)},html=${JSON.stringify(html)};
export const test=base.extend({
 page:async({page},use,info)=>{const task=Object.entries(tasks).find(([title])=>info.title.endsWith(title))?.[1];if(!task)throw new Error('ADAPTER_UNKNOWN_TASK');const variant=info.project.name;await page.route('**/*',route=>route.request().url()==='http://fixture.test/single-page'?route.fulfill({contentType:'text/html',body:html[task.id][variant]}):route.abort());const start=Date.now();await use(page);const evidence=task.id+'-'+${JSON.stringify(arm)}+'-'+variant+'-'+${repeat}+'.png';await page.screenshot({path:join(${JSON.stringify(evidenceDir)},evidence)});const errors=info.errors.map(e=>e.message??'').join('\\n');const status=info.status==='passed'?'passed':errors.includes('ORACLE_FAIL:')?'failed':'unobservable';writeFileSync('trial-'+task.id+'-'+variant+'.json',JSON.stringify({taskId:task.id,split:task.split,family:task.family,arm:${JSON.stringify(arm)},variant,repeat:${repeat},status,ms:Date.now()-start,actions:info.annotations.filter(a=>a.type==='action').length,error:errors.slice(0,2000),evidence}));},
 aiAction:async({page},use,info)=>{await use(async(text)=>{if(!text.startsWith('Click '))throw new Error('ADAPTER_UNSUPPORTED_ACTION');await page.getByRole('button',{name:text.slice(6),exact:true}).click();info.annotations.push({type:'action',description:text});});},
 aiAssert:async({},use)=>{await use(async()=>{throw new Error('ADAPTER_UNSUPPORTED_MODEL_ASSERTION');});}
});`;
}
