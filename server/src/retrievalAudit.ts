import { canonicalJSON } from '@testpilot/harness-core/run-contracts';
import { historicalRetrieval, RetrievalAuditSchema } from '@testpilot/harness-core/retrieval-audit';
import { buildIndexFromDocs, retrieve, compactDiagnostics, SPEC_FENCE } from '@testpilot/harness-testing/retrieve';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { contentHash, LedgerError, type RunLedger } from './runLedger.js';

export function historicalRetrievalIds(ledger:RunLedger,runId:string):string[] {
  const rows=ledger.db.prepare('SELECT json FROM run_retrievals WHERE runId=?').all(runId) as {json:string}[];
  return [...new Set(rows.flatMap(row=>{try{return historicalRetrieval(JSON.parse(row.json)).chunkIds;}catch{return [];}}))];
}

/** No mutable directory/index is consulted. These are the exact sealed blobs, checked on every call. */
export function boundRetrievalIndex(ledger:RunLedger,runId:string,projectId:string){
  const run=ledger.requireRun(runId,projectId);
  if(!run.binding.materialsHash||!run.binding.inputHash)throw new LedgerError(409,'inputs_not_sealed');
  const records=run.binding.materialRevisions.map(id=>ledger.readRevision(id,projectId));
  if(records.some(r=>r.revision.kind!=='material'))throw new LedgerError(409,'retrieval_material_scope_conflict');
  if(contentHash(canonicalJSON(records.map(r=>({name:r.revision.name,hash:r.revision.contentHash}))))!==run.binding.materialsHash)throw new LedgerError(409,'retrieval_material_binding_changed');
  const docs=records.map(r=>({docId:`materials/${r.revision.name}`,text:String(r.content)}));
  if(new Set(docs.map(d=>d.docId)).size!==docs.length||docs.some(d=>d.docId.length>480||SPEC_FENCE.sanitizeText(d.docId)!==d.docId))throw new LedgerError(409,'retrieval_material_identity_invalid');
  const materials=records.map((r,i)=>{
    const sources=r.revision.sourceRefs.map(id=>ledger.readRevision(id,projectId).revision);
    const observed=r.revision.createdBy.kind==='system'&&r.revision.createdBy.id==='explorer'&&sources.some(s=>s.name==='exploration/observations'&&s.createdBy.kind==='system'&&s.createdBy.id==='explorer');
    const declared=run.input.parameters.sourceKind==='spec';
    return {docId:docs[i]!.docId,revisionId:r.revision.id,originRunId:r.revision.runId,inheritance:r.revision.runId!==runId||sources.some(s=>s.runId!==runId)?'inherited' as const:'current-run' as const,contentHash:r.revision.contentHash,sourceRefs:r.revision.sourceRefs,
      sourceType:observed?'runtime-observation' as const:declared?'specification' as const:'unknown' as const,
      sourceEvidence:observed?'collector-ancestry' as const:declared?'declared-source-kind' as const:'unknown' as const,
      sources:sources.map(s=>({revisionId:s.id,runId:s.runId,contentHash:s.contentHash,name:s.name}))};
  });
  return {run,materials,index:buildIndexFromDocs(docs,run.binding.materialsHash)};
}

export function auditedRetrieve(ledger:RunLedger,runId:string,projectId:string,raw:unknown){
  const requestSchema=z.object({query:z.string().max(4000),budgetTokens:z.number().int().min(200).max(200_000),chunkIds:z.array(z.string().max(512)).max(256).optional(),node:z.string().max(80).optional(),unitId:z.string().max(160).optional()});
  const input=requestSchema.parse(SPEC_FENCE.sanitizeValue(requestSchema.parse(raw)));
  const {run,materials,index}=boundRetrievalIndex(ledger,runId,projectId);
  const found=retrieve(index,input.query,input.budgetTokens,{chunkIds:input.chunkIds});
  const retrievalId=`retrieve-${randomUUID()}`;
  // This object is returned unchanged by the stage endpoint. Store the sanitized outbound data,
  // not raw index chunks; no second copy of its text is put in the RPC audit summary.
  const delivery=SPEC_FENCE.sanitizeValue({...found,diagnostics:compactDiagnostics(found.diagnostics),retrievalId,
    materialsHash:run.binding.materialsHash!,indexed:index.chunks.length,notice:SPEC_FENCE.notice});
  const audit=RetrievalAuditSchema.parse({schemaVersion:'retrieval-audit.v1',retrievalId,runId,projectId,at:new Date().toISOString(),
    materialsHash:run.binding.materialsHash,inputHash:run.binding.inputHash,indexDigest:contentHash(canonicalJSON(index)),
    deliveryDigest:contentHash(canonicalJSON(delivery)),delivery,diagnostics:found.diagnostics,materials,
    association:{serverRunId:runId,serverActiveStages:ledger.nodeStates(runId).filter(n=>n.phase==='running').map(n=>n.node),declaredNode:input.node??null,declaredUnitId:input.unitId??null,visibility:'unknown'},
    request:{query:SPEC_FENCE.sanitizeText(input.query),chunkIds:input.chunkIds??null},evaluation:null});
  return ledger.db.transaction(()=>{
    const revision=ledger.putRevision({runId,projectId,name:`retrieval/${retrievalId}`,kind:'report',content:audit,sourceRefs:run.binding.materialRevisions},{kind:'system',id:'retrieval-auditor'});
    // Existing table remains the history index. Store a pointer and selected IDs for old readers.
    ledger.db.prepare('INSERT INTO run_retrievals VALUES (?,?,?)').run(retrievalId,runId,canonicalJSON({version:1,revisionId:revision.id,chunkIds:delivery.chunks.map(c=>c.id),materialsHash:run.binding.materialsHash,at:audit.at}));
    return {...delivery,audit:{revisionId:revision.id,deliveryDigest:audit.deliveryDigest,
      digestScope:'canonical-json-response-excluding-audit-reference',visibility:'unknown',evaluation:null}};
  })();
}
