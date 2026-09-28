import {beforeAll,afterAll,it,expect,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {canonicalJSON} from '@testpilot/harness-core/run-contracts';
import {captureWebModels} from './helpers/model-snapshot.js';
/**
 * docs/reports/workflow-review-2026-09-24.md §2.5 的几条缺陷：
 * 证据重复计数、证据门槛太宽、未审核发现建任务、增量上下文超限整体失败、后台失败被吞、blocked 无恢复路径。
 */
const chat=vi.hoisted(()=>vi.fn());vi.mock('../src/plannerHost.js',()=>({savedHost:()=> 'codex',requireHost:async()=> 'codex',nativeHostChat:chat}));
vi.mock('../src/modelSnapshots.js',async()=>({captureHostWebModels:(await import('./helpers/model-snapshot.js')).captureHostWebModels}));
let dir:string,project:string,service:typeof import('../src/runService.js'),database:typeof import('../src/db.js'),assets:import('../src/projectAssets.js').ProjectAssets,tasks:import('../src/projectTasks.js').ProjectTasks,discoveries:import('../src/projectDiscoveries.js').ProjectDiscoveries,incremental:typeof import('../src/projectIncremental.js');
const human={kind:'human' as const,id:'reviewer'},explorer={kind:'system' as const,id:'explorer'};
const binding=()=>({schemaVersion:1 as const,models:captureWebModels().binding,skillVersion:'test',loadedDigest:'a'.repeat(64),materialsHash:null,inputHash:null,environmentHash:null,materialRevisions:[]});
const register=(key:string,parameters:Record<string,unknown>={})=>service.runLedger().register({projectId:project,externalId:key,idempotencyKey:key,binding:binding(),parameters},{kind:'system',id:'fixture'}).runId;
const report=(featureId:string,extra:Record<string,unknown>={})=>({observations:[{status:'blocked',featureId,reason:'Needs an open position'}],...extra});
let snapshot:string;
beforeAll(async()=>{dir=mkdtempSync(join(tmpdir(),'tp-evolution-fix-'));vi.stubEnv('TP_DATA_DIR',dir);database=await import('../src/db.js');service=await import('../src/runService.js');project=database.createProject('Evolution fixes','http://localhost').id;
 assets=new (await import('../src/projectAssets.js')).ProjectAssets(service.runLedger());tasks=new (await import('../src/projectTasks.js')).ProjectTasks(service.runLedger());discoveries=new (await import('../src/projectDiscoveries.js')).ProjectDiscoveries(service.runLedger());incremental=await import('../src/projectIncremental.js');
 const run=register('assets');const source=service.runLedger().putRevision({projectId:project,runId:run,name:'rules',kind:'material',content:{v:1}},{kind:'system',id:'fixture'});const v=assets.propose(project,{assetKey:'rules',sourceRevision:source.id,baseVersion:null},human);assets.decide(project,v.id,{action:'adopt',expectedHead:null,reason:'fixture'},human);snapshot=assets.snapshot(project,'Initial',human).id;
});
afterAll(()=>{service.runLedger().close();database.db.close();vi.unstubAllEnvs();rmSync(dir,{recursive:true,force:true});});
const findingFor=(featureId:string)=>discoveries.list(project).find(d=>d.featureId===featureId)!;
/** 各用例自己造一条执行器回执与对应的发现，不依赖前面的用例。 */
const executionFinding=(caseId:string,triage=true)=>{const run=register('exec-'+caseId);service.runLedger().putRevision({projectId:project,runId:run,name:'execution/'+caseId,kind:'execution',content:{status:'failed',results:[{caseId,failureReason:'Row missing for '+caseId}]}},{kind:'system',id:'workflow-executor'});const d=findingFor(caseId);if(triage)discoveries.decide(project,d.id,'triaged','Reviewed receipt',human);return findingFor(caseId);};

it('fork copies and identical receipts do not add independent evidence to a discovery',()=>{
 const ledger=service.runLedger(),original=register('fork-original');
 const first=ledger.putRevision({projectId:project,runId:original,name:'exploration/report',kind:'report',content:report('fork.feature')},explorer);
 expect(findingFor('fork.feature').refs).toEqual([first.id]);
 // 从节点重跑把报告原样复制进新运行（rerun，sourceRefs 指向原件）——跑 6 次。
 for(let i=0;i<6;i++){const fork=register('fork-'+i);ledger.putRevision({projectId:project,runId:fork,name:'exploration/report',kind:'report',content:report('fork.feature'),sourceRefs:[first.id]},{kind:'system',id:'rerun'});}
 // 另一次运行写下一字不差的同一份报告：同内容哈希，也不算独立证据。
 const same=register('fork-same-content');ledger.putRevision({projectId:project,runId:same,name:'exploration/report',kind:'report',content:report('fork.feature')},explorer);
 expect(findingFor('fork.feature').refs).toEqual([first.id]);
 // 内容不同的新观察仍然会追加。
 const fresh=register('fork-fresh');const other=ledger.putRevision({projectId:project,runId:fresh,name:'exploration/report',kind:'report',content:report('fork.feature',{screens:2})},explorer);
 expect(findingFor('fork.feature').refs).toEqual([first.id,other.id]);
});

it('only real observation/execution receipts count as evidence; user knowledge and planner text do not',()=>{
 const ledger=service.runLedger(),run=register('gate');
 const knowledge=ledger.putRevision({projectId:project,runId:run,name:'knowledge/notes.md',kind:'report',content:{name:'notes.md',text:'User says the close button is missing',trust:'user-provided'}},{kind:'system',id:'web'});
 const proposal=ledger.putRevision({projectId:project,runId:run,name:'project/incremental-proposal',kind:'report',content:{proposal:{summary:'model text'}}},{kind:'system',id:'project-planner'});
 const wrongActor=ledger.putRevision({projectId:project,runId:run,name:'exploration/report',kind:'report',content:report('gate.actor')},{kind:'system',id:'web'});
 for(const ref of [knowledge.id,proposal.id,wrongActor.id])expect(()=>discoveries.record(project,{runId:run,evidenceRef:ref,category:'capability',featureId:'gate.x',observation:'x'},human)).toThrow('discovery_requires_system_receipt');
 expect(discoveries.list(project).some(d=>d.featureId==='gate.actor')).toBe(false);
 // 真实回执：探索观察、准备控制器的回合结果、执行器批次结果。
 const observations=ledger.putRevision({projectId:project,runId:run,name:'exploration/observations',kind:'report',content:{notes:'seen'}},explorer);
 const prep=ledger.putRevision({projectId:project,runId:run,name:'preparation/b1/C-1/round-1/result',kind:'report',content:{status:'failed',caseId:'C-1',failureReason:'Position not open'}},{kind:'system',id:'preparation-controller'});
 const exec=ledger.putRevision({projectId:project,runId:run,name:'execution/e1',kind:'execution',content:{status:'failed',results:[{caseId:'C-2',failureReason:'Row missing'}]}},{kind:'system',id:'workflow-executor'});
 expect(discoveries.record(project,{runId:run,evidenceRef:observations.id,category:'capability',featureId:'gate.ok',observation:'ok'},human).refs).toEqual([observations.id]);
 expect(findingFor('C-1').refs).toEqual([prep.id]);expect(findingFor('C-2').refs).toEqual([exec.id]);
});

it('tasks can only be created from human-triaged discoveries',()=>{
 const d=executionFinding('T-UNREVIEWED',false);expect(d.status).toBe('unreviewed');
 expect(()=>tasks.create(project,{snapshotId:snapshot,discoveryIds:[d.id],target:'stories',goal:'Unreviewed'})).toThrow('discovery_review_required');
 discoveries.decide(project,d.id,'triaged','Reviewed receipt',human);
 expect(tasks.create(project,{snapshotId:snapshot,discoveryIds:[d.id],target:'stories',goal:'Reviewed'}).status).toBe('pending');
});

it('incremental context keeps one copy per content and truncates oversized evidence into labelled excerpts',()=>{
 const ledger=service.runLedger(),run=register('big');
 const big=ledger.putRevision({projectId:project,runId:run,name:'exploration/report',kind:'report',content:report('big.feature',{notes:'x'.repeat(250_000)})},explorer);
 const d=findingFor('big.feature');discoveries.decide(project,d.id,'triaged','Large receipt',human);
 // 旧数据里已经有的重复引用（fork 复制件）：直接写进发现，看上下文只放一份。
 const copies=[1,2,3].map(i=>{const fork=register('big-fork-'+i);return ledger.putRevision({projectId:project,runId:fork,name:'exploration/report',kind:'report',content:ledger.readRevision(big.id,project).content,sourceRefs:[big.id]},{kind:'system',id:'rerun'}).id;});
 const legacy={...findingFor('big.feature'),refs:[big.id,...copies]};ledger.db.prepare('UPDATE project_discoveries SET json=? WHERE id=?').run(canonicalJSON(legacy),d.id);
 const task=tasks.create(project,{snapshotId:snapshot,discoveryIds:[d.id],target:'stories',goal:'Large evidence'});
 const context=incremental.incrementalContext(project,task.id);
 expect(context.evidence).toHaveLength(1);expect(context.evidence[0]!.aliases).toEqual(copies);
 expect(canonicalJSON(context).length).toBeLessThanOrEqual(incremental.INCREMENTAL_CONTEXT_LIMIT);
 expect(context.truncatedEvidence).toEqual([big.id]);
 const excerpt=context.evidence[0]!.excerpt!;expect(excerpt.truncated).toBe(true);expect(excerpt.originalChars).toBeGreaterThan(250_000);expect(excerpt.keptChars).toBeLessThan(excerpt.originalChars);expect(excerpt.note).toContain(big.id);expect(excerpt.note).toMatch(/omitted/);
 // 复制件的 id 仍可被提案引用。
 expect(()=>incremental.validateIncrementalProposal(context,{summary:'x',changes:[{assetKey:'story/new',baseVersion:null,kind:'stories',content:{},dependencies:[],evidenceRefs:[copies[0]],reason:'x'}],followUps:[]})).not.toThrow();
});

it('background task failures are written back to the task instead of being swallowed',async()=>{
 const d=executionFinding('T-BACKGROUND');const parent=tasks.create(project,{snapshotId:snapshot,discoveryIds:[d.id],target:'stories',goal:'Parent'});const child=tasks.create(project,{snapshotId:snapshot,discoveryIds:[d.id],target:'stories',goal:'Child',dependsOn:[parent.id]});
 const {default:express}=await import('express');const {projectAssetRouter}=await import('../src/projectAssetRoutes.js');const app=express();app.use(express.json());app.use('/api/projects/:projectId/assets',projectAssetRouter());const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
 const base=`http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/api/projects/${project}/assets`;
 try{
  // 领取时就被拒（依赖未完成）：原来 .catch(()=>{}) 吞掉，界面永远只看到 queued。
  expect((await fetch(base+'/tasks/'+child.id+'/run',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status).toBe(202);
  await vi.waitFor(async()=>{const listed=(await (await fetch(base+'/tasks')).json()).tasks.find((t:any)=>t.id===child.id);expect(listed.lastError?.code).toBe('task_dependencies_pending');});
  // 规划中途失败：状态回到 pending，原因与最近一次失败都写在任务上。
  chat.mockRejectedValueOnce(new Error('planner_host_crashed'));
  expect((await fetch(base+'/tasks/'+parent.id+'/run',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status).toBe(202);
  await vi.waitFor(async()=>{const listed=(await (await fetch(base+'/tasks')).json()).tasks.find((t:any)=>t.id===parent.id);expect(listed).toMatchObject({status:'pending',reason:'planner_host_crashed',lastError:{code:'planner_host_crashed'}});});
  expect(tasks.events(project,parent.id).some(e=>e.event==='failed:planner_host_crashed')).toBe(true);
 }finally{await new Promise<void>(r=>server.close(()=>r()));}
});

it('a follow-up blocked by a later human adoption can be rebaselined by a human on current asset versions',()=>{
 const ledger=service.runLedger(),d=executionFinding('T-REBASE');
 const t=tasks.create(project,{snapshotId:snapshot,discoveryIds:[d.id],target:'stories',goal:'Rebaseline me',assetKeys:['rules']});
 // 快照之后，人采纳了 rules 的新版本：任务输入过期。
 const run=register('adopt-later');const src=ledger.putRevision({projectId:project,runId:run,name:'rules',kind:'material',content:{v:2}},{kind:'system',id:'fixture'});const head=assets.heads(project).rules!;
 const v=assets.propose(project,{assetKey:'rules',sourceRevision:src.id,baseVersion:head},human);assets.decide(project,v.id,{action:'adopt',expectedHead:head,reason:'Later adoption'},human);
 expect(tasks.claim(project,t.id,'worker')).toMatchObject({status:'blocked',reason:'asset_inputs_changed_replan'});
 expect(()=>tasks.claim(project,t.id,'worker')).toThrow('task_not_claimable');
 expect(()=>tasks.rebaseline(project,t.id,'Adopted rules v2',{kind:'agent',id:'planner'})).toThrow('operator_action_required');
 const rebased=tasks.rebaseline(project,t.id,'Adopted rules v2',human);
 expect(rebased.status).toBe('pending');expect(rebased.snapshotId).not.toBe(snapshot);expect(assets.readSnapshot(project,rebased.snapshotId).heads.rules).toBe(v.id);
 expect(tasks.events(project,t.id).find(e=>e.event==='rebaselined')).toMatchObject({actor:human,fromSnapshot:snapshot,toSnapshot:rebased.snapshotId,reason:'Adopted rules v2'});
 // 幂等语义不变：同一份规格再建，拿回的仍是这条任务。
 expect(tasks.create(project,{snapshotId:snapshot,discoveryIds:[d.id],target:'stories',goal:'Rebaseline me',assetKeys:['rules']}).id).toBe(t.id);
 expect(tasks.claim(project,t.id,'worker').status).toBe('claimed');
 expect(()=>tasks.rebaseline(project,t.id,'again',human)).toThrow('task_not_rebaselinable');
});
