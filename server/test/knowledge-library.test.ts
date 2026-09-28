import {beforeAll,afterAll,it,expect,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {validateRulePack} from '@testpilot/harness-testing/domain';
let dir:string,project:string,other:string,lib:typeof import('../src/knowledgeLibrary.js'),database:typeof import('../src/db.js');
beforeAll(async()=>{dir=mkdtempSync(join(tmpdir(),'knowledge-library-'));vi.stubEnv('TP_DATA_DIR',dir);database=await import('../src/db.js');lib=await import('../src/knowledgeLibrary.js');project=database.createProject('example','https://app.hyperliquid-testnet.xyz/trade').id;other=database.createProject('other','http://localhost').id;});
afterAll(async()=>{(await import('../src/runService.js')).runLedger().close();database.db.close();vi.unstubAllEnvs();rmSync(dir,{recursive:true,force:true});});
it('built-in pack is valid and contains no fabricated observations or trading actions',()=>{const e=lib.listKnowledgeLibrary(project,'rulePack')[0]!;const pack=lib.readKnowledgeLibrary(project,'rulePack',e.id).value;expect(validateRulePack(pack).ok).toBe(true);expect(pack.rules.every((r:any)=>r.claimType==='hypothesis'&&r.verification.kind==='open-question')).toBe(true);expect(pack.targets.every((t:any)=>t.action==='activate'&&t.sideEffect==='ui-only')).toBe(true);});
it('save produces reusable immutable versions and isolates projects',()=>{const first=lib.saveKnowledgeLibrary(project,'domainKnowledge',{title:'custom',value:'Version one'});expect(lib.saveKnowledgeLibrary(project,'domainKnowledge',{value:'Version one'}).id).toBe(first.id);const next=lib.saveKnowledgeLibrary(project,'domainKnowledge',{value:'Version two'});expect(next.id).not.toBe(first.id);expect(lib.readKnowledgeLibrary(project,'domainKnowledge',first.id).value).toBe('Version one');expect(()=>lib.readKnowledgeLibrary(other,'domainKnowledge',first.id)).toThrow('not_found');expect(lib.listKnowledgeLibrary(project,'domainKnowledge')).toHaveLength(3);});
it('editing a built-in makes a project copy and cannot overwrite the template',()=>{const e=lib.listKnowledgeLibrary(project,'domainKnowledge')[0]!;const before=lib.readKnowledgeLibrary(project,'domainKnowledge',e.id);const saved=lib.saveKnowledgeLibrary(project,'domainKnowledge',{value:before.value+'\nNew scope'});expect(saved.id).not.toBe(e.id);expect(lib.readKnowledgeLibrary(project,'domainKnowledge',e.id)).toEqual(before);});
it('rule pack saves share the existing library and invalid content is rejected',async()=>{const e=lib.listKnowledgeLibrary(project,'rulePack')[0]!;const pack=lib.readKnowledgeLibrary(project,'rulePack',e.id).value;const saved=lib.saveKnowledgeLibrary(project,'rulePack',{value:pack});expect((await import('../src/rulePacks.js')).readRulePack(project,saved.id).id).toBe(pack.id);expect(()=>lib.saveKnowledgeLibrary(project,'rulePack',{value:{}})).toThrow();expect(()=>lib.saveKnowledgeLibrary(project,'domainKnowledge',{value:''})).toThrow();expect(()=>lib.listKnowledgeLibrary('missing','domainKnowledge')).toThrow('project_missing');});
it('UI and host use the same save/list/read HTTP endpoints',async()=>{
 const {default:express}=await import('express');const app=express();app.use(express.json());app.use('/api/projects/:projectId/knowledge-library',lib.knowledgeLibraryRouter());const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
 const base=`http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/api/projects/${project}/knowledge-library`;
 try{
  const saved=await fetch(base+'/domainKnowledge',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:'Host authored',value:'Host saved knowledge'})});expect(saved.status).toBe(200);const {id}=await saved.json();
  const listed=await (await fetch(base+'/domainKnowledge')).json();expect(listed.entries.some((e:any)=>e.id===id)).toBe(true);
  expect((await (await fetch(base+'/domainKnowledge/'+id)).json()).value).toBe('Host saved knowledge');expect((await fetch(base+'/bad-kind')).status).toBe(400);
 }finally{await new Promise<void>(r=>server.close(()=>r()));}
});
