import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {Router} from 'express';
import {canonicalJSON,EntityIdSchema,type Principal,type ArtifactRevision} from '@testpilot/harness-core/run-contracts';
import {contentHash,LedgerError,type RunLedger} from './runLedger.js';
import {runLedger,assertProject} from './runService.js';
import {reviewerPrincipal} from './reviewPrincipal.js';
import {comparisonNodes,type ComparisonNode,type ComparisonArm,type ArtifactComparison,type ComparisonReview} from '../../src/lib/artifactComparison.js';

const nodeSchema=z.enum(comparisonNodes);
const selectionSchema=z.object({runId:EntityIdSchema,revisionIds:z.array(EntityIdSchema).min(1).max(1000).optional()}).strict();
const request=z.object({a:selectionSchema,b:selectionSchema,mode:z.enum(['node-version','input-version','pipeline']),node:z.union([nodeSchema,z.literal('all')])}).strict();
function nodeOf(r:ArtifactRevision):ComparisonNode|undefined {
  if(['exploration/observations','exploration/report','exploration.md','product/model-candidate'].includes(r.name))return 'source';
  for(const n of ['modules','stories','cases','gate','finalize'] as const)if(r.name===`validated/${n}`)return n;
  if(r.kind==='code')return 'g2';
  if(r.kind==='execution')return 'execution';
  return undefined;
}
function latest(revisions:ArtifactRevision[]){return [...new Map(revisions.map(r=>[r.name,r])).values()];}
const digest=(value:unknown)=>contentHash(canonicalJSON(value));
export function comparisonArm(l:RunLedger,projectId:string,selection:z.infer<typeof selectionSchema>):ComparisonArm {
  const run=l.requireRun(selection.runId,projectId),all=l.listRevisions(projectId,selection.runId);
  const chosen=selection.revisionIds?selection.revisionIds.map(id=>{
    const r=l.readRevision(id,projectId).revision;
    if(r.runId!==selection.runId||!nodeOf(r))throw new LedgerError(409,'comparison_revision_scope_conflict');
    return r;
  }):latest(all.filter(r=>nodeOf(r)));
  if(new Set(chosen.map(r=>r.name)).size!==chosen.length)throw new LedgerError(400,'comparison_duplicate_artifact');
  const record=(name:string)=>{const r=all.filter(r=>r.name===name).at(-1);return r?l.readRevision(r.id,projectId).content as Record<string,unknown>:null;};
  const impl=record('implementation/registration'),attempt=record('exploration/attempt');
  const scalar=(v:unknown)=>typeof v==='string'&&v?v:null;
  const nodes=Object.fromEntries(comparisonNodes.map(node=>{
    const outputs=chosen.filter(r=>nodeOf(r)===node);
    // Validate each selected blob now; future corruption must never silently pass.
    outputs.forEach(r=>l.readRevision(r.id,projectId));
    const inputs=[...new Set(outputs.flatMap(r=>r.sourceRefs))].map(id=>l.readRevision(id,projectId).revision);
    // Refs establish ancestry, NOT complete model input or attention.
    return [node,{outputs,inputs,inputDigest:inputs.length?digest(inputs.map(r=>({name:r.name,hash:r.contentHash})).sort((a,b)=>a.name.localeCompare(b.name)||a.hash.localeCompare(b.hash))):null,phase:l.nodeStates(selection.runId).find(s=>s.node===node)?.phase??null}];
  })) as unknown as ComparisonArm['nodes'];
  return {runId:selection.runId,nodes,versions:{
    models:digest(run.binding.models),skill:run.binding.skillVersion,loadedSkills:run.binding.loadedDigest,
    skillAssets:run.binding.assetDigest??null,materials:run.binding.materialsHash,
    workspaceCommit:scalar(impl?.commit),workspaceDiff:scalar(impl?.trackedDiff),loadedImplementation:null,
    environment:scalar(attempt?.environmentHash)??run.binding.environmentHash,
    pageVersion:scalar(attempt?.pageVersion),scenarioState:null,
    rules:all.some(r=>r.name.startsWith('knowledge/'))?digest(latest(all.filter(r=>r.name.startsWith('knowledge/'))).map(r=>({name:r.name,hash:r.contentHash})).sort((a,b)=>a.name.localeCompare(b.name))):null,
    scope:scalar(attempt?.scopeHash),
  }};
}
export function createComparison(l:RunLedger,projectId:string,raw:unknown){
  const req=request.parse(raw);
  if(req.a.runId===req.b.runId&&!req.a.revisionIds&&!req.b.revisionIds)throw new LedgerError(400,'comparison_distinct_selections_required');
  const a=comparisonArm(l,projectId,req.a),b=comparisonArm(l,projectId,req.b);
  const selectedNodes=req.node==='all'?comparisonNodes:[req.node];
  if(selectedNodes.every(n=>!a.nodes[n].outputs.length||!b.nodes[n].outputs.length))throw new LedgerError(409,'comparison_no_paired_outputs');
  const differences=Object.keys(a.versions).map(field=>{const av=a.versions[field],bv=b.versions[field];return {field,a:av,b:bv,status:!av||!bv?'unknown' as const:av===bv?'same' as const:'different' as const};});
  for(const n of selectedNodes){const av=a.nodes[n].inputDigest,bv=b.nodes[n].inputDigest;differences.push({field:`inputs.${n}`,a:av,b:bv,status:!av||!bv?'unknown':av===bv?'same':'different'});}
  const value:ArtifactComparison={schemaVersion:'artifact-comparison.v1',projectId,at:new Date().toISOString(),mode:req.mode,node:req.node,a,b,differences,
    limitations:['ancestry-is-not-complete-input','workspace-is-not-loaded-implementation','scenario-state-unverified','manual-review-is-not-gold','no-causal-attribution'],attribution:'diagnostic-only',scorerVersion:'artifact-comparison.v1'};
  const refs=[...new Set([a,b].flatMap(arm=>comparisonNodes.flatMap(n=>[...arm.nodes[n].inputs,...arm.nodes[n].outputs].map(r=>r.id))))];
  return l.putRevision({runId:b.runId,projectId,name:`comparison/${randomUUID()}`,kind:'evaluation',content:value,sourceRefs:refs},{kind:'system',id:'artifact-comparator'});
}
export function readComparison(l:RunLedger,projectId:string,id:string){
  const record=l.readRevision(id,projectId);
  if(!record.revision.name.startsWith('comparison/')||(record.content as ArtifactComparison)?.schemaVersion!=='artifact-comparison.v1')throw new LedgerError(404,'comparison_missing');
  return {revision:record.revision,comparison:record.content as ArtifactComparison,reviews:l.listRevisions(projectId,record.revision.runId).filter(r=>r.name.startsWith(`comparison-review/${id}/`)).map(r=>({revision:r,review:l.readRevision(r.id,projectId).content as ComparisonReview}))};
}
export function reviewComparison(l:RunLedger,projectId:string,id:string,raw:unknown,actor:Principal){
  const req=z.object({node:z.union([nodeSchema,z.literal('all')]),dimension:z.enum(['overall','coverage','correctness','evidence','usability','noise']),verdict:z.enum(['a-better','same','b-better','incomparable']),note:z.string().trim().min(10).max(4000),evidence:z.array(EntityIdSchema).min(1).max(30)}).strict().parse(raw);
  const {comparison,revision}=readComparison(l,projectId,id);
  if(comparison.node!=='all'&&req.node!==comparison.node)throw new LedgerError(409,'review_node_scope_conflict');
  const nodes=req.node==='all'?comparisonNodes:[req.node];
  const allowed=new Set([comparison.a,comparison.b].flatMap(a=>nodes.flatMap(n=>[...a.nodes[n].inputs,...a.nodes[n].outputs].map(r=>r.id))));
  if(req.evidence.some(id=>!allowed.has(id)))throw new LedgerError(409,'review_evidence_outside_comparison');
  const content:ComparisonReview={schemaVersion:'artifact-comparison-review.v1',comparisonId:id,...req,at:new Date().toISOString(),actor,identityEvidence:'local-action-source',promotesBaseline:false};
  return l.putRevision({runId:revision.runId,projectId,name:`comparison-review/${id}/${randomUUID()}`,kind:'evaluation',content,sourceRefs:[id,...req.evidence]},{...actor});
}
export function artifactComparisonRouter(){
  const router=Router({mergeParams:true});
  router.use((req,res,next)=>{try{assertProject((req.params as {projectId:string}).projectId);next();}catch(e){res.status(404).json({error:(e as Error).message});}});
  const wrap=(fn:(req:any,res:any)=>void)=>(req:any,res:any)=>{try{fn(req,res);}catch(e){res.status(e instanceof LedgerError?e.status:400).json({error:(e as Error).message});}};
  router.get('/',wrap((req,res)=>res.json({comparisons:runLedger().listRevisions(req.params.projectId).filter(r=>r.name.startsWith('comparison/')).reverse()})));
  router.post('/',wrap((req,res)=>res.status(201).json({revision:createComparison(runLedger(),req.params.projectId,req.body)})));
  router.get('/:id',wrap((req,res)=>res.json(readComparison(runLedger(),req.params.projectId,req.params.id))));
  router.post('/:id/reviews',wrap((req,res)=>res.status(201).json({revision:reviewComparison(runLedger(),req.params.projectId,req.params.id,req.body,reviewerPrincipal(req))})));
  return router;
}
