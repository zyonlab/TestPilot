import {readFileSync} from 'node:fs';
import {Router} from 'express';
import {z} from 'zod';
import {db,getProject} from './db.js';
import {contentHash,LedgerError} from './runLedger.js';
import {listRulePacks,readRulePack,saveRulePack} from './rulePacks.js';

const kinds=z.enum(['domainKnowledge','rulePack']);
type Kind=z.infer<typeof kinds>;
const builtins={
  domainKnowledge:readFileSync(new URL('../../examples/hyperliquid-testnet/domain-knowledge.md',import.meta.url),'utf8'),
  rulePack:JSON.parse(readFileSync(new URL('../../examples/hyperliquid-testnet/rule-pack.json',import.meta.url),'utf8')),
};
function builtin(kind:Kind){const value=builtins[kind];return {id:`builtin:${contentHash(JSON.stringify(value))}`,title:'Hyperliquid Testnet 内置示例',builtin:true,value};}
function table(){db.exec('CREATE TABLE IF NOT EXISTS domain_knowledge (projectId TEXT NOT NULL,hash TEXT NOT NULL,title TEXT NOT NULL,text TEXT NOT NULL,createdAt TEXT NOT NULL,PRIMARY KEY(projectId,hash))');}
function project(id:string){if(!getProject(id))throw new LedgerError(404,'project_missing');}
export function listKnowledgeLibrary(projectId:string,kind:Kind){
  project(projectId);table();const {value,...example}=builtin(kind);
  const versions=kind==='rulePack'?listRulePacks(projectId).map(r=>({id:r.hash,title:`${r.packId} · ${r.version}`,builtin:false,valid:r.valid})): (db.prepare('SELECT hash,title FROM domain_knowledge WHERE projectId=? ORDER BY createdAt DESC,hash').all(projectId) as {hash:string;title:string}[]).map(r=>({id:r.hash,title:r.title,builtin:false,valid:true}));
  return [example,...versions];
}
export function readKnowledgeLibrary(projectId:string,kind:Kind,id:string):{id:string;title:string;builtin:boolean;value:any}{
  project(projectId);table();const example=builtin(kind);if(id===example.id)return structuredClone(example);
  if(kind==='rulePack')return {id,title:id,builtin:false,value:readRulePack(projectId,id)};
  const row=db.prepare('SELECT title,text FROM domain_knowledge WHERE projectId=? AND hash=?').get(projectId,id) as {title:string;text:string}|undefined;
  if(!row)throw new LedgerError(404,'domain_knowledge_not_found');return {id,title:row.title,builtin:false,value:row.text};
}
export function saveKnowledgeLibrary(projectId:string,kind:Kind,raw:unknown){
  project(projectId);table();const input=z.object({title:z.string().trim().min(1).max(120).optional(),value:z.unknown()}).parse(raw);
  if(kind==='rulePack'){const saved=saveRulePack(projectId,input.value);return {id:saved.hash};}
  const text=z.string().trim().min(1).max(60000).parse(input.value),hash=contentHash(text);
  db.prepare('INSERT OR IGNORE INTO domain_knowledge VALUES (?,?,?,?,?)').run(projectId,hash,input.title??text.split('\n')[0]!.replace(/^#+\s*/, '').slice(0,120),text,new Date().toISOString());return {id:hash};
}
export function knowledgeLibraryRouter(){const router=Router({mergeParams:true});
  router.get('/:kind',(req,res)=>{try{res.json({entries:listKnowledgeLibrary((req.params as any).projectId,kinds.parse(req.params.kind))});}catch(e){res.status(e instanceof LedgerError?e.status:400).json({error:(e as Error).message});}});
  router.get('/:kind/:id',(req,res)=>{try{res.json(readKnowledgeLibrary((req.params as any).projectId,kinds.parse(req.params.kind),req.params.id));}catch(e){res.status(e instanceof LedgerError?e.status:400).json({error:(e as Error).message});}});
  router.post('/:kind',(req,res)=>{try{res.json(saveKnowledgeLibrary((req.params as any).projectId,kinds.parse(req.params.kind),req.body));}catch(e){res.status(e instanceof LedgerError?e.status:400).json({error:(e as Error).message});}});return router;
}
