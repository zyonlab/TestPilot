import { z } from 'zod';

const ids = z.array(z.string());
export const RetrievalDiagnosticsSchema = z.object({
  version: z.literal(1), mode: z.enum(['requested','ranked']), budgetTokens: z.number().int().nonnegative(),
  estimatedTokens: z.number().int().nonnegative(), budgetScope: z.literal('sanitized-heading-and-text'),
  tokenAccounting: z.literal('estimate-not-model-usage'), budgetOmittedIds: ids, deliveryOmittedIds: ids,
  unknownRequiredIds: ids, duplicateRequestedIds: ids,
});
const page = z.object({ids, total:z.number().int().nonnegative(), nextOffset:z.number().int().nonnegative().nullable()});
export const RetrievalAuditSchema = z.object({
  schemaVersion:z.literal('retrieval-audit.v1'), retrievalId:z.string(), projectId:z.string(), runId:z.string(), at:z.string(),
  materialsHash:z.string(), inputHash:z.string(), indexDigest:z.string(), deliveryDigest:z.string(),
  association:z.object({serverRunId:z.string(), serverActiveStages:ids, declaredNode:z.string().nullable(), declaredUnitId:z.string().nullable(), visibility:z.literal('unknown')}),
  materials:z.array(z.object({docId:z.string(), revisionId:z.string(), originRunId:z.string(), inheritance:z.enum(['inherited','current-run']), contentHash:z.string(), sourceRefs:ids,
    sourceType:z.enum(['specification','runtime-observation','unknown']), sourceEvidence:z.enum(['collector-ancestry','declared-source-kind','unknown']),
    sources:z.array(z.object({revisionId:z.string(), runId:z.string(), contentHash:z.string(), name:z.string()}))})),
  request:z.object({query:z.string(), chunkIds:ids.nullable()}),
  diagnostics:RetrievalDiagnosticsSchema,
  delivery:z.object({chunks:z.array(z.object({id:z.string(),docId:z.string(),heading:ids,text:z.string(),tokens:z.number().nonnegative(),score:z.number(),why:z.string()})),
    diagnostics:RetrievalDiagnosticsSchema.omit({budgetOmittedIds:true,deliveryOmittedIds:true,unknownRequiredIds:true,duplicateRequestedIds:true}).extend({budgetOmittedIds:page,deliveryOmittedIds:page,unknownRequiredIds:page,duplicateRequestedIds:page}),
    dropped:z.number(), hint:z.string(), indexed:z.number(), retrievalId:z.string(), materialsHash:z.string(), notice:z.string()}),
  evaluation:z.null(),
});
export type RetrievalAudit = z.infer<typeof RetrievalAuditSchema>;

/** Old JSON is evidence of historical IDs only, never measured usage or current visibility. */
export function historicalRetrieval(value: unknown): {chunkIds:string[];estimatedTokens:number|null;deliveryDigest:string|null;status:'audited'|'legacy'|'unknown'} {
  const checked=RetrievalAuditSchema.safeParse(value);
  if(checked.success)return {chunkIds:checked.data.delivery.chunks.map(c=>c.id),estimatedTokens:checked.data.diagnostics.estimatedTokens,deliveryDigest:checked.data.deliveryDigest,status:'audited'};
  if(value&&typeof value==='object'&&Array.isArray((value as {chunkIds?:unknown}).chunkIds)){
    const ids=(value as {chunkIds:unknown[]}).chunkIds;
    if(ids.every(id=>typeof id==='string'))return {chunkIds:[...new Set(ids as string[])],estimatedTokens:null,deliveryDigest:null,status:'legacy'};
  }
  return {chunkIds:[],estimatedTokens:null,deliveryDigest:null,status:'unknown'};
}
