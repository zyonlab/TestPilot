import {z} from 'zod';
import {canonicalJSON,type ArtifactRevision,type Principal} from '@testpilot/harness-core/run-contracts';
import {contentHash,LedgerError,type RunLedger} from './runLedger.js';
const inputSchema=z.object({runId:z.string(),evidenceRef:z.string(),category:z.enum(['new_control','missing_state','rule_conflict','execution_failure','capability']),featureId:z.string().min(1),observation:z.string().min(1).max(4000),hypothesis:z.string().max(4000).default(''),state:z.string().max(2000).default('')}).strict();
export type Discovery=z.infer<typeof inputSchema>&{id:string;projectId:string;status:string;refs:string[];createdAt:string;actor:Principal;trust:'candidate'};
export class ProjectDiscoveries{
 constructor(readonly ledger:RunLedger){ledger.db.exec('CREATE TABLE IF NOT EXISTS project_discoveries(id TEXT PRIMARY KEY,projectId TEXT NOT NULL,identity TEXT NOT NULL,json TEXT NOT NULL,UNIQUE(projectId,identity)); CREATE TABLE IF NOT EXISTS project_discovery_decisions(id INTEGER PRIMARY KEY,projectId TEXT NOT NULL,discoveryId TEXT NOT NULL,json TEXT NOT NULL)');}
 list(projectId:string){return (this.ledger.db.prepare('SELECT json FROM project_discoveries WHERE projectId=? ORDER BY rowid DESC').all(projectId) as {json:string}[]).map(r=>JSON.parse(r.json) as Discovery);}
 read(projectId:string,id:string){const d=this.list(projectId).find(d=>d.id===id);if(!d)throw new LedgerError(404,'discovery_missing');return d;}
 record(projectId:string,raw:unknown,actor:Principal){const input=inputSchema.parse(raw);this.ledger.requireRun(input.runId,projectId);const evidence=this.ledger.readRevision(input.evidenceRef,projectId).revision;if(evidence.runId!==input.runId||evidence.createdBy.kind!=='system'||!['report','execution'].includes(evidence.kind))throw new LedgerError(409,'discovery_requires_system_receipt');
 const run=this.ledger.requireRun(input.runId,projectId);const identity=contentHash(canonicalJSON({category:input.category,featureId:input.featureId,observation:input.observation.trim(),state:input.state,lineage:run.input.parameters?.projectLineageId??'main',environment:run.binding.environmentHash}));
 return this.ledger.db.transaction(()=>{const prior=this.ledger.db.prepare('SELECT json FROM project_discoveries WHERE projectId=? AND identity=?').get(projectId,identity) as {json:string}|undefined;
 if(prior){const d=JSON.parse(prior.json) as Discovery;if(!d.refs.includes(input.evidenceRef)){d.refs.push(input.evidenceRef);this.ledger.db.prepare('UPDATE project_discoveries SET json=? WHERE id=?').run(canonicalJSON(d),d.id);}return d;}
 const d:Discovery={...input,id:'discovery-'+identity,projectId,status:'unreviewed',refs:[input.evidenceRef],createdAt:new Date().toISOString(),actor,trust:'candidate'};this.ledger.db.prepare('INSERT INTO project_discoveries VALUES(?,?,?,?)').run(d.id,projectId,identity,canonicalJSON(d));return d;})();
 }
 decide(projectId:string,id:string,status:'triaged'|'dismissed',reason:string,actor:Principal){if(actor.kind!=='human')throw new LedgerError(403,'operator_action_required');z.enum(['triaged','dismissed']).parse(status);z.string().trim().min(1).parse(reason);return this.ledger.db.transaction(()=>{const d=this.read(projectId,id);this.ledger.db.prepare('INSERT INTO project_discovery_decisions(projectId,discoveryId,json) VALUES(?,?,?)').run(projectId,id,canonicalJSON({status,reason,actor,at:new Date().toISOString()}));d.status=status;this.ledger.db.prepare('UPDATE project_discoveries SET json=? WHERE id=?').run(canonicalJSON(d),id);return d;})();}
 capture(revision:ArtifactRevision,content:unknown){
 if(revision.createdBy.kind!=='system'||!['report','execution'].includes(revision.kind)||!content||typeof content!=='object')return;
 const c=content as any,base={runId:revision.runId,evidenceRef:revision.id};
 const emit=(category:Discovery['category'],featureId:string,observation:string,state='',hypothesis='')=>this.record(revision.projectId,{...base,category,featureId,observation:observation.slice(0,4000),state:state.slice(0,2000),hypothesis:hypothesis.slice(0,4000)},{kind:'system',id:'discovery-collector'});
 if(revision.name==='exploration/report'){
  for(const o of c.observations??[]){if(o.status==='blocked'||o.status==='failed')emit('missing_state',o.featureId??'unknown',o.reason??o.status,o.stateBefore??'');else if(o.effect?.controlsAdded?.length)emit('new_control',o.featureId??'unknown',o.effect.controlsAdded.join('; '),o.stateAfter??'', 'New controls require business classification; no new requirement is confirmed.');}
  for(const t of c.assessment?.targets??[])if(!t.interactionCompleted&&!t.observationCompleted)emit('missing_state',t.featureId,`${t.targetSpecId}: ${t.reason}`);
 }
 if(revision.kind==='execution')for(const result of c.results??[])if(result.failureReason)emit('execution_failure',result.caseId??'unknown',String(result.failureReason));
 if((revision.name.startsWith('preparation/')||revision.name.startsWith('execution/'))&&c.status){
  for(const check of c.prerequisiteChecks??[])if(check.status!=='pass')emit('missing_state',c.caseId??revision.name.split('/')[2]??'unknown',`${check.statement??'Prerequisite'}: ${check.reason??check.status}`);
  if(c.status==='failed'&&c.failureReason)emit('execution_failure',c.caseId??revision.name.split('/')[2]??'unknown',c.failureReason);
 }
 }
}
