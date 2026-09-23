import {beforeAll,afterAll,it,expect,vi} from 'vitest';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
let createComparison:typeof import('../src/artifactComparisons.js').createComparison,readComparison:typeof import('../src/artifactComparisons.js').readComparison,reviewComparison:typeof import('../src/artifactComparisons.js').reviewComparison;
import type {RunLedger} from '../src/runLedger.js';
let dir:string,p:string,l:RunLedger,svc:typeof import('../src/runService.js'),db:typeof import('../src/db.js');
beforeAll(async()=>{dir=mkdtempSync(join(tmpdir(),'tp-comparison-'));vi.stubEnv('TP_DATA_DIR',dir);vi.stubEnv('MIDSCENE_MODEL_NAME','fixture');vi.stubEnv('MIDSCENE_MODEL_BASE_URL','https://fixture.test/v1');vi.stubEnv('MIDSCENE_MODEL_API_KEY','fixture');({createComparison,readComparison,reviewComparison}=await import('../src/artifactComparisons.js'));svc=await import('../src/runService.js');db=await import('../src/db.js');p=db.createProject('Compare','https://fixture.test').id;l=svc.runLedger();});
afterAll(()=>{l.close();db.db.close();vi.unstubAllEnvs();rmSync(dir,{recursive:true,force:true});});
function arm(key:string,project=p){const id=svc.registerHostRun(project,{runtime:'codex',externalId:key,idempotencyKey:key,materials:[{name:'spec.md',text:'A fixed requirement'}]}).runId;const input=l.requireRun(id,project).binding.materialRevisions;const output=l.putRevision({projectId:project,runId:id,name:'validated/stories',kind:'stories',content:{stories:[{id:'s',title:key}]},sourceRefs:input},{kind:'agent',id:'codex'});return {id,output};}
it('pins outputs, compares input content rather than random revision IDs, and never invents historic evidence',()=>{
 const a=arm('a'),b=arm('b');const rev=createComparison(l,p,{a:{runId:a.id},b:{runId:b.id},node:'stories',mode:'node-version'});
 const old=readComparison(l,p,rev.id).comparison;expect(old.a.nodes.stories.inputDigest).toBe(old.b.nodes.stories.inputDigest);
 expect(old.differences.find(d=>d.field==='scenarioState')?.status).toBe('unknown');expect(old.attribution).toBe('diagnostic-only');
 l.putRevision({runId:b.id,projectId:p,name:'validated/stories',kind:'stories',parentRevision:b.output.id,content:{stories:[]}},{kind:'agent',id:'codex'});
 expect(readComparison(l,p,rev.id).comparison.b.nodes.stories.outputs[0].id).toBe(b.output.id);
 expect(old.a.versions.workspaceCommit).toMatch(/^[a-f0-9]{40}$/);expect(old.a.versions.loadedImplementation).toBeNull();
});
it('supports explicit historical revisions and append-only dimension reviews without promoting a baseline',()=>{
 const a=arm('review-a'),b=arm('review-b');const rev=createComparison(l,p,{a:{runId:a.id,revisionIds:[a.output.id]},b:{runId:b.id,revisionIds:[b.output.id]},node:'stories',mode:'input-version'});
 const review={node:'stories',dimension:'evidence',verdict:'incomparable',note:'Initial scenario state was not recorded.',evidence:[a.output.id]};
 for(let i=0;i<2;i++)reviewComparison(l,p,rev.id,review,{kind:'human',id:'local-operator'});
 const result=readComparison(l,p,rev.id);expect(result.reviews).toHaveLength(2);expect(result.reviews[1].review.promotesBaseline).toBe(false);
 expect(()=>reviewComparison(l,p,rev.id,{...review,node:'cases'},{kind:'human',id:'local-operator'})).toThrow('review_node_scope_conflict');
 expect(()=>reviewComparison(l,p,rev.id,{...review,evidence:[rev.id]},{kind:'human',id:'local-operator'})).toThrow('review_evidence_outside_comparison');
});
it('rejects cross-project, cross-run revisions, missing paired outputs and changed blobs',()=>{
 const a=arm('scope-a'),b=arm('scope-b'),other=db.createProject('Other','https://other.test').id,c=arm('foreign',other);
 const req={a:{runId:a.id},b:{runId:b.id},node:'stories',mode:'pipeline'};
 expect(()=>createComparison(l,p,{...req,b:{runId:c.id}})).toThrow('run_project_conflict');
 expect(()=>createComparison(l,p,{...req,b:{runId:b.id,revisionIds:[a.output.id]}})).toThrow('comparison_revision_scope_conflict');
 expect(()=>createComparison(l,p,{...req,node:'execution'})).toThrow('comparison_no_paired_outputs');
 writeFileSync(join(dir,'revision-blobs',b.output.contentHash),'tampered');expect(()=>createComparison(l,p,req)).toThrow('revision_content_changed');
});
