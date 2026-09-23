import {afterAll,beforeAll,it,expect,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const fake=vi.hoisted(()=>({run:vi.fn(),host:vi.fn().mockResolvedValue({sessionId:'fixture'}),cancel:vi.fn()}));
vi.mock('../src/exec.js',()=>({execOnRunner:fake.run,cancelExecution:fake.cancel}));
vi.mock('../src/runtimes.js',()=>({getRuntime:()=>({startRun:fake.host})}));
vi.mock('../src/codex.js',()=>({isRunning:()=>true,cancelRun:fake.cancel}));
let dir:string,project:string,run:string,revision:string,original:any;
let svc:typeof import('../src/runService.js'),db:typeof import('../src/db.js'),prep:typeof import('../src/preparation.js'),approvals:typeof import('../src/approvedRuns.js');
beforeAll(async()=>{
 dir=mkdtempSync(join(tmpdir(),'tp-preparation-'));vi.stubEnv('TP_DATA_DIR',dir);vi.stubEnv('MIDSCENE_MODEL_NAME','fixture');vi.stubEnv('MIDSCENE_MODEL_BASE_URL','https://executor.test/v1');vi.stubEnv('MIDSCENE_MODEL_API_KEY','fixture');
 db=await import('../src/db.js');svc=await import('../src/runService.js');prep=await import('../src/preparation.js');approvals=await import('../src/approvedRuns.js');const stage=await import('../src/runStages.js');
 project=db.createProject('Preparation','http://localhost:9876').id;run=svc.registerHostRun(project,{runtime:'codex',externalId:'fixture',idempotencyKey:'fixture',materials:[{name:'counter.md',text:'Click increment raises counter to one.'}]}).runId;
 stage.loadRunInstructions(run,project);const ref=stage.retrieveRunSpec(run,project,{query:'increment',budgetTokens:2000}).chunks[0].id;
 const stories=[{id:'s1',title:'Count',acceptance:[]}];stage.writeRunStage(run,project,'stories',{stories});stage.writeRunStage(run,project,'cases',{stories,cases:[{id:'c1',storyId:'s1',title:'Increment',designMethod:'boundary',steps:['Click Increment'],expected:'Counter is one',tier:1,readiness:{design:'candidate',execution:'blocked',reason:'Control not located'},key:'increment',sourceRefs:[ref],oracle:{kind:'text',value:'Count: 1'},assertions:[{id:'a1',statement:'Counter is one',ruleRefs:[],oracle:{kind:'text',value:'Count: 1'}}]}]});stage.gateRun(run,project);stage.finalizeRun(run,project);
 const c=approvals.reviewRevisions(run,project)[0];revision=c.revision.id;original=c.content;approvals.decideRevisions(run,project,{items:[{caseId:'c1',revisionId:revision,decision:'approved'}]},{kind:'human',id:'fixture'});
});
afterAll(async()=>{await new Promise(r=>setTimeout(r,3100));svc.runLedger().close();db.db.close();vi.unstubAllEnvs();rmSync(dir,{recursive:true,force:true});});
const result=(status='passed')=>({status,infraError:false,durationMs:5,modelRequests:[],pngPaths:[],logs:['fixture result'],oracle:[{status:status==='passed'?'pass':'fail',decidedBy:'machine'}]});
async function start(mode:'retry'|'all'='all'){svc.runLedger().db.prepare("UPDATE wf_runs SET status='waiting_review' WHERE id=?").run(run);return prep.startPreparation(run,project,{revisionIds:[revision],maxRounds:2,mode});}
const step=(b:string,body:any)=>prep.preparationStep(run,project,{batchId:b,...body});
it('accepts approved unlocated cases, repairs after failure, and bundles only runner-verified plans',async()=>{
 const b=await start();expect(fake.host).toHaveBeenCalled();expect((await step(b.batchId,{action:'next'})).status).toBe('work');
 fake.run.mockResolvedValueOnce(result('failed'));await step(b.batchId,{action:'trial',caseId:'c1',content:original,reason:'Initial trial'});
 await vi.waitFor(()=>expect(prep.preparationStatus(run,project)?.units[0].status).toBe('repair'));
 const next:any=await step(b.batchId,{action:'next'});expect(next.result.status).toBe('failed');
 fake.run.mockResolvedValueOnce(result());await step(b.batchId,{action:'trial',caseId:'c1',content:{...original,steps:['Wait for the counter','Click Increment']},reason:'Wait for rendering'});
 await vi.waitFor(()=>expect(prep.preparationStatus(run,project)?.summary.verified).toBe(1));
 const end:any=await step(b.batchId,{action:'next'});expect(end.status).toBe('done');expect(approvals.approvedExecutionBundle(run,project,end.codeRevision).cases).toHaveLength(1);expect(approvals.reviewRevisions(run,project)[0].content.readiness?.execution).toBe('blocked');
});
it('sends changed acceptance back to review without calling runner',async()=>{
 const b=await start();const calls=fake.run.mock.calls.length;expect((await step(b.batchId,{action:'trial',caseId:'c1',content:{...original,expected:'Anything is fine'},reason:'Changed expectation'})).status).toBe('needs_review');expect(fake.run).toHaveBeenCalledTimes(calls);expect((await step(b.batchId,{action:'next'})).status).toBe('partial');
});
it('does not accept late results after cancellation and resumes persisted work',async()=>{
 const b=await start();let resolve!:(v:any)=>void;fake.run.mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));await step(b.batchId,{action:'trial',caseId:'c1',content:original,reason:'Trial'});await vi.waitFor(()=>expect(resolve).toBeTypeOf('function'));
 const observed={version:1,stages:[{stage:'actions',status:'completed',durationMs:7,model:{source:'role-proxy',forwarded:1,blocked:0}}],cache:{session:'unavailable',midscene:'unknown'},retries:[]};
 const request={requestId:'cancelled-receipt',at:new Date().toISOString(),role:'executor',model:'fixture',endpoint:'https://executor.test/v1',thinking:false,status:200,ms:7,forwarded:true};
 await prep.cancelPreparation(run,project);resolve({...result(),observation:observed,modelRequests:[request]});
 await vi.waitFor(()=>expect(svc.runLedger().listRevisions(project,run).some(r=>r.name.endsWith('/cancelled'))).toBe(true));
 expect(prep.preparationStatus(run,project)?.summary.verified).toBe(0);
 const saved=svc.runLedger().listRevisions(project,run).find(r=>r.name.endsWith('/cancelled'))!;
 const evidence:any=svc.runLedger().readRevision(saved.id,project).content;
 expect(evidence).toMatchObject({status:'cancelled',observation:observed,modelRequests:[request]});
 expect(evidence.serviceObservation.stages).toContainEqual(expect.objectContaining({stage:'dispatch',status:'cancelled',model:{source:'role-proxy',forwarded:1,blocked:0}}));
 const batch:any=svc.runLedger().db.prepare('SELECT json FROM preparation_batches WHERE id=?').get(b.batchId);expect(JSON.parse(batch.json).calls).toBe(1);
 const spend=await import('../src/roleSpend.js');expect(spend.runRoleSpend(run,project).roles.find(r=>r.role==='executor')?.calls).toBeGreaterThanOrEqual(1);
 const resumed=await start('retry');expect(resumed.batchId).toBe(b.batchId);expect(prep.preparationStatus(run,project)?.units[0].status).toBe('pending');
 await prep.cancelPreparation(run,project);
});
it('recovers running queues as interrupted and bounds long event messages',async()=>{
 await start();prep.recoverPreparations();expect(prep.preparationStatus(run,project)?.status).toBe('interrupted');
 const b=await start();fake.run.mockResolvedValueOnce(result());await step(b.batchId,{action:'probe',caseId:'c1',setupSteps:[],reason:'Inspect'});await vi.waitFor(()=>expect(prep.preparationStatus(run,project)?.units[0].status).toBe('planning'));await step(b.batchId,{action:'resolve',caseId:'c1',status:'blocked',reason:'x'.repeat(3500)});expect((await step(b.batchId,{action:'next'})).status).toBe('partial');
});

