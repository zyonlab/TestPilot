/** Production release gates read immutable workflow receipts and human-frozen gold.
 * The deployment manifest supplies run references, never scores or expected answers.
 * Nothing in this module is sent to the candidate model.
 */
import{createRequire}from'node:module';import type{DatabaseSync as SQLite}from'node:sqlite';
import{readFileSync,existsSync,writeFileSync,mkdirSync}from'node:fs';import{join,resolve}from'node:path';import{createHash}from'node:crypto';
import{scoreCoverage,type GoldChecklist,type CandidateCase}from'@testpilot/harness-core';
import{RunBindingSchema,ArtifactRevisionSchema,canonicalJSON}from'@testpilot/harness-core/run-contracts';
import{requireFrozenReviewedGold}from'../gold.js';import{EvolutionStore,digest,type Score}from'./store.js';import type{TrustedGates}from'./http.js';
const{DatabaseSync}=createRequire(import.meta.url)('node:sqlite') as {DatabaseSync:typeof SQLite};
const sha=(s:string|Buffer)=>createHash('sha256').update(s).digest('hex');
type Ref={dataDir:string;projectId:string;runId:string};type Pair={baseline:Ref[];candidate:Ref[]};
type Manifest={schemaVersion:1;capability:string;candidates:Record<string,{heldout:Pair;hosts:Record<'codex'|'claude-code'|'penguin',Pair>}>};
function receipt(ref:Ref,policyHash:string){
 const root=resolve(ref.dataDir),file=join(root,'workflows.db');if(!existsSync(file))throw new Error('release_workflow_store_missing');
 const db=new DatabaseSync(file,{readOnly:true});try{
  const row=db.prepare('SELECT bindingJson FROM wf_run_registrations WHERE runId=? AND projectId=?').get(ref.runId,ref.projectId) as {bindingJson:string}|undefined;if(!row)throw new Error('release_run_missing');const binding=RunBindingSchema.parse(JSON.parse(row.bindingJson));
  if(!binding.contextPolicy||digest(binding.contextPolicy)!==policyHash||!binding.agentVersion||!binding.loadedDigest||!binding.memoryDigest||!binding.inputHash||!binding.models.planner.model)throw new Error('release_run_binding_incomplete');
  const artifact=(id:string)=>{const r=db.prepare('SELECT json FROM artifact_revisions WHERE id=? AND runId=? AND projectId=?').get(id,ref.runId,ref.projectId) as {json:string}|undefined;if(!r)throw new Error('release_artifact_missing');const revision=ArtifactRevisionSchema.parse(JSON.parse(r.json));const bytes=readFileSync(join(root,'revision-blobs',revision.contentHash));if(sha(bytes)!==revision.contentHash)throw new Error('release_artifact_hash_conflict');return{revision,content:JSON.parse(bytes.toString())};};
  const stage=(name:string)=>{const r=db.prepare('SELECT revisionId FROM run_stage_receipts WHERE runId=? AND stage=?').get(ref.runId,name) as {revisionId:string}|undefined;if(!r)throw new Error('release_stage_missing');return artifact(r.revisionId)};
  const instructions=stage('instructions'),cases=stage('cases');stage('finalize');
  if(instructions.content.memory?.digest!==binding.memoryDigest||instructions.content.loadedDigest!==binding.loadedDigest||sha(canonicalJSON(Object.fromEntries(Object.entries(instructions.content.memory).filter(([k])=>k!=='digest'))))!==binding.memoryDigest)throw new Error('release_memory_receipt_conflict');
  if(instructions.content.memory.enabled!==(binding.contextPolicy.memory==='scoped'))throw new Error('release_policy_not_consumed');
  const exec=db.prepare('SELECT status,resultRevision,codeRevision FROM workflow_executions WHERE runId=? ORDER BY startedAt DESC LIMIT 1').get(ref.runId) as {status:string;resultRevision:string;codeRevision:string}|undefined;
  if(!exec||!['passed','failed','unobservable'].includes(exec.status)||!exec.resultRevision)throw new Error('release_execution_required');const evidence=artifact(exec.resultRevision),code=artifact(exec.codeRevision);
  if(evidence.revision.createdBy.id!=='workflow-executor'||evidence.content.status!==exec.status||evidence.content.codeRevision!==exec.codeRevision||!Array.isArray(evidence.content.results)||!evidence.content.results.length)throw new Error('release_execution_receipt_conflict');
  const original=new Map((cases.content.cases as any[]).map(c=>[c.id,c]));for(const c of code.content.cases??[]){const p=original.get(c.id);if(!p||canonicalJSON({expected:p.expected,oracle:p.oracle??null})!==canonicalJSON({expected:c.expected,oracle:c.oracle??null}))throw new Error('release_oracle_changed_after_generation');}
  if(code.content.cases?.length!==original.size||evidence.content.results.length!==original.size)throw new Error('release_partial_execution');
  return{ref,binding,cases:cases.content.cases as CandidateCase[],status:exec.status,sourceRevisions:[instructions.revision.id,cases.revision.id,evidence.revision.id]};
 }finally{db.close();}
}
export function createGates({store,repoRoot,manifestPath=process.env.TP_EVOLUTION_RELEASE_MANIFEST}:{store:EvolutionStore;repoRoot:string;manifestPath?:string}):TrustedGates{
 if(!manifestPath)return{};const path=resolve(manifestPath);
 const load=(id:string)=>{const m=JSON.parse(readFileSync(path,'utf8')) as Manifest;if(m.schemaVersion!==1||!m.candidates?.[id])throw new Error('candidate_release_manifest_required');return{manifest:m,entry:m.candidates[id],manifestHash:sha(readFileSync(path))};};
 const policyHashes=(id:string)=>{const c=store.candidate(id);if(!c.baseline?.policyHash||!c.candidate||c.candidate.policyHash!==c.policyHash)throw new Error('development_policy_binding_required');return{baseline:c.baseline.policyHash,candidate:c.policyHash};};
 const pairs=(p:Pair,id:string)=>{if(!Array.isArray(p?.baseline)||!Array.isArray(p.candidate)||p.baseline.length<3||p.baseline.length!==p.candidate.length)throw new Error('release_requires_three_pairs');if(new Set([...p.baseline,...p.candidate].map(r=>r.runId)).size!==p.baseline.length+p.candidate.length)throw new Error('release_duplicate_run');const h=policyHashes(id);return{baseline:p.baseline.map(r=>receipt(r,h.baseline)),candidate:p.candidate.map(r=>receipt(r,h.candidate))};};
 const save=(id:string,name:string,value:unknown)=>{const dir=join(store.root,'release-evidence',id);mkdirSync(dir,{recursive:true,mode:0o700});writeFileSync(join(dir,name+'.json'),JSON.stringify(value,null,2),{mode:0o600});return `release-evidence/${id}/${name}.json`;};
 return{
 heldout:async id=>{const{manifest,entry,manifestHash}=load(id);const frozen=requireFrozenReviewedGold(manifest.capability,repoRoot);const rows=pairs(entry.heldout,id),gold=frozen.gold as GoldChecklist;
  const aggregate=(arm:'baseline'|'candidate'):Score=>{const rs=rows[arm],b=rs[0].binding;if(rs.some(r=>r.binding.inputHash!==b.inputHash||r.binding.models.runtime!==b.models.runtime||r.binding.models.planner.model!==b.models.planner.model))throw new Error('release_replicate_binding_conflict');const scores=rs.map(r=>scoreCoverage(gold,r.cases).heldOut.coverage);const source=save(id,`heldout-${arm}`,{manifestHash,goldHash:frozen.hash,runs:rs.map((r,i)=>({runId:r.ref.runId,sourceRevisions:r.sourceRevisions,coverage:scores[i],status:r.status}))});
  return{policyHash:policyHashes(id)[arm],score:scores.reduce((a,b)=>a+b,0)/scores.length,n:rs.length,p0Failures:rs.filter(r=>r.status==='failed').length,unobservable:rs.filter(r=>r.status==='unobservable').length,binding:{inputHash:b.inputHash!,datasetHash:sha(canonicalJSON(gold)),rubricHash:sha(canonicalJSON(gold.items.filter(i=>i.heldOut).map(i=>({id:i.id,match:i.match})))),runtime:b.models.runtime,model:b.models.planner.model!,replicates:rs.length},source};};
  return{baseline:aggregate('baseline'),candidate:aggregate('candidate')};},
 hostRegression:async id=>{const{entry,manifestHash}=load(id);const results=[];for(const runtime of ['codex','claude-code','penguin'] as const){const rs=pairs(entry.hosts?.[runtime],id);for(let i=0;i<rs.baseline.length;i++){const a=rs.baseline[i],b=rs.candidate[i];if(a.binding.models.runtime!==runtime||b.binding.models.runtime!==runtime||a.binding.inputHash!==b.binding.inputHash||a.binding.models.planner.model!==b.binding.models.planner.model)throw new Error('host_regression_binding_conflict');results.push({runtime,baseline:a.ref.runId,candidate:b.ref.runId,passed:a.status==='passed'&&b.status==='passed',sourceRevisions:[...a.sourceRevisions,...b.sourceRevisions]});}}return{passed:results.every(r=>r.passed),policyHash:policyHashes(id).candidate,source:save(id,'host-regression',{manifestHash,results})};},
 };
}
