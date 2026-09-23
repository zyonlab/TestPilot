import {beforeAll,afterAll,beforeEach,it,expect,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
const f=vi.hoisted(()=>({finalized:true,hashB:'same',frozen:true,project:'p',status:'waiting_review'}));
vi.mock('../src/graphs.js',()=>({}));vi.mock('../src/procs.js',()=>({bus:{publish:vi.fn()}}));
vi.mock('../src/benchmarkCatalog.js',()=>({benchmarkMetadata:()=>({projectId:f.project})}));
vi.mock('../src/gold.js',()=>({requireFrozenReviewedGold:()=>{if(!f.frozen)throw new Error('human_frozen_gold_required');return {hash:'gold',gold:{id:'g',items:[{id:'dev',title:'Increment',split:'dev',match:{anyOf:['increment']}},{id:'secret',title:'PRIVATE',split:'heldout',heldOut:true,match:{anyOf:['private']}}]}};}}));
vi.mock('../src/runStages.js',()=>({registeredStageProducts:()=>({finalized:f.finalized})}));
vi.mock('../src/runService.js',()=>({runLedger:()=>({
 requireRun:(id:string)=>({binding:{materialsHash:id==='b'?f.hashB:'same',models:{runtime:id==='a'?'codex':'claude-code'}}}),getRun:()=>({status:f.status}),
 listRevisions:(_p:string,id:string)=>[{id,name:'validated/cases',revision:1,contentHash:id}],
 readRevision:()=>({content:{cases:[{id:'c',title:'Increment',steps:['Click increment'],expected:'1'}]}})
})}));
let dir:string,api:typeof import('../src/evals.js');
beforeAll(async()=>{dir=mkdtempSync(join(tmpdir(),'tp-registered-eval-'));vi.stubEnv('TP_DATA_DIR',dir);api=await import('../src/evals.js');});
afterAll(()=>{vi.unstubAllEnvs();rmSync(dir,{recursive:true,force:true});});
beforeEach(()=>Object.assign(f,{finalized:true,hashB:'same',frozen:true,project:'p',status:'waiting_review'}));
const req={projectId:'p',a:'a',b:'b',capability:'g'};
it('compares immutable finalized native outputs without revealing heldout content',async()=>{const result=await api.evaluateRegisteredRuns(req);expect(result.a.coverage).toBe(1);expect(result.b.label).toBe('claude-code');expect(JSON.stringify(result)).not.toContain('PRIVATE');expect(api.listEvals().find(r=>r.id===result.id)?.projectId).toBe('p');});
it('rejects unfinished, cancelled, cross-project and unreviewed evaluations',async()=>{
 f.finalized=false;await expect(api.evaluateRegisteredRuns(req)).rejects.toThrow('eval_run_not_finalized');f.finalized=true;
 f.status='cancelled';await expect(api.evaluateRegisteredRuns(req)).rejects.toThrow('eval_run_not_completed');f.status='waiting_review';
 f.project='other';await expect(api.evaluateRegisteredRuns(req)).rejects.toThrow('eval_gold_project_mismatch');f.project='p';
 f.frozen=false;await expect(api.evaluateRegisteredRuns(req)).rejects.toThrow('human_frozen_gold_required');
});
it('rejects different source materials and comparing a run with itself',async()=>{f.hashB='different';await expect(api.evaluateRegisteredRuns(req)).rejects.toThrow('eval_materials_mismatch');await expect(api.evaluateRegisteredRuns({...req,b:'a'})).rejects.toThrow('eval_distinct_runs_required');});