it('exhausts per-case retries and never creates a verified bundle from failures',async()=>{
 const b=await start();for(let round=0;round<2;round++){fake.run.mockResolvedValueOnce(result('failed'));await step(b.batchId,{action:'trial',caseId:'c1',content:original,reason:'Try recovery'});await vi.waitFor(()=>expect(prep.preparationStatus(run,project)?.units[0].status).toBe(round===0?'repair':'exhausted'));}
 const end:any=await step(b.batchId,{action:'next'});expect(end.status).toBe('partial');expect(end.codeRevision).toBeUndefined();
});
it('invalidates verified plans when approval is revoked',async()=>{
 const b=await start();fake.run.mockResolvedValueOnce(result());await step(b.batchId,{action:'trial',caseId:'c1',content:original,reason:'Trial'});await vi.waitFor(()=>expect(prep.preparationStatus(run,project)?.summary.verified).toBe(1));const end:any=await step(b.batchId,{action:'next'});
 approvals.decideRevisions(run,project,{items:[{caseId:'c1',revisionId:revision,decision:'rejected'}],note:'Review changed'},{kind:'human',id:'fixture'});
 expect(()=>approvals.approvedExecutionBundle(run,project,end.codeRevision)).toThrow('preparation_approval_changed');
});
it('rejects a forged passed resolution and freezes reviewed oracle values',async()=>{
 approvals.decideRevisions(run,project,{items:[{caseId:'c1',revisionId:revision,decision:'approved'}]},{kind:'human',id:'fixture'});
 const b=await start();await expect(step(b.batchId,{action:'resolve',caseId:'c1',status:'verified',reason:'trust me'})).rejects.toThrow();
 await expect(step(b.batchId,{action:'trial',caseId:'c1',content:{...original,oracle:{kind:'text',value:'Anything'}},reason:'Weakened'})).rejects.toThrow('approved_oracle_frozen');
 await prep.cancelPreparation(run,project);
});

