import {beforeAll,afterAll,it,expect,vi} from 'vitest';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';
import {RunLedger} from '../src/runLedger.js';
import {captureExecutionMemory,selectRunMemory} from '../src/runMemory.js';
import {experienceScope} from '../src/preparationExperience.js';
import {captureWebModels} from './helpers/model-snapshot.js';
/**
 * docs/reports/workflow-review-2026-09-24.md §2.5：clean 隔离漏项（执行记忆、准备经验 lineage）与规划器能改知识库。
 */
let dir:string,project:string,db:typeof import('../src/db.js'),lib:typeof import('../src/knowledgeLibrary.js'),packs:typeof import('../src/rulePacks.js');
const RAW=JSON.parse(readFileSync(resolve(import.meta.dirname,'../../packages/harness-testing/test/fixtures/perp-lab-rules.json'),'utf8')) as Record<string,unknown>;
const human={kind:'human' as const,id:'local-operator'};
beforeAll(async()=>{dir=mkdtempSync(join(tmpdir(),'tp-isolation-fix-'));vi.stubEnv('TP_DATA_DIR',dir);db=await import('../src/db.js');lib=await import('../src/knowledgeLibrary.js');packs=await import('../src/rulePacks.js');project=db.createProject('Isolation','http://127.0.0.1:5391/').id;});
afterAll(async()=>{(await import('../src/runService.js')).runLedger().close();db.db.close();vi.unstubAllEnvs();rmSync(dir,{recursive:true,force:true});});

function memoryLedger(){const ledger=new RunLedger(':memory:',join(dir,'blobs-'+Math.random().toString(36).slice(2)));
 const run=(id:string,parameters:Record<string,unknown>={})=>{ledger.register({id,projectId:'p',externalId:id,idempotencyKey:id,parameters,binding:{schemaVersion:1,models:captureWebModels().binding,skillVersion:'test',loadedDigest:null,materialsHash:'a'.repeat(64),inputHash:'b'.repeat(64),environmentHash:null,materialRevisions:[]}},{kind:'system',id:'test'});return id;};
 return {ledger,run};}

it('clean runs (reuseExperience:false) never read historical execution memory',()=>{
 const {ledger,run}=memoryLedger();const source=run('source');
 const rev=ledger.putRevision({runId:source,projectId:'p',name:'execution/e1',kind:'execution',content:{status:'failed'}},{kind:'system',id:'workflow-executor'});captureExecutionMemory(ledger,rev.id,'p','https://app.test');
 expect(selectRunMemory(ledger,run('incremental',{reuseExperience:true}),'p','https://app.test').entries).toHaveLength(1);
 const clean=selectRunMemory(ledger,run('clean',{projectRunMode:'clean',reuseExperience:false}),'p','https://app.test');
 expect(clean.entries).toHaveLength(0);expect(clean.enabled).toBe(false);
 ledger.close();
});

it('preparation experience scope separates a rebuild lineage from the main line, main hash unchanged',()=>{
 const {ledger,run}=memoryLedger();
 const legacy=experienceScope(ledger,run('legacy'),'p','cfg'),main=experienceScope(ledger,run('main',{projectLineageId:'main'}),'p','cfg'),rebuild=experienceScope(ledger,run('rebuild',{projectLineageId:'line-x'}),'p','cfg'),rebuild2=experienceScope(ledger,run('rebuild2',{projectLineageId:'line-x'}),'p','cfg');
 expect(main.hash).toBe(legacy.hash);expect(rebuild.hash).not.toBe(main.hash);expect(rebuild2.hash).toBe(rebuild.hash);
 ledger.close();
});

it('knowledge library saves require a human and leave an audit record',async()=>{
 expect(()=>lib.saveKnowledgeLibrary(project,'domainKnowledge',{value:'Model says so'},{kind:'agent',id:'planner'})).toThrow('operator_action_required');
 const saved=lib.saveKnowledgeLibrary(project,'domainKnowledge',{value:'Operator knowledge'},human);lib.saveKnowledgeLibrary(project,'domainKnowledge',{value:'Operator knowledge'},human);
 expect(lib.knowledgeLibraryAudit(project,'domainKnowledge')).toEqual([expect.objectContaining({kind:'domainKnowledge',id:saved.id,actor:human,created:true}),expect.objectContaining({id:saved.id,created:false})]);
 expect(lib.knowledgeLibraryAudit(project,'domainKnowledge')[0]!.at).toMatch(/^\d{4}-/);
 const {default:express}=await import('express');const app=express();app.use(express.json());app.use('/api/projects/:projectId/knowledge-library',lib.knowledgeLibraryRouter());const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
 const base=`http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/api/projects/${project}/knowledge-library`;
 try{
  // 宿主工具带 x-testpilot-actor 头（packages/testpilot-mcp/src/host/api.ts）；带运行令牌的也一样拒。
  for(const headers of [{'x-testpilot-actor':'agent'},{authorization:'Bearer run-token'}])expect((await fetch(base+'/domainKnowledge',{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify({value:'Planner rewrite'})})).status).toBe(403);
  expect((await fetch(base+'/domainKnowledge',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({value:'Operator via Web'})})).status).toBe(200);
  expect(lib.knowledgeLibraryAudit(project,'domainKnowledge').map(a=>a.actor.kind)).toEqual(['human','human','human']);
 }finally{await new Promise<void>(r=>server.close(()=>r()));}
});

it('a run without an explicit rule pack does not silently pick up a model-drafted latest version',async()=>{
 const operator=packs.saveRulePack(project,RAW,human);
 await new Promise(r=>setTimeout(r,5));
 const drafted=packs.saveRulePack(project,{...RAW,version:`${String(RAW.version)}-draft`},{kind:'agent',id:'agent'});
 expect(drafted.hash).not.toBe(operator.hash);
 expect(packs.currentRulePack(project)?.version).toBe(RAW.version);
 expect(packs.rulePackAuthors(project,drafted.hash)).toEqual([expect.objectContaining({kind:'agent',id:'agent'})]);
 // 人把起草版存一次（在 Web 上采纳），它才成为项目当前那一份。
 await new Promise(r=>setTimeout(r,5));
 lib.saveKnowledgeLibrary(project,'rulePack',{value:{...RAW,version:`${String(RAW.version)}-draft`}},human);
 expect(packs.currentRulePack(project)?.version).toBe(`${String(RAW.version)}-draft`);
});
