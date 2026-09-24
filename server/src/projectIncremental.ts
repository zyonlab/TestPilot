import {createWebWorkflow,configureNextNode,launchSource} from './workflowOps.js';
import {dataPath} from './datadir.js';
import {getProject} from './db.js';
import {createProjectRunPlan,projectPlanInputs} from './projectRunPlans.js';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {canonicalJSON} from '@testpilot/harness-core/run-contracts';
import {runLedger} from './runService.js';
import {ProjectAssets} from './projectAssets.js';
import {ProjectTasks} from './projectTasks.js';
import {ProjectDiscoveries} from './projectDiscoveries.js';
import {nativeHostChat,requireHost} from './plannerHost.js';
import {captureHostWebModels} from './modelSnapshots.js';
import {contentHash,LedgerError} from './runLedger.js';
import type {ArtifactRevision} from '@testpilot/harness-core/run-contracts';
export const IncrementalProposalSchema=z.object({summary:z.string().min(1),noChangeReason:z.string().optional(),changes:z.array(z.object({assetKey:z.string().min(1).max(140),baseVersion:z.string().nullable(),kind:z.enum(['material','stories','cases']),content:z.unknown().refine(v=>v!==undefined,'content_required'),dependencies:z.array(z.string()),evidenceRefs:z.array(z.string()).min(1),reason:z.string().min(1)}).strict()).max(10),followUps:z.array(z.object({target:z.enum(['source','modules','stories','cases','rules']),goal:z.string().min(1),assetKeys:z.array(z.string())}).strict()).max(6)}).strict();
export const INCREMENTAL_CONTRACT='You are the project-wide test planner. Use only supplied immutable assets and receipt-backed candidate discoveries. Prior observations are not current state. Preserve stable asset and story/case identities; propose only changes necessary for this task. Distinguish UI paths, state prerequisites, business rules, and new capabilities. Never weaken approved acceptance to make execution pass. New business behavior is a hypothesis pending human review. No tools, browser actions, transactions or approvals. Return JSON {summary,noChangeReason?,changes:[{assetKey,baseVersion,kind:material|stories|cases,content,dependencies:[asset version IDs],evidenceRefs:[receipt revision IDs],reason}],followUps:[{target:source|modules|stories|cases|rules,goal,assetKeys}]}. Existing assets must use their exact snapshot baseVersion. If evidence is insufficient, propose a bounded source exploration follow-up instead of inventing behavior. If changes is empty, explain noChangeReason. Every content is a complete replacement proposal, not a patch; no unrelated rewrites.';
export const INCREMENTAL_CONTEXT_LIMIT=180000;
export type IncrementalEvidence={revision:ArtifactRevision;aliases:string[];content?:unknown;excerpt?:{text:string;truncated:true;originalChars:number;keptChars:number;note:string}};
/**
 * 规划器读到的上下文。两条规矩：
 * - 同内容的回执只放一份（fork 复制出来的报告内容一字不差，放七遍只是把上限吃光）；复制件的 id 记在 aliases 里，仍可被引用。
 * - 超过上限时，证据按比例截成**有来源标注的摘录**（写明是哪条修订、原长多少、留了多少、其余被截掉），而不是整体失败。
 *   资产与发现本身不截：提案要整份替换资产，截了就是让模型照着残篇重写。它们自己就超限时才报 task_context_too_large_split_task。
 */