it('requires environment evidence before blocking and never treats a passed probe as a verified case',async()=>{
 const b=await start();expect((await step(b.batchId,{action:'resolve',caseId:'c1',status:'blocked',reason:'Not in old docs'})).status).toBe('needs_probe');
 fake.run.mockResolvedValueOnce({...result(),observations:[{text:'Count: 0',url:'http://localhost:9876',step:0,capturedAt:1}]});
 await step(b.batchId,{action:'probe',caseId:'c1',setupSteps:['Open counter panel'],reason:'Reach the control'});
 await vi.waitFor(()=>expect(prep.preparationStatus(run,project)?.units[0].status).toBe('planning'));
 const next:any=await step(b.batchId,{action:'next'});expect(next.probeResult.observations[0].text).toBe('Count: 0');expect(prep.preparationStatus(run,project)?.summary.verified).toBe(0);
 fake.run.mockResolvedValueOnce(result());await step(b.batchId,{action:'trial',caseId:'c1',content:original,reason:'Use observed control'});
 await vi.waitFor(()=>expect(prep.preparationStatus(run,project)?.summary.verified).toBe(1));
 expect(fake.run.mock.calls.at(-1)![0].opts.preparation.steps).toEqual(['Open counter panel']);
 const end:any=await step(b.batchId,{action:'next'});const bundle:any=approvals.approvedExecutionBundle(run,project,end.codeRevision);expect(bundle.preparation.c1.steps).toEqual(['Open counter panel']);
 expect(()=>prep.validatePreparedBundle(run,project,{...bundle,preparation:{c1:{steps:[],checks:[]}}})).toThrow('prepared_setup_changed');
 const retry=await start('retry');expect(retry.batchId).toBe(b.batchId);expect(prep.preparationStatus(run,project)?.summary.verified).toBe(1);await step(retry.batchId,{action:'next'});
 const fresh=await start('all');expect(fresh.batchId).not.toBe(b.batchId);expect(prep.preparationStatus(run,project)?.summary).toMatchObject({verified:0,historicalVerified:1});await prep.cancelPreparation(run,project);
});
it('discards a late probe receipt on cancellation',async()=>{
 const b=await start();let resolve!:(v:any)=>void;fake.run.mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));
 await step(b.batchId,{action:'probe',caseId:'c1',setupSteps:[],reason:'Inspect'});await vi.waitFor(()=>expect(resolve).toBeTypeOf('function'));await prep.cancelPreparation(run,project);resolve(result());await new Promise(r=>setTimeout(r,10));
 expect(prep.preparationStatus(run,project)?.summary.verified).toBe(0);
});

