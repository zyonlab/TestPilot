import {beforeAll,afterAll,it,expect,vi} from 'vitest';
import {createServer,type Server} from 'node:http';
import {once} from 'node:events';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {EventBus,MemoryEventStore,Supervisor,Gate,lendGate} from '@testpilot/harness-core';
import {validateRulePack} from '@testpilot/harness-testing/domain';
import {captureHostWebModels} from './helpers/model-snapshot.js';
const fake=vi.hoisted(()=>({observe:vi.fn(),run:vi.fn(),start:vi.fn(),host:vi.fn(async()=>({}))}));
vi.mock('../src/procs.js',async original=>({...await original<typeof import('../src/procs.js')>(),observeProduct:fake.observe}));
vi.mock('../src/exec.js',()=>({execOnRunner:fake.run,cancelExecution:vi.fn()}));
vi.mock('../src/penguinRun.js',()=>({startRun:fake.start,cancelRun:vi.fn()}));
vi.mock('../src/runtimes.js',()=>({getRuntime:()=>({startRun:fake.host}),defaultRuntimeName:()=> 'codex',plannerRuntimeAvailable:()=>true}));
vi.mock('../src/codex.js',()=>({isRunning:()=>true,cancelRun:vi.fn()}));
let dir:string,url:string,project:string,run='collected-reuse',site:Server,sup:Supervisor,rpc:any,svc:typeof import('../src/runService.js'),db:typeof import('../src/db.js');
let simulatedRequests=0,uiChange='';
const model={role:'executor',endpoint:'http://127.0.0.1:9/v1',apiKey:'unused',model:'unused',thinking:false};
beforeAll(async()=>{
 dir=mkdtempSync(join(tmpdir(),'tp-reuse-flow-'));vi.stubEnv('TP_DATA_DIR',dir);vi.stubEnv('MIDSCENE_MODEL_NAME','fixture');vi.stubEnv('MIDSCENE_MODEL_BASE_URL',model.endpoint);vi.stubEnv('MIDSCENE_MODEL_API_KEY','unused');
 site=createServer((req,res)=>{if(req.url?.startsWith('/v1/')){simulatedRequests++;req.resume();res.setHeader('content-type','application/json');res.end(JSON.stringify({id:'local-simulated',object:'chat.completion',created:1,model:'local-simulated',choices:[{index:0,message:{role:'assistant',content:JSON.stringify({log:'Synthetic predetermined click',action:{type:'Tap',param:{locate:{bbox:[20,20,120,60],prompt:'Open'}}},more_actions_needed_by_instruction:false})},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}));return;}res.setHeader('content-type','text/html');res.end('<!doctype html><title>Panel</title><style>#open{position:absolute;left:20px;top:20px;width:100px;height:40px}#content{margin-top:100px}</style><body><h1 style="margin-top:180px">Ready</h1><main id="panel"><button type="button" id="open" onclick="document.getElementById(\'content\').hidden=false">Open</button><p id="content" hidden>Panel visible</p></main><script>'+uiChange+'</script></body>');});site.listen(0,'127.0.0.1');await once(site,'listening');url=`http://127.0.0.1:${(site.address() as any).port}/`;
 db=await import('../src/db.js');svc=await import('../src/runService.js');project=db.createProject('Local reuse flow',url).id;db.upsertEnvironment({projectId:project,name:'original',baseUrl:url,isDefault:true});
 mkdirSync(resolve('../server/.data/cache/midscene'),{recursive:true});
 const lending=lendGate(new Gate(1));sup=new Supervisor(new EventBus(new MemoryEventStore()),{extendParentApi:id=>lending.api(id)});sup.register({id:'reuse-runner',kind:'node',entry:resolve('../apps/runner/src/main.ts'),execArgv:['--import','tsx'],restart:'never',heartbeatMs:1000,readyTimeoutMs:30000});await sup.start('reuse-runner');rpc=sup.rpc('reuse-runner');
 fake.observe.mockImplementation(input=>rpc.observe({...input,execId:'observe-'+input.sourceAttempt.attemptId,artifactDir:dir,settleMs:10,maxSettleMs:100,maxScreens:2,maxRounds:2,scenarioFirst:false,launch:{executorModel:model}}));
 fake.run.mockImplementation(input=>rpc.exec({...input,opts:{...input.opts,executorModel:model,modelBudget:{maxCalls:0}}}));
 fake.start.mockImplementation(async input=>{svc.freezeRunMaterials(input.wfRunId,project,input.materialsDir);return {};});
},40000);
afterAll(async()=>{await sup?.stopAll();site?.close();await new Promise(r=>setTimeout(r,3100));svc?.runLedger().close();db?.db.close();vi.unstubAllEnvs();rmSync(dir,{recursive:true,force:true});});
it('real Chrome collector → sealed materials → preparation probe/trial → formal runner RPC uses traced hints',async()=>{
 svc.registerWebRun(run,project,captureHostWebModels(run,project,'codex').binding,{sourceKind:'explore',sourceUrl:url,maxScreens:2,limit:1,pageVersion:'local-build-A',plannerRuntime:'codex'});
 const pack=validateRulePack({schemaVersion:'product-rule-pack.v1',id:'panel',version:'1',domain:'local-ui',product:'Panel',network:'local',accountMode:'anonymous',sources:[{id:'fixture',kind:'fixture-contract',locator:'synthetic-panel'}],modules:[{id:'m',name:'Panel'}],features:[{id:'panel',moduleId:'m',name:'Panel',applicability:'applicable',applicabilitySourceRefs:['fixture']}],targets:[{id:'open',featureId:'panel',match:{label:['^Open$']},action:'activate',sideEffect:'ui-only'}]});if(!pack.ok)throw new Error(JSON.stringify(pack.errors));
 (await import('../src/rulePacks.js')).bindRulePack(run,project,pack.pack,pack.hash,{kind:'system',id:'web'});
 mkdirSync(join(dir,'uploads',run),{recursive:true});svc.runLedger().db.prepare("UPDATE wf_runs SET status='failed' WHERE id=?").run(run);
 await (await import('../src/workflowOps.js')).resumeProjectWorkflow(run,project);
 await vi.waitFor(()=>expect(fake.start).toHaveBeenCalled(),{timeout:50000});
 const reuse=await import('../src/explorationReuse.js');const selected=reuse.selectExplorationContext(svc.runLedger(),run,project,url);
 expect(selected.rejected).toEqual([]);expect(selected.hints).toHaveLength(1);expect(selected.hints[0].source?.attempt.pageVersion).toBe('local-build-A');
 const source=svc.runLedger().listRevisions(project,run).find(r=>r.name==='exploration/observations')!;
 const captured:any=svc.runLedger().readRevision(source.id,project).content;expect(captured.report.observations[0].locatorEvidence.stateDigest).toBe(selected.hints[0].evidence?.stateDigest);
 const stage=await import('../src/runStages.js'),approval=await import('../src/approvedRuns.js'),prep=await import('../src/preparation.js');
 stage.loadRunInstructions(run,project);const retrieval=stage.retrieveRunSpec(run,project,{query:'Open',budgetTokens:2000}),ref=retrieval.chunks[0].id;
 const retrievalAudit:any=svc.runLedger().readRevision(retrieval.audit.revisionId,project).content;
 expect(retrievalAudit.materials[0]).toMatchObject({sourceType:'runtime-observation',sourceEvidence:'collector-ancestry',sourceRefs:[source.id]});
 expect(retrievalAudit.materials[0].sources[0].contentHash).toBe(source.contentHash);
 const stories=[{id:'s1',title:'Panel',acceptance:[]}];stage.writeRunStage(run,project,'stories',{stories});stage.writeRunStage(run,project,'cases',{stories,cases:[{id:'c1',storyId:'s1',title:'Panel opens',designMethod:'boundary',steps:['Click Open'],expected:'Panel visible',tier:1,key:'open-panel',sourceRefs:[ref],oracle:{kind:'text',value:'Panel visible'},readiness:{design:'candidate',execution:'blocked',reason:'Needs trial'}}]});stage.gateRun(run,project);stage.finalizeRun(run,project);
 const reviewed=approval.reviewRevisions(run,project)[0];approval.decideRevisions(run,project,{items:[{caseId:'c1',revisionId:reviewed.revision.id,decision:'approved'}]},{kind:'human',id:'synthetic-human'});
 const batch=await prep.startPreparation(run,project,{revisionIds:[reviewed.revision.id]});const call=(input:any)=>prep.preparationStep(run,project,{batchId:batch.batchId,caseId:'c1',...input});
 const next:any=await call({action:'next'});expect(next.experienceContext.exploration.hints).toEqual(selected.hints);
 const frozen=JSON.stringify(next.experienceContext);await call({action:'probe',setupSteps:[],reason:'Inspect current UI'});await vi.waitFor(()=>expect(prep.preparationStatus(run,project)?.units[0].status).toBe('planning'),{timeout:30000});
 expect(fake.run.mock.calls.at(-1)![0].opts.locatorContext).toEqual(next.experienceContext.exploration);expect(JSON.stringify(next.experienceContext)).toBe(frozen);
 await call({action:'trial',content:reviewed.content,reason:'Verify UI assertion'});await vi.waitFor(()=>expect(prep.preparationStatus(run,project)?.summary.verified).toBe(1),{timeout:30000});
 const final:any=await call({action:'next'});const execution=await import('../src/workflowExecution.js');const formal=execution.startWorkflowExecution(run,project,{codeRevision:final.codeRevision,idempotencyKey:'formal-reuse'});
 await vi.waitFor(()=>expect(execution.listWorkflowExecutions(run,project).find(r=>r.id===formal.executionId)?.status).toBe('passed'),{timeout:30000});
 const saved=svc.runLedger().listRevisions(project,run).find(r=>r.name==='execution/'+formal.executionId)!;const result:any=svc.runLedger().readRevision(saved.id,project).content;
 expect(result.results[0].evidenceReuse.events).toContainEqual(expect.objectContaining({status:'used',reason:'current_ui_validated'}));expect(result.results[0].oracle[0].status).toBe('pass');expect(result.results[0].modelRequests).toEqual([]);
 const last=fake.run.mock.calls.at(-1)![0];
 const disabled=await rpc.exec({...last,execId:'reuse-disabled-control',opts:{...last.opts,cacheId:'reuse-disabled',locatorContext:undefined,executorModel:{...model,endpoint:url+'v1',vlMode:'qwen-vl'},modelBudget:{maxCalls:5}}});
 expect(disabled.status).toBe('passed');expect(disabled.oracle.map((o:any)=>o.status)).toEqual(result.results[0].oracle.map((o:any)=>o.status));expect(simulatedRequests).toBeGreaterThan(0);expect(disabled.modelRequests.filter((r:any)=>r.forwarded)).toHaveLength(simulatedRequests);expect(disabled.evidenceReuse.events.every((e:any)=>e.status==='fallback')).toBe(true);
 console.log(JSON.stringify({syntheticComparison:true,realVisionModel:false,enabled:{status:result.results[0].status,forwarded:result.results[0].modelRequests.length,uses:result.results[0].evidenceReuse.events.filter((e:any)=>e.status==='used').length},disabled:{status:disabled.status,forwarded:simulatedRequests}}));
 for(const [id,script,reason] of [
  ['hidden',"document.querySelector('#open').style.display='none'",'hidden'],
  ['disabled',"document.querySelector('#open').disabled=true",'disabled'],
  ['renamed',"document.querySelector('#open').textContent='Changed'",'label_changed'],
  ['duplicate',"document.querySelector('main').append(document.querySelector('#open').cloneNode(true))",'target_changed'],
 ]){
  uiChange=script;
  const invalid=await rpc.exec({...last,execId:'reuse-'+id,opts:{...last.opts,executorModel:model,modelBudget:{maxCalls:0}}});
  uiChange='';
  expect(invalid.evidenceReuse.events).toContainEqual(expect.objectContaining({status:'fallback',reason}));expect(invalid.evidenceReuse.events.some((e:any)=>e.status==='used')).toBe(false);
 }
 expect(reuse.selectExplorationContext(svc.runLedger(),run,project,url,false,'different-actual-env').rejected[0].reason).toBe('dispatch_environment_changed');
 expect(reuse.selectExplorationContext(svc.runLedger(),run,project,url+'elsewhere').hints).toEqual([]);
 // Exercise the formal input.envRef path, not just the selector helper.
 db.upsertEnvironment({projectId:project,name:'alternate',baseUrl:url,headers:{'X-Synthetic':'alternate'}});
 fake.run.mockImplementationOnce(input=>rpc.exec({...input,opts:{...input.opts,executorModel:{...model,endpoint:url+'v1',vlMode:'qwen-vl'},modelBudget:{maxCalls:5}}}));
 const other=execution.startWorkflowExecution(run,project,{codeRevision:final.codeRevision,idempotencyKey:'other-environment',envRef:'alternate'});
 await vi.waitFor(()=>expect(execution.listWorkflowExecutions(run,project).find(r=>r.id===other.executionId)?.status).toBe('passed'),{timeout:30000});
 expect(fake.run.mock.calls.at(-1)![0].opts.locatorContext.rejected).toContainEqual({reason:'dispatch_environment_changed'});
 // A next() context remains byte-for-byte frozen while an intervening secret change invalidates use.
 const changed=await prep.startPreparation(run,project,{revisionIds:[reviewed.revision.id],mode:'all'});
 const before:any=await prep.preparationStep(run,project,{batchId:changed.batchId,action:'next'});
 const beforeBytes=JSON.stringify(svc.runLedger().readRevision(before.experienceContext.revision,project).content);
 db.setSecret(project,'SYNTHETIC','rotated');
 fake.run.mockImplementationOnce(input=>rpc.exec({...input,opts:{...input.opts,executorModel:{...model,endpoint:url+'v1',vlMode:'qwen-vl'},modelBudget:{maxCalls:5}}}));
 await prep.preparationStep(run,project,{batchId:changed.batchId,action:'trial',caseId:'c1',content:reviewed.content,reason:'Check dispatch after secret rotation'});
 await vi.waitFor(()=>expect(prep.preparationStatus(run,project)?.summary.verified).toBe(1),{timeout:30000});
 const after:any=await prep.preparationStep(run,project,{batchId:changed.batchId,action:'next'});
 const receipts=svc.runLedger().listRevisions(project,run).filter(r=>r.name.startsWith('preparation/'+changed.batchId)&&r.name.endsWith('/result'));
 const receipt:any=svc.runLedger().readRevision(receipts[0].id,project).content;
 expect(receipt.evidenceReuse.events).toContainEqual(expect.objectContaining({status:'fallback',reason:'dispatch_environment_changed'}));
 expect(JSON.stringify(svc.runLedger().readRevision(before.experienceContext.revision,project).content)).toBe(beforeBytes);
 expect(after.status).toBe('done');db.deleteSecret(project,'SYNTHETIC');

},180000);

it.each(['held-out','old-report','null-observation','bad-graph','missing-manifest','missing-ref','other-run','other-project','page-version','environment','material'])('optional reuse rejects %s while preserving normal run access',async fault=>{
 const {selectExplorationContext}=await import('../src/explorationReuse.js');const ledger=svc.runLedger();
 const view=Object.create(ledger) as typeof ledger;
 view.requireRun=(...args)=>{const r=structuredClone(ledger.requireRun(...args));if(fault==='held-out')r.input.parameters.evaluationSplit='held-out';if(fault==='page-version')r.input.parameters.pageVersion='new';if(fault==='environment')r.input.parameters.exploreWallet=true;return r;};
 view.readRevision=(...args)=>{const r=structuredClone(ledger.readRevision(...args));const c=r.content as any;
  if(r.revision.name==='exploration/observations'){
   if(fault==='null-observation')r.content=null;
   if(fault==='bad-graph')c.graph=null;
   if(fault==='other-run')r.revision.runId='other';
   if(fault==='other-project')c.sourceAttempt.projectId='other';
   if(fault==='missing-ref')r.revision.sourceRefs=[];
  }
  if(r.revision.name==='exploration/report'&&fault==='old-report')delete c.sourceAttempt;
  if(r.revision.name==='context/source'&&fault==='missing-manifest')throw new Error('missing blob');
  if(r.revision.name==='exploration.md'&&fault==='material')r.revision.sourceRefs=[];
  return r;
 };
 const result=selectExplorationContext(view,run,project,url);expect(result.hints).toEqual([]);expect(result.rejected.length).toBeGreaterThan(0);
});

it('does not attach a generated source ancestry to changed material bytes',()=>{
 const id='changed-material';svc.registerWebRun(id,project,captureHostWebModels(id,project,'codex').binding,{});
 const directory=join(dir,'changed-material');mkdirSync(directory);
 svc.runLedger().putRevision({runId:id,projectId:project,name:'exploration.md',kind:'material',content:'Captured bytes',mediaType:'text/markdown',sourceRefs:[]},{kind:'system',id:'explorer'});
 writeFileSync(join(directory,'exploration.md'),'Changed bytes');
 expect(()=>svc.freezeRunMaterials(id,project,directory)).toThrow('exploration_material_changed');
});
