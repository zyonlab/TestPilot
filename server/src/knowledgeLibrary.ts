import {Router} from 'express';
import {z} from 'zod';
import {db,getProject} from './db.js';
import {contentHash,LedgerError} from './runLedger.js';
import {listRulePacks,readRulePack,saveRulePack} from './rulePacks.js';
import {loadExamples} from './examples.js';
import {reviewerPrincipal} from './reviewPrincipal.js';
import type {Principal} from '@testpilot/harness-core/run-contracts';

const kinds=z.enum(['domainKnowledge','rulePack']);
type Kind=z.infer<typeof kinds>;
/** 每个内置示例提供一条 builtin 条目；id 只由内容算（`builtin:<hash>`），已有运行里记下的引用不会因为换目录或改标题失效。 */
function builtins(kind:Kind){
  return loadExamples().flatMap(({manifest,...files})=>{const value=files[kind];if(value===undefined)return [];
    return [{id:`builtin:${contentHash(JSON.stringify(value))}`,title:manifest.title.en,titles:manifest.title,exampleId:manifest.id,builtin:true as const,value}];});
}
function table(){db.exec('CREATE TABLE IF NOT EXISTS domain_knowledge (projectId TEXT NOT NULL,hash TEXT NOT NULL,title TEXT NOT NULL,text TEXT NOT NULL,createdAt TEXT NOT NULL,PRIMARY KEY(projectId,hash))');}
function project(id:string){if(!getProject(id))throw new LedgerError(404,'project_missing');}
export function listKnowledgeLibrary(projectId:string,kind:Kind){
  project(projectId);table();const examples=builtins(kind).map(({value,...entry})=>entry);
  const versions=kind==='rulePack'?listRulePacks(projectId).map(r=>({id:r.hash,title:`${r.packId} · ${r.version}`,builtin:false,valid:r.valid})): (db.prepare('SELECT hash,title FROM domain_knowledge WHERE projectId=? ORDER BY createdAt DESC,hash').all(projectId) as {hash:string;title:string}[]).map(r=>({id:r.hash,title:r.title,builtin:false,valid:true}));
  return [...examples,...versions];
}
export function readKnowledgeLibrary(projectId:string,kind:Kind,id:string):{id:string;title:string;builtin:boolean;value:any}{
  project(projectId);table();const example=builtins(kind).find(e=>e.id===id);if(example)return structuredClone(example);
  if(kind==='rulePack')return {id,title:id,builtin:false,value:readRulePack(projectId,id)};
  const row=db.prepare('SELECT title,text FROM domain_knowledge WHERE projectId=? AND hash=?').get(projectId,id) as {title:string;text:string}|undefined;
  if(!row)throw new LedgerError(404,'domain_knowledge_not_found');return {id,title:row.title,builtin:false,value:row.text};
}
function auditTable(){db.exec('CREATE TABLE IF NOT EXISTS knowledge_library_audit (id INTEGER PRIMARY KEY,projectId TEXT NOT NULL,kind TEXT NOT NULL,entryId TEXT NOT NULL,actorKind TEXT NOT NULL,actorId TEXT NOT NULL,created INTEGER NOT NULL,at TEXT NOT NULL)');}
/**
 * 知识库是项目数据，只有人能存新版（规划器的宿主工具不注册这个动作，服务端也按 reviewerPrincipal 拦）。
 * 每次保存留一条审计：谁、何时、哪一版、是不是新版本。
 */
export function saveKnowledgeLibrary(projectId:string,kind:Kind,raw:unknown,actor:Principal){
  if(actor.kind!=='human')throw new LedgerError(403,'operator_action_required');
  project(projectId);table();auditTable();const input=z.object({title:z.string().trim().min(1).max(120).optional(),value:z.unknown()}).parse(raw);
  return db.transaction(()=>{
    let id:string,created:boolean;
    if(kind==='rulePack'){const saved=saveRulePack(projectId,input.value,actor);id=saved.hash;created=saved.created;}
    else{const text=z.string().trim().min(1).max(60000).parse(input.value);id=contentHash(text);
      created=db.prepare('INSERT OR IGNORE INTO domain_knowledge VALUES (?,?,?,?,?)').run(projectId,id,input.title??text.split('\n')[0]!.replace(/^#+\s*/, '').slice(0,120),text,new Date().toISOString()).changes>0;}
    db.prepare('INSERT INTO knowledge_library_audit (projectId,kind,entryId,actorKind,actorId,created,at) VALUES (?,?,?,?,?,?,?)').run(projectId,kind,id,actor.kind,actor.id,created?1:0,new Date().toISOString());
    return {id};
  })();
}
export function knowledgeLibraryAudit(projectId:string,kind?:Kind){project(projectId);auditTable();
  return (db.prepare(`SELECT kind,entryId,actorKind,actorId,created,at FROM knowledge_library_audit WHERE projectId=?${kind?' AND kind=?':''} ORDER BY id`).all(...(kind?[projectId,kind]:[projectId])) as Array<{kind:Kind;entryId:string;actorKind:string;actorId:string;created:number;at:string}>)
    .map(r=>({kind:r.kind,id:r.entryId,actor:{kind:r.actorKind,id:r.actorId},created:r.created===1,at:r.at}));}
export function knowledgeLibraryRouter(){const router=Router({mergeParams:true});
  router.get('/:kind',(req,res)=>{try{res.json({entries:listKnowledgeLibrary((req.params as any).projectId,kinds.parse(req.params.kind))});}catch(e){res.status(e instanceof LedgerError?e.status:400).json({error:(e as Error).message});}});
  router.get('/:kind/:id',(req,res)=>{try{res.json(readKnowledgeLibrary((req.params as any).projectId,kinds.parse(req.params.kind),req.params.id));}catch(e){res.status(e instanceof LedgerError?e.status:400).json({error:(e as Error).message});}});
  router.post('/:kind',(req,res)=>{try{res.json(saveKnowledgeLibrary((req.params as any).projectId,kinds.parse(req.params.kind),req.body,reviewerPrincipal(req)));}catch(e){res.status(e instanceof LedgerError?e.status:400).json({error:(e as Error).message});}});return router;
}