it('versions changed plans and instructions when retrying the same batch',async()=>{
 const b=await start();fake.run.mockResolvedValueOnce(result('failed'));await step(b.batchId,{action:'trial',caseId:'c1',content:original,reason:'First plan'});await vi.waitFor(()=>expect(prep.preparationStatus(run,project)?.units[0].status).toBe('repair'));
 await prep.cancelPreparation(run,project);const retry=await start('retry');expect(retry.batchId).toBe(b.batchId);
 fake.run.mockResolvedValueOnce(result());await step(b.batchId,{action:'trial',caseId:'c1',content:{...original,steps:['Open counter','Click Increment']},reason:'Changed plan after retry'});
 await vi.waitFor(()=>expect(prep.preparationStatus(run,project)?.summary.verified).toBe(1));await step(b.batchId,{action:'next'});
 const plans=svc.runLedger().listRevisions(project,run).filter(r=>r.name===`preparation/${b.batchId}/c1/round-1/plan`);expect(plans.map(r=>r.revision).sort()).toEqual([1,2]);
});

it('keeps supplementary checks separate, frozen and unable to redefine original acceptance',async()=>{
 const b=await start(),before=fake.run.mock.calls.length;
 await expect(step(b.batchId,{action:'trial',caseId:'c1',content:original,reason:'Bad reference',auxiliaryAssertions:[{id:'extra',statement:'Extra',supports:['missing']}]})).rejects.toThrow('auxiliary_assertion_invalid');
 expect(fake.run).toHaveBeenCalledTimes(before);
 const extra={id:'sum',statement:'The displayed total is conserved',supports:['a1'],afterStep:1};
 fake.run.mockResolvedValueOnce({...result(),auxiliaryChecks:[{id:'sum',status:'pass',supports:['a1']}]});await step(b.batchId,{action:'trial',caseId:'c1',content:original,reason:'Add conservation diagnostic',auxiliaryAssertions:[extra]});
 await vi.waitFor(()=>expect(prep.preparationStatus(run,project)?.summary.verified).toBe(1));
 expect(fake.run.mock.calls.at(-1)![0].opts.assertions).toEqual(original.assertions);
 expect(fake.run.mock.calls.at(-1)![0].opts.preparation.auxiliaryAssertions).toEqual([extra]);
 const end:any=await step(b.batchId,{action:'next'}),bundle:any=approvals.approvedExecutionBundle(run,project,end.codeRevision);
 expect(bundle.preparation.c1.auxiliaryAssertions).toEqual([extra]);
 expect(()=>prep.validatePreparedBundle(run,project,{...bundle,preparation:{c1:{...bundle.preparation.c1,auxiliaryAssertions:[]}}})).toThrow('prepared_setup_changed');
});
it('does not classify an auxiliary diagnostic failure as a product defect',async()=>{
 const b=await start();fake.run.mockResolvedValueOnce({...result('failed'),failureReason:'AUXILIARY_CHECK_NOT_VERIFIED: sum'});
 await step(b.batchId,{action:'trial',caseId:'c1',content:original,reason:'Trial'});
 await vi.waitFor(()=>expect(prep.preparationStatus(run,project)?.units[0].status).toBe('repair'));
 await expect(step(b.batchId,{action:'resolve',caseId:'c1',status:'product_defect',reason:'Incorrect inference'})).rejects.toThrow('product_failure_evidence_required');
 await prep.cancelPreparation(run,project);
});
it('delivers a candidate across cases, revalidates it, promotes only from separate trials and freezes delivered context',async()=>{
 const stage=await import('../src/runStages.js');
 const r=svc.registerHostRun(project,{runtime:'codex',externalId:'recipe-loop',idempotencyKey:'recipe-loop',materials:[{name:'panel.md',text:'Open counter panel and increment counter.'}]}).runId;
 stage.loadRunInstructions(r,project);const ref=stage.retrieveRunSpec(r,project,{query:'counter',budgetTokens:1000}).chunks[0].id;
 const stories=[{id:'s1',title:'Counter panel',acceptance:[]}];stage.writeRunStage(r,project,'stories',{stories});
 stage.writeRunStage(r,project,'cases',{stories,cases:['c1','c2'].map(id=>({...original,id,key:id,precondition:['Counter panel ready'],sourceRefs:[ref]}))});stage.gateRun(r,project);stage.finalizeRun(r,project);
 const reviewed=approvals.reviewRevisions(r,project);approvals.decideRevisions(r,project,{items:reviewed.map(c=>({caseId:c.caseId,revisionId:c.revision.id,decision:'approved'}))},{kind:'human',id:'TEST_FIXTURE'});
 const b=await prep.startPreparation(r,project,{mode:'all'});
 const call=(body:any)=>prep.preparationStep(r,project,{batchId:b.batchId,...body});
 const checks=[{statement:'Counter panel ready',checks:[{kind:'screen',statement:'Counter panel ready',oracle:{kind:'text',value:'Counter'}}]}];
 const recipe={capability:'counter.open-panel',requires:['Counter panel ready'],entryChecks:[{statement:'Correct target',checks:[{kind:'environment',fact:'target-origin',expected:'http://localhost:9876'}]}],steps:['Open counter panel'],postconditions:checks,sideEffects:'ui-only',cleanup:[]};
 const receipt=()=>({...result(),prerequisiteChecks:[{statement:'Counter panel ready',status:'pass'}],recipeChecks:[{statement:'Correct target',phase:'entry',status:'pass'},{statement:'Counter panel ready',phase:'postcondition',status:'pass'}]});
 let candidate:any;
 for(const c of reviewed){
   const before:any=await call({action:'next'});
   expect(before.prerequisiteChecks[0].checks[0].kind).toBe('unknown');
   if(c.caseId==='c2'){candidate=before.experienceContext;expect(candidate.recipes).toHaveLength(1);expect(candidate.recipes[0].status).toBe('candidate');}
   fake.run.mockResolvedValueOnce(receipt());
   await call({action:'probe',caseId:c.caseId,reason:'Inspect panel',prerequisiteChecks:checks,...(candidate?{recipeRef:{id:candidate.recipes[0].id,version:candidate.recipes[0].version}}:{recipe})});
   await vi.waitFor(()=>expect(prep.preparationStatus(r,project)?.units.find(u=>u.unitId===c.caseId)?.status).toBe('planning'));
   await call({action:'next'});
   fake.run.mockResolvedValueOnce(receipt());await call({action:'trial',caseId:c.caseId,reason:'Verify case',content:c.content});
   await vi.waitFor(()=>expect(prep.preparationStatus(r,project)?.units.find(u=>u.unitId===c.caseId)?.status).toBe('verified'));
 }
 const end:any=await call({action:'next'});expect(end.status).toBe('done');
 const experience=svc.runLedger().listRevisions(project,r).filter(v=>v.name===`preparation/${b.batchId}/experience`).sort((a,b)=>b.revision-a.revision)[0];
 expect((svc.runLedger().readRevision(experience.id,project).content as any).entries[0].status).toBe('verified-reusable');
 expect((svc.runLedger().readRevision(candidate.revision,project).content as any).recipes[0].status).toBe('candidate');
 const bundle:any=approvals.approvedExecutionBundle(r,project,end.codeRevision);expect(bundle.preparation.c2.recipe).toEqual(recipe);
});

