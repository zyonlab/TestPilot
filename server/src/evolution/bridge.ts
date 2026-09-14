import {existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createRequire} from 'node:module';
import type {DatabaseSync as SQLite} from 'node:sqlite';
import {Policy} from './store.js';
const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite') as {DatabaseSync:typeof SQLite};
export const evolutionRoot=()=>resolve(process.env.TP_EVOLUTION_DIR??(process.env.TP_DATA_DIR?join(process.env.TP_DATA_DIR,'penguin-evaluation'):join(import.meta.dirname,'../../.data/penguin-evaluation')));
export function readActiveEvolution():{version:string;generation:number;policy:{memory:'scoped'|'off'};evidence?:string}{const file=join(evolutionRoot(),'evolution.sqlite');if(!existsSync(file))return{version:'builtin-scoped-memory-v1',generation:0,policy:{memory:'scoped'},evidence:'built-in default'};
 const db=new DatabaseSync(file,{readOnly:true});try{const row=db.prepare('SELECT a.version,a.generation,v.json FROM active a JOIN versions v ON v.id=a.version WHERE a.id=1').get() as {version:string;generation:number;json:string}|undefined;if(!row)throw new Error('active_evolution_version_missing');return{version:row.version,generation:row.generation,policy:Policy.parse(JSON.parse(row.json).policy)};}finally{db.close();}}
