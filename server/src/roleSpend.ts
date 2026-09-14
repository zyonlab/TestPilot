import { z } from 'zod';
import { existsSync, readFileSync } from 'node:fs';
import { canonicalJSON } from '@testpilot/harness-core/run-contracts';
import type { RoleRequestRecord } from '@testpilot/harness-core';
import { runLedger } from './runService.js';
import { LedgerError } from './runLedger.js';
const n = z.number().finite().nonnegative().nullable();
export const SpendRecordSchema = z.object({
 id:z.string().min(1), runId:z.string(), role:z.enum(['planner','executor']), source:z.enum(['role-proxy','host-summary','unavailable']),
 caseRevision:z.string().nullable().default(null), executionId:z.string().nullable().default(null), attempt:z.number().int().nonnegative().nullable().default(null),
 model:z.string().nullable(), endpoint:z.string().nullable(), at:z.string(), ms:n,
 inputTokens:n, outputTokens:n, cachedInputTokens:n, cacheWriteTokens:n.default(null), totalTokens:n,
 forwarded:z.boolean().nullable(), httpStatus:z.number().int().nullable(),
 reportedUsd:n.default(null), priceVersion:z.string().nullable().default(null), estimatedUsd:n.default(null), priceReason:z.string().default('price_unknown'),
});
export type SpendRecord=z.infer<typeof SpendRecordSchema>;
const PriceSchema=z.object({id:z.string().min(1),model:z.string(),endpoint:z.string().url(),validFrom:z.string().datetime(),validUntil:z.string().datetime().optional(),inputUsdPerMillion:z.number().nonnegative(),outputUsdPerMillion:z.number().nonnegative(),cachedInputUsdPerMillion:z.number().nonnegative().optional(),cacheWriteUsdPerMillion:z.number().nonnegative().optional()});
export type ModelPrice=z.infer<typeof PriceSchema>;
export function priceSpend(row:SpendRecord,prices:ModelPrice[]) {
 const matches=prices.filter(p=>p.model===row.model&&p.endpoint===row.endpoint&&Date.parse(p.validFrom)<=Date.parse(row.at)&&(!p.validUntil||Date.parse(row.at)<Date.parse(p.validUntil)));
 if(matches.length!==1)return {priceVersion:null,estimatedUsd:null,priceReason:matches.length?'ambiguous_price_version':'price_unknown'};
 const p=matches[0];
 if(row.inputTokens===null||row.outputTokens===null||row.cachedInputTokens===null||row.cacheWriteTokens===null)return {priceVersion:p.id,estimatedUsd:null,priceReason:'usage_unknown'};
 const {inputTokens:input,outputTokens:output,cachedInputTokens:read,cacheWriteTokens:write}=row;
 if(read+write>input)return {priceVersion:p.id,estimatedUsd:null,priceReason:'incompatible_cache_usage'};
 if(read>0&&p.cachedInputUsdPerMillion===undefined||write>0&&p.cacheWriteUsdPerMillion===undefined)return {priceVersion:p.id,estimatedUsd:null,priceReason:'cache_price_unknown'};
 return {priceVersion:p.id,estimatedUsd:((input-read-write)*p.inputUsdPerMillion+output*p.outputUsdPerMillion+read*(p.cachedInputUsdPerMillion??0)+write*(p.cacheWriteUsdPerMillion??0))/1e6,priceReason:'versioned_price_estimate'};
}
function prices(){try{const path=process.env.TP_MODEL_PRICES_FILE;return path&&existsSync(path)?z.array(PriceSchema).parse(JSON.parse(readFileSync(path,'utf8'))):[];}catch{return [];}}
function ledger(){const l=runLedger();l.db.exec('CREATE TABLE IF NOT EXISTS role_spend (id TEXT NOT NULL,runId TEXT NOT NULL REFERENCES wf_run_registrations(runId),json TEXT NOT NULL, PRIMARY KEY(runId,id))');return l;}
export function appendSpend(raw:unknown) {
 const row=SpendRecordSchema.parse(raw),l=ledger();const run=l.registration(row.runId);if(!run)throw new LedgerError(404,'run_missing');
 if(row.caseRevision){const rev=l.revision(row.caseRevision,run.projectId);if(rev.runId!==row.runId)throw new LedgerError(409,'spend_revision_conflict');}
 // Price is captured once. Changing a local price file never silently rewrites a historical estimate.
 const known=l.db.prepare('SELECT json FROM role_spend WHERE runId=? AND id=?').get(row.runId,row.id) as {json:string}|undefined;
 if(known){const prior=JSON.parse(known.json);for(const field of ['priceVersion','estimatedUsd','priceReason'])delete prior[field];const candidate={...row} as Record<string,unknown>;for(const field of ['priceVersion','estimatedUsd','priceReason'])delete candidate[field];if(canonicalJSON(prior)!==canonicalJSON(candidate))throw new LedgerError(409,'spend_identity_conflict');return false;}
 const record={...row,...priceSpend(row,prices())};l.db.prepare('INSERT INTO role_spend VALUES (?,?,?)').run(row.id,row.runId,canonicalJSON(record));return true;
}
export function recordModelRequests(runId:string,records:RoleRequestRecord[],context:{caseRevision?:string;executionId?:string}={}){
 for(const r of records){if(!r.requestId)continue;appendSpend({id:r.requestId,runId,role:r.role,source:'role-proxy',...context,model:r.model,endpoint:r.endpoint,at:r.at??new Date().toISOString(),ms:r.ms,forwarded:r.forwarded??null,httpStatus:r.status,inputTokens:r.usage?.inputTokens??null,outputTokens:r.usage?.outputTokens??null,totalTokens:r.usage?.totalTokens??null,cachedInputTokens:r.usage?.cachedInputTokens??null,cacheWriteTokens:0});}
}
const finite=(x:unknown)=>typeof x==='number'&&Number.isFinite(x)&&x>=0?x:null;
export function recordHostSummary(runId:string,host:'claude-code'|'codex',sessionId:string,usage:Record<string,unknown>,model:string|null=null,reportedUsd:unknown=null){
 const input=finite(usage.input_tokens),output=finite(usage.output_tokens),read=finite(host==='codex'?usage.cached_input_tokens:usage.cache_read_input_tokens),write=host==='codex'?0:finite(usage.cache_creation_input_tokens);
 const totalInput=host==='codex'?input:input!==null&&read!==null&&write!==null?input+read+write:null;
 const id=`host-summary:${host}:${sessionId}`, prior=ledger().db.prepare('SELECT json FROM role_spend WHERE runId=? AND id=?').get(runId,id) as {json:string}|undefined;
 appendSpend({id,runId,role:'planner',source:'host-summary',model,endpoint:null,at:prior?JSON.parse(prior.json).at:new Date().toISOString(),ms:null,forwarded:null,httpStatus:null,inputTokens:totalInput,outputTokens:output,cachedInputTokens:read,cacheWriteTokens:write,totalTokens:totalInput!==null&&output!==null?totalInput+output:null,reportedUsd:finite(reportedUsd)});
}
function nullableSum(rows:SpendRecord[],field:keyof SpendRecord){const values=rows.map(r=>r[field]);return rows.length&&values.every(v=>typeof v==='number')?(values as number[]).reduce((a,b)=>a+b,0):null;}
export function runRoleSpend(runId:string,projectId:string){
 const l=ledger(),run=l.getRun(runId,projectId);const executions=run.revisions.filter(r=>r.kind==='execution').map(r=>l.readRevision(r.id,projectId).content as any);
 // Import past completed evidence through the same idempotent ledger, including runs from before N-17.
 for(const execution of executions){const code=l.readRevision(execution.codeRevision,projectId).content as any;for(const result of execution.results??[]){const rev=(code.approvedRevisions??[]).find((id:string)=>(l.readRevision(id,projectId).content as any).id===result.caseId);if(Array.isArray(result.modelRequests))recordModelRequests(runId,result.modelRequests,{caseRevision:rev,executionId:execution.executionId});}}
 const records=(l.db.prepare('SELECT json FROM role_spend WHERE runId=? ORDER BY rowid').all(runId) as {json:string}[]).map(r=>SpendRecordSchema.parse(JSON.parse(r.json)));
 const roles=(['planner','executor'] as const).map(role=>{
  const rows=records.filter(r=>r.role===role), unknownExecution=role==='executor'&&executions.some(e=>e.usageComplete===false||(e.results??[]).some((r:any)=>r.caseId&&!Array.isArray(r.modelRequests)));
  const observedZero=role==='executor'&&executions.length>0&&!unknownExecution&&rows.length===0&&executions.every(e=>e.forwardedExecutorCalls===0);
  const requestRows=rows.filter(r=>r.source==='role-proxy');const partial=unknownExecution||rows.some(r=>r.source==='unavailable');
  return {role,coverage:observedZero?'observed-zero':partial?'partial':rows.length?'observed':'unknown',calls:observedZero?0:requestRows.length&&!partial?requestRows.filter(r=>r.forwarded).length:null,
   inputTokens:observedZero?0:nullableSum(rows,'inputTokens'),outputTokens:observedZero?0:nullableSum(rows,'outputTokens'),cachedInputTokens:observedZero?0:nullableSum(rows,'cachedInputTokens'),cacheWriteTokens:observedZero?0:nullableSum(rows,'cacheWriteTokens'),totalTokens:observedZero?0:nullableSum(rows,'totalTokens'),
   callMs:observedZero?0:nullableSum(rows,'ms'),reportedUsd:observedZero?0:nullableSum(rows,'reportedUsd'),estimatedUsd:observedZero?0:nullableSum(rows,'estimatedUsd'),unknownCostRecords:rows.filter(r=>r.reportedUsd===null&&r.estimatedUsd===null).length,model:run.binding?.models[role].model??null};
 });
 const times=run as typeof run & {startedAt?:string;finishedAt?:string};
 return {runId,roles,records,wallMs:times.finishedAt&&times.startedAt?Math.max(0,Date.parse(times.finishedAt)-Date.parse(times.startedAt)):null,executionWallMs:executions.reduce((sum,e)=>sum+Math.max(0,Date.parse(e.finishedAt)-Date.parse(e.startedAt)),0),priceNote:'Price estimates and host-reported cost are separate; absent usage/price is unknown. Retry ordinals are unknown unless the caller supplied them.'};
}
