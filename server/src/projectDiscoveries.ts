import {z} from 'zod';
import {canonicalJSON,type ArtifactRevision,type Principal} from '@testpilot/harness-core/run-contracts';
import {contentHash,LedgerError,type RunLedger} from './runLedger.js';
const inputSchema=z.object({runId:z.string(),evidenceRef:z.string(),category:z.enum(['new_control','missing_state','rule_conflict','execution_failure','capability']),featureId:z.string().min(1),observation:z.string().min(1).max(4000),hypothesis:z.string().max(4000).default(''),state:z.string().max(2000).default('')}).strict();
export type Discovery=z.infer<typeof inputSchema>&{id:string;projectId:string;status:string;refs:string[];createdAt:string;actor:Principal;trust:'candidate'};
/**
 * 哪些修订算「真实观察/执行回执」。只认服务端自己的观察者写下的那几种：探索器的观察与报告、
 * 准备控制器的每轮执行结果、执行器的批次结果。`knowledge/*`（用户材料）、模型写的规划文本
 * （`project/incremental-proposal`、`context/*`、`validated/*` 等）一律不算——它们要么是人给的，
 * 要么是模型说的，都不是这个产品在屏幕上发生过什么的证据。
 */
const RECEIPTS:Array<[RegExp,string]>=[
 [/^exploration\/(?:report|observations)$/,'explorer'],
 [/^preparation\/[^/]+\/[^/]+\/(?:generation-\d+\/)?(?:probe|round)-\d+\/(?:late-)?result$/,'preparation-controller'],
 [/^execution\/[^/]+$/,'workflow-executor'],
];
/** 从节点重跑会把上游修订原样复制进新运行（`rerun`，sourceRefs 只指向原件）。复制件不是新观察：顺着它找回源头。 */
export function receiptOrigin(ledger:RunLedger,revision:ArtifactRevision,projectId:string):ArtifactRevision{
 let current=revision;
 for(let i=0;i<16&&current.createdBy.kind==='system'&&current.createdBy.id==='rerun'&&current.sourceRefs.length===1;i++){
  const source=ledger.readRevision(current.sourceRefs[0]!,projectId).revision;if(source.name!==current.name||source.contentHash!==current.contentHash)break;current=source;}
 return current;
}
export function isObservationReceipt(revision:ArtifactRevision){
 if(revision.createdBy.kind!=='system')return false;
 return RECEIPTS.some(([name,actor])=>name.test(revision.name)&&revision.createdBy.id===actor);
}
export class ProjectDiscoveries{
 constructor(readonly ledger:RunLedger){ledger.db.exec('CREATE TABLE IF NOT EXISTS project_discoveries(id TEXT PRIMARY KEY,projectId TEXT NOT NULL,identity TEXT NOT NULL,json TEXT NOT NULL,UNIQUE(projectId,identity)); CREATE TABLE IF NOT EXISTS project_discovery_decisions(id INTEGER PRIMARY KEY,projectId TEXT NOT NULL,discoveryId TEXT NOT NULL,json TEXT NOT NULL)');}
 list(projectId:string){return (this.ledger.db.prepare('SELECT json FROM project_discoveries WHERE projectId=? ORDER BY rowid DESC').all(projectId) as {json:string}[]).map(r=>JSON.parse(r.json) as Discovery);}
 read(projectId:string,id:string){const d=this.list(projectId).find(d=>d.id===id);if(!d)throw new LedgerError(404,'discovery_missing');return d;}
 record(projectId:string,raw:unknown,actor:Principal){const input=inputSchema.parse(raw);if(this.ledger.requireRun(input.runId,projectId).input.parameters?.evaluationSplit==='held-out')throw new LedgerError(409,'held_out_discovery_not_reusable');const evidence=this.ledger.readRevision(input.evidenceRef,projectId).revision,origin=receiptOrigin(this.ledger,evidence,projectId);if(evidence.runId!==input.runId||!isObservationReceipt(origin))throw new LedgerError(409,'discovery_requires_system_receipt');
 const run=this.ledger.requireRun(input.runId,projectId);const identity=contentHash(canonicalJSON({category:input.category,featureId:input.featureId,observation:input.observation.trim(),state:input.state,lineage:run.input.parameters?.projectLineageId??'main',environment:run.binding.environmentHash}));
 return this.ledger.db.transaction(()=>{const prior=this.ledger.db.prepare('SELECT json FROM project_discoveries WHERE projectId=? AND identity=?').get(projectId,identity) as {json:string}|undefined;
 // 同一份回执（同内容，或复制件追溯到同一个源头）只算一条证据：fork 出来的七份拷贝不是七次观察。
 if(prior){const d=JSON.parse(prior.json) as Discovery;const known=d.refs.map(ref=>{const r=this.ledger.readRevision(ref,projectId).revision;return {hash:r.contentHash,origin:receiptOrigin(this.ledger,r,projectId).id};});
  if(!known.some(k=>k.hash===evidence.contentHash||k.origin===origin.id)){d.refs.push(input.evidenceRef);this.ledger.db.prepare('UPDATE project_discoveries SET json=? WHERE id=?').run(canonicalJSON(d),d.id);}return d;}
 const d:Discovery={...input,id:'discovery-'+identity,projectId,status:'unreviewed',refs:[input.evidenceRef],createdAt:new Date().toISOString(),actor,trust:'candidate'};this.ledger.db.prepare('INSERT INTO project_discoveries VALUES(?,?,?,?)').run(d.id,projectId,identity,canonicalJSON(d));return d;})();
 }
 decide(projectId:string,id:string,status:'triaged'|'dismissed',reason:string,actor:Principal){if(actor.kind!=='human')throw new LedgerError(403,'operator_action_required');z.enum(['triaged','dismissed']).parse(status);z.string().trim().min(1).parse(reason);return this.ledger.db.transaction(()=>{const d=this.read(projectId,id);this.ledger.db.prepare('INSERT INTO project_discovery_decisions(projectId,discoveryId,json) VALUES(?,?,?)').run(projectId,id,canonicalJSON({status,reason,actor,at:new Date().toISOString()}));d.status=status;this.ledger.db.prepare('UPDATE project_discoveries SET json=? WHERE id=?').run(canonicalJSON(d),id);return d;})();}
 capture(revision:ArtifactRevision,content:unknown){
 if(!content||typeof content!=='object'||!isObservationReceipt(receiptOrigin(this.ledger,revision,revision.projectId)))return;
 if(this.ledger.requireRun(revision.runId,revision.projectId).input.parameters?.evaluationSplit==='held-out')return;
 const rows=(value:unknown):any[]=>Array.isArray(value)?value.filter(v=>v&&typeof v==='object'):[];
 const c=content as any,base={runId:revision.runId,evidenceRef:revision.id};
 const emit=(category:Discovery['category'],featureId:string,observation:string,state='',hypothesis='')=>this.record(revision.projectId,{...base,category,featureId:String(featureId||'unknown'),observation:String(observation||'Unspecified observation').slice(0,4000),state:String(state).slice(0,2000),hypothesis:String(hypothesis).slice(0,4000)},{kind:'system',id:'discovery-collector'});
 if(revision.name==='exploration/report'){
  for(const o of rows(c.observations)){if(o.status==='blocked'||o.status==='failed')emit('missing_state',o.featureId??'unknown',o.reason??o.status,o.stateBefore??'');else if(Array.isArray(o.effect?.controlsAdded)&&o.effect.controlsAdded.length)emit('new_control',o.featureId??'unknown',o.effect.controlsAdded.join('; '),o.stateAfter??'', 'New controls require business classification; no new requirement is confirmed.');}
  for(const t of rows(c.assessment?.targets))if(!t.interactionCompleted&&!t.observationCompleted)emit('missing_state',t.featureId,`${t.targetSpecId}: ${t.reason}`);
 }
 if(revision.kind==='execution')for(const result of rows(c.results))if(result.failureReason)emit('execution_failure',result.caseId??'unknown',String(result.failureReason));
 if((revision.name.startsWith('preparation/')||revision.name.startsWith('execution/'))&&c.status){
  for(const check of rows(c.prerequisiteChecks))if(check.status!=='pass')emit('missing_state',c.caseId??revision.name.split('/')[2]??'unknown',`${check.statement??'Prerequisite'}: ${check.reason??check.status}`);
  if(c.status==='failed'&&c.failureReason)emit('execution_failure',c.caseId??revision.name.split('/')[2]??'unknown',c.failureReason);
 }
 }
}