export function incrementalContext(project:string,id:string,limit=INCREMENTAL_CONTEXT_LIMIT){const ledger=runLedger(),task=new ProjectTasks(ledger).read(project,id),assets=new ProjectAssets(ledger),snapshot=assets.readSnapshot(project,task.snapshotId),discoveries=task.discoveryIds.map(d=>new ProjectDiscoveries(ledger).read(project,d));
 const unique=new Map<string,IncrementalEvidence>();
 for(const ref of [...new Set(discoveries.flatMap(d=>d.refs))]){const {revision,content}=ledger.readRevision(ref,project),key=revision.contentHash,prior=unique.get(key);if(prior){prior.aliases.push(revision.id);continue;}unique.set(key,{revision,aliases:[],content});}
 const evidence=[...unique.values()],base={task,snapshot,assets:Object.values(snapshot.heads).map(v=>assets.read(project,v)),discoveries};
 const full={...base,evidence,truncatedEvidence:[] as string[]};if(canonicalJSON(full).length<=limit)return full;
 const texts=new Map(evidence.map(e=>[e.revision.id,typeof e.content==='string'?e.content:canonicalJSON(e.content)]));
 const bare=(e:IncrementalEvidence)=>({revision:e.revision,aliases:e.aliases});
 const excerpt=(e:IncrementalEvidence,keep:number):IncrementalEvidence=>{const text=texts.get(e.revision.id)!;if(text.length<=keep)return e;return {...bare(e),excerpt:{text:text.slice(0,keep),truncated:true,originalChars:text.length,keptChars:keep,note:`Truncated excerpt of revision ${e.revision.id} (${e.revision.name}, run ${e.revision.runId}): first ${keep} of ${text.length} characters; the rest was omitted to fit the planner context. Nothing may be inferred about the omitted part; propose a bounded follow-up if it matters.`}};};
 // 按长度注水：短的整份保留，剩下的额度平分给长的；JSON 转义会让摘录变长，所以量一次、不够再收紧。
 let budget=limit-canonicalJSON({...base,evidence:evidence.map(bare),truncatedEvidence:evidence.map(e=>e.revision.id)}).length-evidence.length*700;
 for(let round=0;round<6&&budget>0;round++){
  const sorted=[...evidence].sort((a,b)=>texts.get(a.revision.id)!.length-texts.get(b.revision.id)!.length);let left=budget,keepFor=new Map<string,number>();
  sorted.forEach((e,i)=>{const share=Math.floor(left/(sorted.length-i)),size=texts.get(e.revision.id)!.length,keep=Math.max(0,Math.min(size,share));keepFor.set(e.revision.id,keep);left-=keep;});
  const cut=evidence.map(e=>excerpt(e,keepFor.get(e.revision.id)!)),context={...base,evidence:cut,truncatedEvidence:cut.filter(e=>e.excerpt).map(e=>e.revision.id)};
  const size=canonicalJSON(context).length;if(size<=limit)return context;budget=Math.floor(budget*limit/size*0.9);
 }
 throw new LedgerError(413,'task_context_too_large_split_task');
}
export function validateIncrementalProposal(context:ReturnType<typeof incrementalContext>,raw:unknown){const proposal=IncrementalProposalSchema.parse(raw),allowed=new Set(context.evidence.flatMap(e=>[e.revision.id,...e.aliases]));if(!proposal.changes.length&&!proposal.noChangeReason?.trim())throw new LedgerError(400,'no_change_reason_required');const keys=new Set<string>();for(const c of proposal.changes){if(keys.has(c.assetKey))throw new LedgerError(400,'duplicate_proposed_asset');keys.add(c.assetKey);if(c.baseVersion!==(context.snapshot.heads[c.assetKey]??null))throw new LedgerError(409,'proposal_base_mismatch');if(c.dependencies.some(id=>!context.snapshot.versions.includes(id))||c.evidenceRefs.some(id=>!allowed.has(id)))throw new LedgerError(409,'proposal_provenance_invalid');if(context.task.assetKeys.length&&context.snapshot.heads[c.assetKey]&&!context.task.assetKeys.includes(c.assetKey))throw new LedgerError(409,'proposal_out_of_scope');}return proposal;}
export async function runProjectTask(project:string,id:string){const ledger=runLedger(),tasks=new ProjectTasks(ledger),claimed=tasks.claim(project,id,'project-planner',Date.now(),tasks.read(project,id).target==='source'?900000:300000);if(claimed.status!=='claimed')return claimed;const token=claimed.lease!.token;
 try{
 const runtime=await requireHost(project);
 const context=incrementalContext(project,id),serialized=canonicalJSON(context);
 if(claimed.target==='source'){
  const origin=context.discoveries[0]!.runId,knowledge=ledger.listRevisions(project,origin).filter(r=>r.name.startsWith('knowledge/')).map(r=>ledger.readRevision(r.id,project).content as any);
  const packs=knowledge.filter(k=>k.rulePack).map(k=>k.rulePack);
  // Source tasks may open UI controls, never gain state-change authorization from a discovery.
  if(!packs.length||packs.some(p=>p.targets?.some((t:any)=>t.sideEffect==='state-change')))throw new LedgerError(409,'source_task_requires_readonly_rulepack');
  const plan=createProjectRunPlan(project,{mode:'incremental',snapshotId:claimed.snapshotId,label:claimed.goal.slice(0,180),configuration:{sourceKind:'explore',sourceUrl:getProject(project)!.targetUrl,planner:runtime,maxScreens:8,workUnits:packs.length>0,exploreActions:'interact',exploreWallet:false,rulePackSelection:null,knowledgeSelection:null,rulePacks:packs,knowledge:[...knowledge.filter(k=>typeof k.text==='string').map(k=>({name:k.name,text:k.text,roles:k.roles??['source','stories']})),{name:'targeted-exploration.md',text:claimed.goal,roles:['source','stories']} ]}});
  const freshId='run-'+randomUUID(),created=await createWebWorkflow(project,projectPlanInputs(project,plan.id),{runId:freshId,node:'source',fresh:true});
  ledger.db.prepare('UPDATE project_run_plans SET runId=? WHERE id=?').run(created.wfRunId,plan.id);configureNextNode(created.wfRunId,project,'source');
  await launchSource(created.wfRunId,project,dataPath('uploads/'+created.wfRunId),ledger.requireRun(created.wfRunId,project).input.parameters as any);
  const output=ledger.listRevisions(project,created.wfRunId).filter(r=>r.name==='exploration/report').at(-1);if(!output||!ledger.getRun(created.wfRunId,project).nodes.some(n=>n.node==='source'&&n.phase==='done'))throw new LedgerError(409,'targeted_exploration_no_receipt');
  const discoveryIds=new ProjectDiscoveries(ledger).list(project).filter(d=>d.refs.includes(output.id)).map(d=>d.id);
  return tasks.complete(project,id,token,{runId:created.wfRunId,report:output.id,summary:'Targeted exploration produced fresh evidence; review gaps before downstream planning.',discoveryIds,followUps:[{target:'stories',goal:'Reconcile fresh exploration evidence with the lifecycle and propose affected stories',assetKeys:claimed.assetKeys}]});
 }
 const response=await nativeHostChat(runtime,{stable:INCREMENTAL_CONTRACT,variable:serialized,maxTokens:8000,label:'project.incremental'},{timeoutMs:240000});
 const proposal=validateIncrementalProposal(context,JSON.parse(response.text.trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'')));
 return ledger.db.transaction(()=>{
 // Check ownership before persisting output; an expired worker must not publish a stale proposal.
 const latest=tasks.read(project,id);if(latest.lease?.token!==token||latest.lease.until<Date.now())throw new LedgerError(409,'task_lease_invalid');
 const runId='run-'+randomUUID(),models=captureHostWebModels(runId,project,runtime),source=ledger.requireRun(context.discoveries[0]!.runId,project);
 ledger.register({id:runId,projectId:project,externalId:id+':'+claimed.attempts,idempotencyKey:id+':'+claimed.attempts,template:'project-incremental',binding:{...source.binding,models:models.binding,materialRevisions:[],materialsHash:null,inputHash:contentHash(serialized),skillVersion:'project-incremental-v1',loadedDigest:contentHash(INCREMENTAL_CONTRACT)},parameters:{projectLineageId:source.input.parameters?.projectLineageId,projectTaskId:id,projectSnapshotId:context.snapshot.id,projectRunMode:'incremental',reuseExperience:false}},{kind:'system',id:'project-planner'});
 const report=ledger.putRevision({projectId:project,runId,name:'project/incremental-proposal',kind:'report',content:{proposal,contextDigest:contentHash(serialized),model:runtime,usage:response.tokens,ms:response.ms},sourceRefs:context.evidence.map(e=>e.revision.id)},{kind:'system',id:'project-planner'});
 const assets=new ProjectAssets(ledger),versions=proposal.changes.map(c=>{const sourceRevision=ledger.putRevision({projectId:project,runId,name:c.assetKey,kind:c.kind,content:c.content,sourceRefs:c.evidenceRefs},{kind:'agent',id:'project-planner'});return assets.propose(project,{assetKey:c.assetKey,sourceRevision:sourceRevision.id,baseVersion:c.baseVersion,dependencies:c.dependencies},{kind:'agent',id:'project-planner'});});
 ledger.db.prepare("UPDATE wf_runs SET status='waiting_review' WHERE id=?").run(runId);
 return tasks.complete(project,id,token,{runId,report:report.id,summary:proposal.summary,candidateVersions:versions.map(v=>v.id),followUps:proposal.followUps});})();
 }catch(e){const code=taskErrorCode(e);ledger.db.transaction(()=>{const t=tasks.read(project,id);if(t.lease?.token===token){t.status=t.attempts>=t.maxAttempts?'blocked':'pending';t.reason=code;delete t.lease;ledger.db.prepare('UPDATE project_tasks SET json=? WHERE id=?').run(canonicalJSON(t),id);tasks.recordFailure(project,id,code);if(e&&typeof e==='object')recorded.add(e);}})();throw e;}
}
export function taskErrorCode(e:unknown){return e instanceof LedgerError?e.code:e instanceof Error?e.message:'planner_failed';}
/** 后台跑任务：任何失败（包括领取时就被拒）都写回任务，界面能看到失败与原因。 */
const recorded=new WeakSet<object>();
export function startProjectTask(project:string,id:string){return runProjectTask(project,id).catch(e=>{try{if(!(e&&typeof e==='object'&&recorded.has(e)))new ProjectTasks(runLedger()).recordFailure(project,id,taskErrorCode(e));}catch{/* 任务本身读不到时没有地方可写 */}return undefined;});}
export function materializeFollowUps(project:string,id:string){const ledger=runLedger();ledger.db.exec('CREATE TABLE IF NOT EXISTS project_task_followups(taskId TEXT PRIMARY KEY,projectId TEXT NOT NULL,json TEXT NOT NULL)');return ledger.db.transaction(()=>{const tasks=new ProjectTasks(ledger),discoveries=new ProjectDiscoveries(ledger),task=tasks.read(project,id);if(task.status!=='done')throw new LedgerError(409,'task_must_be_reviewed');const prior=ledger.db.prepare('SELECT json FROM project_task_followups WHERE taskId=? AND projectId=?').get(id,project) as {json:string}|undefined;if(prior)return (JSON.parse(prior.json) as string[]).map(child=>tasks.read(project,child));const result=task.result as {discoveryIds?:string[];followUps?:Array<{target:string;goal:string;assetKeys:string[]}>};const snapshot=new ProjectAssets(ledger).snapshot(project,'Follow-up '+id,{kind:'human',id:'local-operator'},new ProjectAssets(ledger).readSnapshot(project,task.snapshotId).lineageId??'main');const created=(result.followUps??[]).map(f=>tasks.create(project,{...f,snapshotId:snapshot.id,discoveryIds:[...new Set([...task.discoveryIds,...(result.discoveryIds??[]).filter(d=>discoveries.read(project,d).status!=='dismissed')])],dependsOn:[id],maxAttempts:2}));ledger.db.prepare('INSERT INTO project_task_followups VALUES(?,?,?)').run(id,project,canonicalJSON(created.map(t=>t.id)));return created;})();}
