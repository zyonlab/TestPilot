import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {canonicalJSON,type Principal} from '@testpilot/harness-core/run-contracts';
import {contentHash,LedgerError,type RunLedger} from './runLedger.js';
import {ProjectAssets} from './projectAssets.js';
import {ProjectDiscoveries} from './projectDiscoveries.js';
const spec=z.object({snapshotId:z.string(),discoveryIds:z.array(z.string()).min(1),target:z.enum(['source','modules','stories','cases','rules']),goal:z.string().min(1).max(4000),assetKeys:z.array(z.string()).default([]),dependsOn:z.array(z.string()).default([]),maxAttempts:z.number().int().min(1).max(3).default(2)}).strict();
export type ProjectTask=z.infer<typeof spec>&{id:string;projectId:string;status:'pending'|'claimed'|'review'|'done'|'rejected'|'blocked';attempts:number;lease?:{owner:string;token:string;until:number};result?:unknown;reason?:string;lastError?:{code:string;at:string};createdAt:string};
export class ProjectTasks{
 constructor(readonly ledger:RunLedger){ledger.db.exec('CREATE TABLE IF NOT EXISTS project_tasks(id TEXT PRIMARY KEY,projectId TEXT NOT NULL,identity TEXT NOT NULL,json TEXT NOT NULL,UNIQUE(projectId,identity)); CREATE TABLE IF NOT EXISTS project_task_events(id INTEGER PRIMARY KEY,projectId TEXT NOT NULL,taskId TEXT NOT NULL,json TEXT NOT NULL)');}
 list(project:string){return (this.ledger.db.prepare('SELECT json FROM project_tasks WHERE projectId=? ORDER BY rowid').all(project) as {json:string}[]).map(r=>JSON.parse(r.json) as ProjectTask);}
 read(project:string,id:string){const t=this.list(project).find(t=>t.id===id);if(!t)throw new LedgerError(404,'project_task_missing');return t;}
 private save(t:ProjectTask,event:string){this.ledger.db.prepare('UPDATE project_tasks SET json=? WHERE id=?').run(canonicalJSON(t),t.id);this.ledger.db.prepare('INSERT INTO project_task_events(projectId,taskId,json) VALUES(?,?,?)').run(t.projectId,t.id,canonicalJSON({event,at:new Date().toISOString(),status:t.status,attempts:t.attempts,reason:t.reason}));}
 create(projectId:string,raw:unknown){const s=spec.parse(raw),assets=new ProjectAssets(this.ledger),snapshot=assets.readSnapshot(projectId,s.snapshotId),discoveries=new ProjectDiscoveries(this.ledger);s.discoveryIds=[...new Set(s.discoveryIds)].sort();s.dependsOn=[...new Set(s.dependsOn)].sort();
 for(const id of s.discoveryIds){const discovery=discoveries.read(projectId,id);if(discovery.status==='dismissed')throw new LedgerError(409,'dismissed_discovery');if(discovery.status!=='triaged')throw new LedgerError(409,'discovery_review_required');const lineage=this.ledger.requireRun(discovery.runId,projectId).input.parameters?.projectLineageId??'main';if(lineage!==(snapshot.lineageId??'main'))throw new LedgerError(409,'task_discovery_lineage_conflict');}
 const depth=(id:string):number=>{const task=this.read(projectId,id);return 1+Math.max(0,...task.dependsOn.map(depth));};
 if(s.dependsOn.some(id=>depth(id)>=4))throw new LedgerError(409,'task_generation_budget_exhausted');
 for(const id of s.dependsOn)this.read(projectId,id); // Edges can only point backward to immutable existing tasks: no cycles.
 for(const key of s.assetKeys)if(!snapshot.heads[key])throw new LedgerError(400,'task_asset_not_in_snapshot');
 const identity=contentHash(canonicalJSON(s)),prior=this.ledger.db.prepare('SELECT id FROM project_tasks WHERE projectId=? AND identity=?').get(projectId,identity) as {id:string}|undefined;if(prior)return this.read(projectId,prior.id);
 const t:ProjectTask={...s,id:'task-'+randomUUID(),projectId,status:'pending',attempts:0,createdAt:new Date().toISOString()};this.ledger.db.prepare('INSERT INTO project_tasks VALUES(?,?,?,?)').run(t.id,projectId,identity,canonicalJSON(t));return t;}
 claim(project:string,id:string,owner:string,now=Date.now(),leaseMs=300000){
 return this.ledger.db.transaction(()=>{const t=this.read(project,id);if(['done','review','rejected','blocked'].includes(t.status))throw new LedgerError(409,'task_not_claimable');if(t.lease&&t.lease.until>now)throw new LedgerError(409,'task_already_claimed');
 if(t.attempts>=t.maxAttempts){t.status='blocked';t.reason='attempt_budget_exhausted';delete t.lease;this.save(t,'budget');return t;}
 if(t.dependsOn.some(id=>this.read(project,id).status!=='done'))throw new LedgerError(409,'task_dependencies_pending');
 const assets=new ProjectAssets(this.ledger),snapshot=assets.readSnapshot(project,t.snapshotId),heads=assets.heads(project);const keys=t.assetKeys.length?t.assetKeys:Object.keys(snapshot.heads);
 if(keys.some(k=>heads[k]!==snapshot.heads[k])){t.status='blocked';t.reason='asset_inputs_changed_replan';delete t.lease;this.save(t,'stale');return t;}
 t.status='claimed';t.attempts++;t.lease={owner,token:randomUUID(),until:now+Math.min(900000,leaseMs)};this.save(t,'claimed');return t;})();}
 complete(project:string,id:string,token:string,result:unknown,now=Date.now()){
 return this.ledger.db.transaction(()=>{const t=this.read(project,id);if(t.status!=='claimed'||t.lease?.token!==token||t.lease.until<now)throw new LedgerError(409,'task_lease_invalid');t.result=result;t.status='review';delete t.lease;this.save(t,'proposal_ready');return t;})();}
 decide(project:string,id:string,approve:boolean,reason:string,actor:Principal){if(actor.kind!=='human')throw new LedgerError(403,'operator_action_required');z.string().min(1).parse(reason);return this.ledger.db.transaction(()=>{const t=this.read(project,id);if(t.status!=='review')throw new LedgerError(409,'task_review_required');t.status=approve?'done':'rejected';t.reason=reason;this.save(t,'reviewed:'+actor.id);return t;})();}
 /**
  * 后台领取/规划失败时写回任务：界面读任务列表，看得到失败和原因，而不是一直停在「已排队」。
  * 不改状态与 reason（pending/blocked 由调用方决定；已审核任务的 reason 是人写的理由，不能被覆盖），只留下最后一次失败的代码与时间，并记一条事件。
  */
 recordFailure(project:string,id:string,code:string){return this.ledger.db.transaction(()=>{const t=this.read(project,id);t.lastError={code:code.slice(0,500),at:new Date().toISOString()};this.save(t,'failed:'+t.lastError.code);return t;})();}
 /**
  * blocked 的恢复路径：后续任务在人工采纳上游候选之前就拍了快照，采纳之后领取会因输入变了而 blocked。
  * 人确认后，把任务按当前资产版本重新基线：在同一 lineage 下拍一张新快照，任务改指它、回到 pending。
  * 只接受 `asset_inputs_changed_replan` 这一种 blocked（预算耗尽不是基线问题）；任务身份与幂等键不变，审计记旧/新快照与操作者。
  */
 rebaseline(project:string,id:string,reason:string,actor:Principal){if(actor.kind!=='human')throw new LedgerError(403,'operator_action_required');z.string().trim().min(1).parse(reason);return this.ledger.db.transaction(()=>{
  const t=this.read(project,id);if(t.status!=='blocked'||t.reason!=='asset_inputs_changed_replan')throw new LedgerError(409,'task_not_rebaselinable');
  const assets=new ProjectAssets(this.ledger),old=assets.readSnapshot(project,t.snapshotId),fresh=assets.snapshot(project,'Rebaseline '+id,actor,old.lineageId??'main');
  for(const key of t.assetKeys)if(!fresh.heads[key])throw new LedgerError(409,'task_asset_not_in_snapshot');
  t.snapshotId=fresh.id;t.status='pending';delete t.reason;delete t.lastError;
  this.ledger.db.prepare('UPDATE project_tasks SET json=? WHERE id=?').run(canonicalJSON(t),t.id);
  this.ledger.db.prepare('INSERT INTO project_task_events(projectId,taskId,json) VALUES(?,?,?)').run(project,id,canonicalJSON({event:'rebaselined',at:new Date().toISOString(),status:t.status,attempts:t.attempts,actor,reason,fromSnapshot:old.id,toSnapshot:fresh.id}));
  return t;})();}
 events(project:string,id:string){return (this.ledger.db.prepare('SELECT json FROM project_task_events WHERE projectId=? AND taskId=? ORDER BY id').all(project,id) as {json:string}[]).map(r=>JSON.parse(r.json) as Record<string,unknown>);}
 impact(project:string,versionId:string){const assets=new ProjectAssets(this.ledger),versions=assets.list(project).versions,changed=assets.read(project,versionId).version,affected=new Set<string>([changed.assetKey]);let added=true;while(added){added=false;for(const v of versions.filter(v=>v.status==='adopted'))if(!affected.has(v.assetKey)&&v.dependencies.some(d=>affected.has(assets.read(project,d).version.assetKey))){affected.add(v.assetKey);added=true;}}return {changed:versionId,assetKeys:[...affected],tasks:this.list(project).filter(t=>t.assetKeys.some(k=>affected.has(k))).map(t=>t.id)};}
}
