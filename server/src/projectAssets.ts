import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {canonicalJSON,type Principal} from '@testpilot/harness-core/run-contracts';
import {RunLedger,LedgerError,contentHash} from './runLedger.js';

const key=z.string().trim().min(1).max(200);
const proposal=z.object({assetKey:key,sourceRevision:key,baseVersion:key.nullable(),dependencies:z.array(key).max(200).default([])}).strict();
export type AssetVersion={id:string;projectId:string;assetKey:string;kind:string;sourceRevision:string;sourceRun:string;baseVersion:string|null;dependencies:string[];contentHash:string;createdAt:string;createdBy:Principal};
export type AssetSnapshot={id:string;projectId:string;label:string;heads:Record<string,string>;versions:string[];digest:string;createdAt:string;createdBy:Principal};
/** Project versions are copies of immutable artifacts, not pointers to a run's latest output. */
export class ProjectAssets{
 constructor(readonly ledger:RunLedger){ledger.db.exec(`
 CREATE TABLE IF NOT EXISTS project_asset_versions(id TEXT PRIMARY KEY,projectId TEXT NOT NULL,assetKey TEXT NOT NULL,identity TEXT NOT NULL,json TEXT NOT NULL,content TEXT NOT NULL,UNIQUE(projectId,assetKey,identity));
 CREATE TABLE IF NOT EXISTS project_asset_heads(projectId TEXT NOT NULL,assetKey TEXT NOT NULL,versionId TEXT NOT NULL REFERENCES project_asset_versions(id),PRIMARY KEY(projectId,assetKey));
 CREATE TABLE IF NOT EXISTS project_asset_decisions(id TEXT PRIMARY KEY,projectId TEXT NOT NULL,versionId TEXT NOT NULL REFERENCES project_asset_versions(id),json TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS project_asset_snapshots(id TEXT PRIMARY KEY,projectId TEXT NOT NULL,json TEXT NOT NULL);
 `);}
 read(projectId:string,id:string){
  const row=this.ledger.db.prepare('SELECT projectId,json,content FROM project_asset_versions WHERE id=?').get(id) as {projectId:string;json:string;content:string}|undefined;
  if(!row)throw new LedgerError(404,'asset_version_missing');
  if(row.projectId!==projectId)throw new LedgerError(409,'asset_project_conflict');
  const version=JSON.parse(row.json) as AssetVersion;
  if(contentHash(row.content)!==version.contentHash)throw new LedgerError(409,'asset_content_changed');
  return {version,content:JSON.parse(row.content)};
 }
 heads(projectId:string){return Object.fromEntries((this.ledger.db.prepare('SELECT assetKey,versionId FROM project_asset_heads WHERE projectId=? ORDER BY assetKey').all(projectId) as {assetKey:string;versionId:string}[]).map(r=>[r.assetKey,r.versionId]));}
 list(projectId:string){
  const heads=this.heads(projectId);
  const versions=(this.ledger.db.prepare('SELECT json FROM project_asset_versions WHERE projectId=? ORDER BY rowid DESC').all(projectId) as {json:string}[]).map(r=>JSON.parse(r.json) as AssetVersion);
  const decisions=(this.ledger.db.prepare('SELECT json FROM project_asset_decisions WHERE projectId=? ORDER BY rowid').all(projectId) as {json:string}[]).map(r=>JSON.parse(r.json));
  return {heads,versions:versions.map(v=>({...v,status:heads[v.assetKey]===v.id?'adopted':decisions.some(d=>d.versionId===v.id&&d.action==='adopt')?'superseded':decisions.some(d=>d.versionId===v.id&&d.action==='reject')?'rejected':'candidate',staleDependencies:v.dependencies.filter(id=>{const dep=this.read(projectId,id).version;return heads[dep.assetKey]!==id;})})),decisions,snapshots:this.snapshots(projectId)};
 }
 propose(projectId:string,raw:unknown,actor:Principal){
  const input=proposal.parse(raw);
  return this.ledger.db.transaction(()=>{
   const source=this.ledger.readRevision(input.sourceRevision,projectId);
   // Raw observations/reports and gold are evidence, not adopted business assets.
   if(!['material','stories','cases','modules'].includes(source.revision.kind)&&!['product/model-candidate','validated/modules'].includes(source.revision.name))throw new LedgerError(400,'asset_source_not_reusable');
   if(input.baseVersion&&this.read(projectId,input.baseVersion).version.assetKey!==input.assetKey)throw new LedgerError(409,'asset_parent_conflict');
   const dependencies=[...new Set(input.dependencies)].sort();
   for(const id of dependencies)if(this.read(projectId,id).version.assetKey===input.assetKey)throw new LedgerError(409,'asset_self_dependency');
   const content=canonicalJSON(source.content),hash=contentHash(content);
   const identity=contentHash(canonicalJSON({...input,dependencies,contentHash:hash}));
   const prior=this.ledger.db.prepare('SELECT id FROM project_asset_versions WHERE projectId=? AND assetKey=? AND identity=?').get(projectId,input.assetKey,identity) as {id:string}|undefined;
   if(prior)return this.read(projectId,prior.id).version;
   const version:AssetVersion={id:'av-'+randomUUID(),projectId,assetKey:input.assetKey,kind:source.revision.kind,sourceRevision:input.sourceRevision,sourceRun:source.revision.runId,baseVersion:input.baseVersion,dependencies,contentHash:hash,createdAt:new Date().toISOString(),createdBy:actor};
   this.ledger.db.prepare('INSERT INTO project_asset_versions VALUES(?,?,?,?,?,?)').run(version.id,projectId,input.assetKey,identity,canonicalJSON(version),content);
   return version;
  })();
 }
 decide(projectId:string,id:string,raw:unknown,actor:Principal){
  if(actor.kind!=='human')throw new LedgerError(403,'operator_action_required');
  const input=z.object({action:z.enum(['adopt','reject']),expectedHead:key.nullable(),reason:z.string().trim().min(1).max(4000)}).strict().parse(raw);
  return this.ledger.db.transaction(()=>{
   const version=this.read(projectId,id).version,head=this.heads(projectId)[version.assetKey]??null;
   if(input.expectedHead!==head)throw new LedgerError(409,'asset_head_changed');
   const prior=this.list(projectId).decisions.filter(d=>d.versionId===id).at(-1);
   if(prior?.action===input.action&&((input.action==='adopt'&&head===id)||input.action==='reject'))return prior;
   if(input.action==='adopt'){
    if(version.baseVersion!==head)throw new LedgerError(409,'asset_candidate_needs_rebase');
    // Dependencies must be the accepted versions; no silently adopting stale candidates.
    for(const dep of version.dependencies){const d=this.read(projectId,dep).version;if(this.heads(projectId)[d.assetKey]!==dep)throw new LedgerError(409,'asset_dependency_not_current');}
    if(this.dependsOnKey(projectId,version.dependencies,version.assetKey))throw new LedgerError(409,'asset_dependency_cycle');
    this.ledger.db.prepare('INSERT INTO project_asset_heads VALUES(?,?,?) ON CONFLICT(projectId,assetKey) DO UPDATE SET versionId=excluded.versionId').run(projectId,version.assetKey,id);
   }else if(head===id)throw new LedgerError(409,'cannot_reject_adopted_asset');
   const decision={id:'ad-'+randomUUID(),projectId,versionId:id,...input,actor,at:new Date().toISOString()};
   this.ledger.db.prepare('INSERT INTO project_asset_decisions VALUES(?,?,?,?)').run(decision.id,projectId,id,canonicalJSON(decision));return decision;
  })();
 }
 private dependsOnKey(projectId:string,ids:string[],assetKey:string){
  const seen=new Set<string>(),queue=[...ids];
  while(queue.length){const id=queue.pop()!;if(seen.has(id))continue;seen.add(id);const v=this.read(projectId,id).version;if(v.assetKey===assetKey)return true;queue.push(...v.dependencies);}return false;
 }
 snapshot(projectId:string,label:string,actor:Principal){
  return this.ledger.db.transaction(()=>{
   const heads=this.heads(projectId),seen=new Set<string>(),queue=Object.values(heads);
   while(queue.length){const id=queue.pop()!;if(seen.has(id))continue;seen.add(id);queue.push(...this.read(projectId,id).version.dependencies);}
   const versions=[...seen].sort(),digest=contentHash(canonicalJSON({heads,versions:versions.map(id=>({id,hash:this.read(projectId,id).version.contentHash}))}));
   const snapshot:AssetSnapshot={id:'as-'+randomUUID(),projectId,label:key.parse(label),heads,versions,digest,createdAt:new Date().toISOString(),createdBy:actor};
   this.ledger.db.prepare('INSERT INTO project_asset_snapshots VALUES(?,?,?)').run(snapshot.id,projectId,canonicalJSON(snapshot));return snapshot;
  })();
 }
 readSnapshot(projectId:string,id:string){
  const row=this.ledger.db.prepare('SELECT projectId,json FROM project_asset_snapshots WHERE id=?').get(id) as {projectId:string;json:string}|undefined;
  if(!row)throw new LedgerError(404,'asset_snapshot_missing');if(row.projectId!==projectId)throw new LedgerError(409,'asset_project_conflict');
  const snapshot=JSON.parse(row.json) as AssetSnapshot;
  const actual=contentHash(canonicalJSON({heads:snapshot.heads,versions:snapshot.versions.map(id=>({id,hash:this.read(projectId,id).version.contentHash}))}));
  if(actual!==snapshot.digest)throw new LedgerError(409,'asset_snapshot_changed');return snapshot;
 }
 snapshots(projectId:string){return (this.ledger.db.prepare('SELECT id FROM project_asset_snapshots WHERE projectId=? ORDER BY rowid DESC').all(projectId) as {id:string}[]).map(r=>this.readSnapshot(projectId,r.id));}
}
