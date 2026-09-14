/** SQLite is authoritative; YAML is a reproducible atomic compatibility projection. */
import type {DatabaseSync as SQLiteDatabase} from 'node:sqlite';
import {createRequire} from 'node:module';
const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
import {existsSync,readFileSync,writeFileSync,renameSync,unlinkSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import type {ScoreboardEntry} from './contracts.js';
function parse(file:string){const raw=readFileSync(file,'utf8'),match=/entries:\s*(\[[\s\S]*\])\s*$/.exec(raw);const entries=match?JSON.parse(match[1]):[];if(!Array.isArray(entries))throw new Error('scoreboard_entries_invalid');return{head:match?raw.slice(0,match.index):raw.replace(/\s*$/,'\n'),entries:entries as ScoreboardEntry[]};}
function open(file:string){const db=new DatabaseSync(file+'.sqlite');db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS scores(runId TEXT NOT NULL,goldHash TEXT NOT NULL,paired INTEGER NOT NULL,json TEXT NOT NULL,PRIMARY KEY(runId,goldHash,paired));');return db;}
function initialize(db:SQLiteDatabase,file:string){if(db.prepare("SELECT value FROM metadata WHERE key='head'").get())return;const {head,entries}=parse(file);db.prepare('INSERT INTO metadata VALUES (?,?)').run('head',head);const stmt=db.prepare('INSERT OR REPLACE INTO scores VALUES (?,?,?,?)');for(const e of entries)stmt.run(e.runId,e.goldHash,e.vsPrev?1:0,JSON.stringify(e));}
function snapshot(db:SQLiteDatabase){return(db.prepare('SELECT json FROM scores ORDER BY rowid').all() as {json:string}[]).map(r=>JSON.parse(r.json)as ScoreboardEntry);}
function project(db:SQLiteDatabase,file:string){const head=(db.prepare("SELECT value FROM metadata WHERE key='head'").get()as {value:string}).value;const tmp=file+'.'+randomUUID()+'.tmp';try{writeFileSync(tmp,head+'entries: '+JSON.stringify(snapshot(db),null,2)+'\n',{flag:'wx'});renameSync(tmp,file);}finally{if(existsSync(tmp))unlinkSync(tmp);}}
export function storedScoreboard(file:string):ScoreboardEntry[]{if(!existsSync(file+'.sqlite'))return parse(file).entries;const db=open(file);try{db.exec('BEGIN IMMEDIATE');initialize(db,file);project(db,file);const rows=snapshot(db);db.exec('COMMIT');return rows;}catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}finally{db.close();}}
export function storeScoreboardEntry(file:string,entry:ScoreboardEntry){const db=open(file);try{
 db.exec('BEGIN IMMEDIATE');initialize(db,file);db.prepare('INSERT INTO scores VALUES (?,?,?,?) ON CONFLICT(runId,goldHash,paired) DO UPDATE SET json=excluded.json').run(entry.runId,entry.goldHash,entry.vsPrev?1:0,JSON.stringify(entry));db.exec('COMMIT');
 // A crash after commit leaves a stale but complete projection. Every authoritative read rebuilds it.
 db.exec('BEGIN IMMEDIATE');project(db,file);db.exec('COMMIT');
 }catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}finally{db.close();}}