it('stores measured dispatch failure in preparation receipts without manufacturing model usage',async()=>{
 const b=await start();fake.run.mockRejectedValueOnce(new Error('runner disconnected'));
 await step(b.batchId,{action:'trial',caseId:'c1',content:original,reason:'Try runner'});
 await vi.waitFor(()=>expect(prep.preparationStatus(run,project)?.units[0].status).toBe('blocked'));
 const saved=svc.runLedger().listRevisions(project,run).find(r=>r.name.startsWith(`preparation/${b.batchId}/c1/error/`))!;
 const next:any={result:svc.runLedger().readRevision(saved.id,project).content};
 expect(next.result.lifecycle.safeToRetry).toBe(false);
 expect(next.result.observation.stages).toContainEqual(expect.objectContaining({stage:'dispatch',status:'failed',model:{source:'unavailable',forwarded:null,blocked:null}}));
 expect(next.result.modelRequests).toBeUndefined();await prep.cancelPreparation(run,project);
});

it('retains a cancelled generation receipt and spend when resume wins the race',async()=>{
 const b=await start();let finish!:(v:any)=>void;fake.run.mockImplementationOnce(()=>new Promise(r=>{finish=r;}));
 await step(b.batchId,{action:'trial',caseId:'c1',content:original,reason:'Start old attempt'});
 await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));
 await prep.cancelPreparation(run,project);await start('retry');
 finish({...result(),modelRequests:[{requestId:'late-old-generation',at:new Date().toISOString(),forwarded:true,role:'executor',model:'fixture',endpoint:'https://executor.test/v1',thinking:false,status:200,ms:1}]});
 await vi.waitFor(()=>expect(svc.runLedger().listRevisions(project,run).some(r=>r.name.endsWith('/late-result'))).toBe(true));
 expect(prep.preparationStatus(run,project)?.units[0].status).toBe('pending');expect(prep.preparationStatus(run,project)?.summary.verified).toBe(0);
 const batch:any=svc.runLedger().db.prepare('SELECT json FROM preparation_batches WHERE id=?').get(b.batchId);expect(JSON.parse(batch.json).calls).toBe(1);
 await prep.cancelPreparation(run,project);
});

