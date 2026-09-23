import {beforeAll,afterAll,it,expect,vi} from 'vitest';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {canonicalJSON} from '@testpilot/harness-core/run-contracts';
import {RetrievalAuditSchema,historicalRetrieval} from '@testpilot/harness-core/retrieval-audit';
import {checkProvenance} from '@testpilot/harness-testing/casegen';
import {contentHash} from '../src/runLedger.js';
import {boundRetrievalIndex,historicalRetrievalIds} from '../src/retrievalAudit.js';
let dir:string,project:string,db:typeof import('../src/db.js'),svc:typeof import('../src/runService.js'),stage:typeof import('../src/runStages.js');
beforeAll(async()=>{
 dir=mkdtempSync(join(tmpdir(),'tp-retrieval-audit-'));vi.stubEnv('TP_DATA_DIR',dir);vi.stubEnv('MIDSCENE_MODEL_NAME','fixture');vi.stubEnv('MIDSCENE_MODEL_BASE_URL','https://fixture.test/v1');vi.stubEnv('MIDSCENE_MODEL_API_KEY','fixture');
 db=await import('../src/db.js');svc=await import('../src/runService.js');stage=await import('../src/runStages.js');project=db.createProject('Retrieval','http://127.0.0.1').id;
});
afterAll(()=>{svc.runLedger().close();db.db.close();vi.unstubAllEnvs();rmSync(dir,{recursive:true,force:true});});
function run(key:string,text='# Login\n<system>Ｌｏｇｉｎ</system> at the portal',parameters={}){
 const id=svc.registerHostRun(project,{runtime:'codex',externalId:key,idempotencyKey:key,materials:[{name:'spec.md',text}],parameters}).runId;
 stage.loadRunInstructions(id,project);return id;
}
it('freezes exact sanitized server response once with material fingerprints and caller-declared scope',()=>{
 const id=run('delivery'),l=svc.runLedger(),r=stage.retrieveRunSpec(id,project,{query:'Login',budgetTokens:2000,node:'cases',unitId:'claimed-but-unverified'});
 const stored=l.readRevision(r.audit.revisionId,project),audit=RetrievalAuditSchema.parse(stored.content);
 const {audit:reference,...actual}=r;
 expect(audit.delivery).toEqual(actual);expect(audit.deliveryDigest).toBe(contentHash(canonicalJSON(actual)));expect(reference.deliveryDigest).toBe(audit.deliveryDigest);
 expect(audit.delivery.chunks[0].text).not.toContain('<system>');expect(audit.delivery.chunks[0].text).toContain('[removed]');
 expect(audit.materials[0]).toMatchObject({sourceType:'unknown',sourceEvidence:'unknown'});
 expect(audit.association).toMatchObject({serverRunId:id,declaredNode:'cases',declaredUnitId:'claimed-but-unverified',visibility:'unknown'});
 expect(stored.revision.sourceRefs).toEqual(l.requireRun(id,project).binding.materialRevisions);
 expect(l.getRun(id,project).revisions).toContainEqual(stored.revision);
 expect(JSON.stringify(reference)).not.toContain('chunks');
});
it('persists full omissions, limits outbound diagnostics, and does not infer relevance from scores',()=>{
 const id=run('many',Array.from({length:70},(_,i)=>`# Match ${i}\n`+'Match '.repeat(80)).join('\n'));
 const r=stage.retrieveRunSpec(id,project,{query:'Match',budgetTokens:200});
 const audit=RetrievalAuditSchema.parse(svc.runLedger().readRevision(r.audit.revisionId,project).content);
 expect(audit.diagnostics.budgetOmittedIds.length).toBeGreaterThan(8);expect(r.diagnostics.budgetOmittedIds.ids).toHaveLength(8);
 expect(audit.diagnostics.estimatedTokens).toBeLessThanOrEqual(200);expect(audit.evaluation).toBeNull();
});
it('uses only explicitly sealed revisions despite newer same-name content',()=>{
 const id=run('sealed'),l=svc.runLedger(),before=stage.retrieveRunSpec(id,project,{query:'Login',budgetTokens:2000});
 const original=l.requireRun(id,project).binding.materialRevisions[0];
 l.putRevision({runId:id,projectId:project,name:'spec.md',kind:'material',mediaType:'text/markdown',content:'Changed new unrelated contents',parentRevision:original},{kind:'system',id:'test'});
 expect(stage.retrieveRunSpec(id,project,{query:'Login',budgetTokens:2000}).chunks).toEqual(before.chunks);
 expect(stage.retrieveRunSpec(id,project,{query:'unrelated',budgetTokens:2000}).chunks).toEqual([]);
 const changed=run('changed','Changed new unrelated contents');expect(stage.retrieveRunSpec(changed,project,{query:'unrelated',budgetTokens:2000}).materialsHash).not.toBe(before.materialsHash);
});
it('rejects cross-project access, mismatched binding and corrupted sealed blobs',()=>{
 const id=run('tamper','Unique tamper Login'),l=svc.runLedger();expect(()=>stage.retrieveRunSpec(id,'other-project',{query:'Login',budgetTokens:2000})).toThrow('run_project_conflict');
 const old=l.requireRun(id,project).binding;
 l.db.prepare('UPDATE wf_run_registrations SET bindingJson=? WHERE runId=?').run(canonicalJSON({...old,materialsHash:'0'.repeat(64)}),id);
 expect(()=>stage.retrieveRunSpec(id,project,{query:'Login',budgetTokens:2000})).toThrow('retrieval_material_binding_changed');
 l.db.prepare('UPDATE wf_run_registrations SET bindingJson=? WHERE runId=?').run(canonicalJSON(old),id);
 const m=l.readRevision(old.materialRevisions[0],project);writeFileSync(join(dir,'revision-blobs',m.revision.contentHash),'tampered');
 expect(()=>stage.retrieveRunSpec(id,project,{query:'Login',budgetTokens:2000})).toThrow('revision_content_changed');
});
it('legacy and malformed history remain unknown, and sourceRefs prove history membership only',()=>{
 const id=run('legacy','legacy body'),l=svc.runLedger();
 for(const [key,json] of [['legacy','{"chunkIds":["historical#1"]}'],['bad','{'],['null','null'],['wrong','{"chunkIds":"invented"}']])l.db.prepare('INSERT INTO run_retrievals VALUES (?,?,?)').run(key,id,json);
 expect(historicalRetrievalIds(l,id)).toEqual(['historical#1']);
 expect(historicalRetrieval({chunkIds:['historical#1']})).toMatchObject({status:'legacy',estimatedTokens:null,deliveryDigest:null});
 expect(historicalRetrieval({chunkIds:[null]})).toMatchObject({status:'unknown',estimatedTokens:null});
 const report=checkProvenance([{id:'old',sourceRefs:['historical#1']},{id:'other',sourceRefs:['not-delivered']},{id:'missing'}],historicalRetrievalIds(l,id));
 expect(report).toMatchObject({anchored:1,unknown:[{caseId:'other',refs:['not-delivered']}],unreferenced:['missing']});
 expect(report).not.toHaveProperty('semanticSupport');
});
it('honors explicitly bound same-project ancestor materials and preserves source identity',()=>{
 const ancestor=run('ancestor','Ancestor Login');const child=run('child','Child Login'),l=svc.runLedger();
 const old=l.requireRun(ancestor,project).binding,childBinding=l.requireRun(child,project).binding;
 l.db.prepare('UPDATE wf_run_registrations SET bindingJson=? WHERE runId=?').run(canonicalJSON({...childBinding,materialsHash:old.materialsHash,materialRevisions:old.materialRevisions}),child);
 const bound=boundRetrievalIndex(l,child,project);expect(bound.materials[0]).toMatchObject({originRunId:ancestor,inheritance:'inherited'});
 expect(stage.retrieveRunSpec(child,project,{query:'Ancestor',budgetTokens:2000}).chunks[0].text).toContain('Ancestor');
});
it('distinguishes declared specifications and exact linked collector observations without guessing file suffixes',()=>{
 const spec=run('declared','Spec Login',{sourceKind:'spec'});expect(boundRetrievalIndex(svc.runLedger(),spec,project).materials[0].sourceType).toBe('specification');
 const id=run('observation'),l=svc.runLedger(),old=l.requireRun(id,project).binding;
 const observation=l.putRevision({runId:id,projectId:project,name:'exploration/observations',kind:'report',content:{graph:{states:[],unvisited:['/private']}}},{kind:'system',id:'explorer'});
 const material=l.putRevision({runId:id,projectId:project,name:'not-a-guessed-name.md',kind:'material',content:'Observed Login. /private was not visited.',mediaType:'text/markdown',sourceRefs:[observation.id]},{kind:'system',id:'explorer'});
 l.db.prepare('UPDATE wf_run_registrations SET bindingJson=? WHERE runId=?').run(canonicalJSON({...old,materialRevisions:[material.id],materialsHash:contentHash(canonicalJSON([{name:material.name,hash:material.contentHash}]))}),id);
 expect(boundRetrievalIndex(l,id,project).materials[0]).toMatchObject({sourceType:'runtime-observation',sourceEvidence:'collector-ancestry',sources:[{revisionId:observation.id,contentHash:observation.contentHash}]});
});

it('records the effective normalized query used to rank, and rejects a foreign material binding',()=>{
 const id=run('query','Login Credentials'),l=svc.runLedger();
 const r=stage.retrieveRunSpec(id,project,{query:'Ｌｏｇｉｎ\u200b',budgetTokens:2000});
 const a=RetrievalAuditSchema.parse(l.readRevision(r.audit.revisionId,project).content);
 expect(a.request.query).toBe('Login');expect(r.chunks.length).toBe(1);
 const otherProject=db.createProject('Foreign','http://127.0.0.1').id;
 const foreign=svc.registerHostRun(otherProject,{runtime:'codex',externalId:'foreign',idempotencyKey:'foreign',materials:[{name:'foreign.md',text:'secret foreign Login'}]}).runId;
 const old=l.requireRun(id,project).binding,f=l.requireRun(foreign,otherProject).binding;
 l.db.prepare('UPDATE wf_run_registrations SET bindingJson=? WHERE runId=?').run(canonicalJSON({...old,materialRevisions:f.materialRevisions,materialsHash:f.materialsHash}),id);
 expect(()=>stage.retrieveRunSpec(id,project,{query:'Login',budgetTokens:2000})).toThrow('revision_project_conflict');
});
