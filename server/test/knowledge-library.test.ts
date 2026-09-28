import {beforeAll,afterAll,it,expect,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {validateRulePack} from '@testpilot/harness-testing/domain';
const human={kind:'human' as const,id:'local-operator'};
let dir:string,project:string,other:string,lib:typeof import('../src/knowledgeLibrary.js'),database:typeof import('../src/db.js');
beforeAll(async()=>{dir=mkdtempSync(join(tmpdir(),'knowledge-library-'));vi.stubEnv('TP_DATA_DIR',dir);database=await import('../src/db.js');lib=await import('../src/knowledgeLibrary.js');project=database.createProject('example','https://app.hyperliquid-testnet.xyz/trade').id;other=database.createProject('other','http://localhost').id;});
afterAll(async()=>{(await import('../src/runService.js')).runLedger().close();database.db.close();vi.unstubAllEnvs();rmSync(dir,{recursive:true,force:true});});
it('built-in pack is valid and contains no fabricated observations or trading actions',()=>{const e=lib.listKnowledgeLibrary(project,'rulePack')[0]!;const pack=lib.readKnowledgeLibrary(project,'rulePack',e.id).value;expect(validateRulePack(pack).ok).toBe(true);expect(pack.rules.every((r:any)=>r.claimType==='hypothesis'&&r.verification.kind==='open-question')).toBe(true);expect(pack.targets.every((t:any)=>t.action==='activate'&&t.sideEffect==='ui-only')).toBe(true);});
it('save produces reusable immutable versions and isolates projects',()=>{const first=lib.saveKnowledgeLibrary(project,'domainKnowledge',{title:'custom',value:'Version one'},human);expect(lib.saveKnowledgeLibrary(project,'domainKnowledge',{value:'Version one'},human).id).toBe(first.id);const next=lib.saveKnowledgeLibrary(project,'domainKnowledge',{value:'Version two'},human);expect(next.id).not.toBe(first.id);expect(lib.readKnowledgeLibrary(project,'domainKnowledge',first.id).value).toBe('Version one');expect(()=>lib.readKnowledgeLibrary(other,'domainKnowledge',first.id)).toThrow('not_found');expect(lib.listKnowledgeLibrary(project,'domainKnowledge')).toHaveLength(3);});
it('editing a built-in makes a project copy and cannot overwrite the template',()=>{const e=lib.listKnowledgeLibrary(project,'domainKnowledge')[0]!;const before=lib.readKnowledgeLibrary(project,'domainKnowledge',e.id);const saved=lib.saveKnowledgeLibrary(project,'domainKnowledge',{value:before.value+'\nNew scope'},human);expect(saved.id).not.toBe(e.id);expect(lib.readKnowledgeLibrary(project,'domainKnowledge',e.id)).toEqual(before);});
it('rule pack saves share the existing library and invalid content is rejected',async()=>{const e=lib.listKnowledgeLibrary(project,'rulePack')[0]!;const pack=lib.readKnowledgeLibrary(project,'rulePack',e.id).value;const saved=lib.saveKnowledgeLibrary(project,'rulePack',{value:pack},human);expect((await import('../src/rulePacks.js')).readRulePack(project,saved.id).id).toBe(pack.id);expect(()=>lib.saveKnowledgeLibrary(project,'rulePack',{value:{}},human)).toThrow();expect(()=>lib.saveKnowledgeLibrary(project,'domainKnowledge',{value:''},human)).toThrow();expect(()=>lib.listKnowledgeLibrary('missing','domainKnowledge')).toThrow('project_missing');});
it('UI and host use the same save/list/read HTTP endpoints',async()=>{
 const {default:express}=await import('express');const app=express();app.use(express.json());app.use('/api/projects/:projectId/knowledge-library',lib.knowledgeLibraryRouter());const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
 const base=`http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/api/projects/${project}/knowledge-library`;
 try{
  const saved=await fetch(base+'/domainKnowledge',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:'Host authored',value:'Host saved knowledge'})});expect(saved.status).toBe(200);const {id}=await saved.json();
  const listed=await (await fetch(base+'/domainKnowledge')).json();expect(listed.entries.some((e:any)=>e.id===id)).toBe(true);
  expect((await (await fetch(base+'/domainKnowledge/'+id)).json()).value).toBe('Host saved knowledge');expect((await fetch(base+'/bad-kind')).status).toBe(400);
 }finally{await new Promise<void>(r=>server.close(()=>r()));}
});
it('built-in examples come from examples/*/example.json manifests; ids stay content hashes',async()=>{
 const {readFileSync,mkdirSync,writeFileSync}=await import('node:fs');const {contentHash}=await import('../src/runLedger.js');
 // 仓库自带的示例：id 仍是 builtin:<内容哈希>，与改造前按写死路径读出来的完全一致，旧运行的引用不失效。
 const repoPack=JSON.parse(readFileSync(new URL('../../examples/hyperliquid-testnet/rule-pack.json',import.meta.url),'utf8'));
 const repo=lib.listKnowledgeLibrary(project,'rulePack').find(e=>e.builtin)!;expect(repo.id).toBe(`builtin:${contentHash(JSON.stringify(repoPack))}`);
 const manifest=JSON.parse(readFileSync(new URL('../../examples/hyperliquid-testnet/example.json',import.meta.url),'utf8'));expect(repo.title).toBe(manifest.title.en);
 // 换一个目录：两份清单都被扫到，标题来自清单，只给知识不给规则包的示例不出现在规则包列表里。
 const root=join(dir,'examples');const text=(s:string)=>({zh:s,en:s,ja:s});
 const write=(id:string,files:Record<string,string>,extra:object)=>{mkdirSync(join(root,id),{recursive:true});for(const [f,c] of Object.entries(files))writeFileSync(join(root,id,f),c);writeFileSync(join(root,id,'example.json'),JSON.stringify({schemaVersion:'testpilot-example.v1',id,title:text(`Title ${id}`),label:text(`Label ${id}`),project:{name:id,targetUrl:`https://${id}.test/app`},...extra}));};
 write('alpha',{'k.md':'# Alpha knowledge','r.json':JSON.stringify(repoPack)},{domainKnowledge:'k.md',rulePack:'r.json'});
 write('beta',{'k.md':'# Beta knowledge'},{domainKnowledge:'k.md'});
 mkdirSync(join(root,'broken'));writeFileSync(join(root,'broken','example.json'),'{not json');
 vi.stubEnv('TP_EXAMPLES_DIR',root);
 try{
  const knowledge=lib.listKnowledgeLibrary(project,'domainKnowledge').filter(e=>e.builtin);
  expect(knowledge.map(e=>e.title)).toEqual(['Title alpha','Title beta']);expect(knowledge.map((e:any)=>e.exampleId)).toEqual(['alpha','beta']);
  expect(lib.readKnowledgeLibrary(project,'domainKnowledge',knowledge[1]!.id).value).toBe('# Beta knowledge');
  expect(lib.listKnowledgeLibrary(project,'rulePack').filter(e=>e.builtin).map(e=>e.title)).toEqual(['Title alpha']);
  const {listExamples}=await import('../src/examples.js');expect(listExamples().map(e=>[e.id,e.project.targetUrl,e.hasRulePack])).toEqual([['alpha','https://alpha.test/app',true],['beta','https://beta.test/app',false]]);
  // 没有 examples 目录：没有内置条目，也不抛。
  vi.stubEnv('TP_EXAMPLES_DIR',join(dir,'no-such-dir'));
  expect(()=>lib.listKnowledgeLibrary(project,'rulePack')).not.toThrow();expect(lib.listKnowledgeLibrary(project,'domainKnowledge').some(e=>e.builtin)).toBe(false);expect(listExamples()).toEqual([]);
 }finally{vi.stubEnv('TP_EXAMPLES_DIR','');}
});