it('carries a reviewed lifecycle through probe, trial, frozen prepared bundle and formal dispatch; freezes obligations',async()=>{
 const stage=await import('../src/runStages.js');
 const p=db.createProject('Lifecycle service boundary','http://localhost:9876').id;
 const r=svc.registerHostRun(p,{runtime:'codex',externalId:'lifecycle',idempotencyKey:'lifecycle',materials:[{name:'resource.md',text:'Create an isolated resource and delete it after verification. Ready screen.'}]}).runId;
 stage.loadRunInstructions(r,p);const ref=stage.retrieveRunSpec(r,p,{query:'resource',budgetTokens:2000}).chunks[0].id;
 const identity='owned-${env.TP_LIFECYCLE_ID}',check=(value:string,kind='text')=>({statement:value,checks:[{kind:'screen',statement:value,oracle:{kind,value}}]});
 const lifecycle={version:1,mode:'controlled',rationale:'Own isolated resource',sourceRefs:[ref],supports:['$expected'],baseline:[check('Ready')],resources:[{id:'r',sourceRef:ref,identity,establishAfterStep:1,established:check(identity),ownership:check(identity)}],cleanup:[{id:'clean',resourceId:'r',postStep:1,verified:check(identity,'noText')}]};
 const stories=[{id:'s1',title:'Resource',acceptance:[]}];
 stage.writeRunStage(r,p,'stories',{stories});stage.writeRunStage(r,p,'cases',{stories,cases:[{id:'c1',storyId:'s1',title:'Resource',designMethod:'boundary',precondition:['Ready'],steps:['Click Create '+identity],postSteps:['Click Delete '+identity],expected:'Resource visible',oracle:{kind:'text',value:'Resource'},tier:1,key:'resource',sourceRefs:[ref],lifecycle,readiness:{design:'candidate',execution:'blocked',reason:'Needs trial'}}]});const gate=stage.gateRun(r,p);expect(gate.report.findings.filter(f=>f.severity==='warn')).toEqual([]);stage.finalizeRun(r,p);
 const reviewed=approvals.reviewRevisions(r,p)[0];approvals.decideRevisions(r,p,{items:[{caseId:'c1',revisionId:reviewed.revision.id,decision:'approved'}]},{kind:'human',id:'test-human'});
 const b=await prep.startPreparation(r,p,{revisionIds:[reviewed.revision.id],maxRounds:2});
 const call=(body:any)=>prep.preparationStep(r,p,{batchId:b.batchId,caseId:'c1',...body});
 fake.run.mockResolvedValueOnce({...result(),prerequisiteChecks:[{statement:'Ready',status:'pass'}]});
 await call({action:'probe',setupSteps:[],prerequisiteChecks:[check('Ready')],reason:'Read initial screen'});
 await vi.waitFor(()=>expect(prep.preparationStatus(r,p)?.units[0].status).toBe('planning'));
 expect(fake.run.mock.calls.at(-1)?.[0].opts.lifecycle).toBeUndefined();expect(fake.run.mock.calls.at(-1)?.[0].steps).toEqual([]);
 const receipt={version:1,status:'pass',checks:[],cleanup:[{id:'clean',resourceId:'r',postStep:1,status:'pass',detail:'Absent'}],pendingResources:[],safeToRetry:false};
 fake.run.mockResolvedValueOnce({...result(),prerequisiteChecks:[{statement:'Ready',status:'pass'}],lifecycle:receipt});
 await call({action:'trial',content:reviewed.content,reason:'Trial exact reviewed lifecycle'});
 await vi.waitFor(()=>expect(prep.preparationStatus(r,p)?.summary.verified).toBe(1));
 expect(fake.run.mock.calls.at(-1)?.[0].opts.lifecycle).toEqual(lifecycle);expect(fake.run.mock.calls.at(-1)?.[0].opts.resolve.env.TP_LIFECYCLE_ID).toBeUndefined();
 const frozen:any=await call({action:'next'});const bundle=approvals.approvedExecutionBundle(r,p,frozen.codeRevision);expect(bundle.cases[0].lifecycle).toEqual(lifecycle);
 const execution=await import('../src/workflowExecution.js');fake.run.mockResolvedValueOnce({...result(),lifecycle:receipt});
 const formal=execution.startWorkflowExecution(r,p,{codeRevision:frozen.codeRevision,idempotencyKey:'formal-lifecycle'});
 await vi.waitFor(()=>expect(execution.listWorkflowExecutions(r,p).find(x=>x.id===formal.executionId)?.status).toBe('passed'));
 expect(fake.run.mock.calls.at(-1)?.[0].opts.lifecycle).toEqual(lifecycle);expect(fake.run.mock.calls.at(-1)?.[0].opts.sourceRefs).toEqual([ref]);
 const b2=await prep.startPreparation(r,p,{revisionIds:[reviewed.revision.id],mode:'all'});
 expect((await prep.preparationStep(r,p,{batchId:b2.batchId,caseId:'c1',action:'trial',content:{...reviewed.content,lifecycle:{...lifecycle,cleanup:[]}},reason:'Cannot drop cleanup'})).status).toBe('needs_review');
});
