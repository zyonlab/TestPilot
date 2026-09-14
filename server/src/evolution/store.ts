import { createRequire } from 'node:module';
import type { DatabaseSync as SQLite } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite') as {DatabaseSync:typeof SQLite};
export const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export const Policy=z.object({memory:z.enum(['scoped','off'])}).strict();
export type PolicyValue=z.infer<typeof Policy>;
export type Binding={inputHash:string;datasetHash:string;rubricHash:string;runtime:string;model:string;replicates:number};
export type Score={policyHash:string;score:number;p0Failures:number;unobservable:number;n:number;binding:Binding;source:string};
export type Candidate={id:string;baseVersion:string;policy:PolicyValue;policyHash:string;status:string;createdAt:string;spec:Record<string,unknown>;baseline?:Score;candidate?:Score;heldout?:{baseline:Score;candidate:Score};hostRegression?:{passed:boolean;policyHash:string;source:string};reason?:string;error?:string};
function comparable(a:Score,b:Score){return a.n>0&&a.n===b.n&&a.n===a.binding.replicates&&b.n===b.binding.replicates&&['inputHash','datasetHash','rubricHash','runtime','model','replicates'].every(k=>!!a.binding[k as keyof Binding]&&a.binding[k as keyof Binding]===b.binding[k as keyof Binding]);}
function validScore(s:Score){if(!Number.isFinite(s.score)||s.score<0||s.score>1||!Number.isInteger(s.n)||s.n<1||!Number.isInteger(s.p0Failures)||s.p0Failures<0||s.p0Failures>s.n||!Number.isInteger(s.unobservable)||s.unobservable<0||s.unobservable>s.n||!s.source)throw new Error('invalid_tool_score');}
export class EvolutionStore{
 readonly db:SQLite;
 constructor(readonly root:string){mkdirSync(root,{recursive:true,mode:0o700});this.db=new DatabaseSync(join(root,'evolution.sqlite'));this.db.exec(`PRAGMA journal_mode=WAL;PRAGMA busy_timeout=5000;PRAGMA synchronous=FULL;
 CREATE TABLE IF NOT EXISTS versions(id TEXT PRIMARY KEY,json TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS active(id INTEGER PRIMARY KEY CHECK(id=1),version TEXT NOT NULL,generation INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS candidates(id TEXT PRIMARY KEY,json TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY,at TEXT NOT NULL,json TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS heldout_attempts(candidateId TEXT PRIMARY KEY,startedAt TEXT NOT NULL,status TEXT NOT NULL);
 `);this.db.prepare('INSERT OR IGNORE INTO versions VALUES (?,?)').run('builtin-scoped-memory-v1',JSON.stringify({id:'builtin-scoped-memory-v1',policy:{memory:'scoped'},createdAt:new Date().toISOString(),source:'built-in policy; not an experimentally improved version'}));this.db.prepare('INSERT OR IGNORE INTO active VALUES (1,?,0)').run('builtin-scoped-memory-v1');
 // A terminated evaluator is visible as interrupted and cannot silently resume a held-out attempt.
 }
 close(){this.db.close();}
 transaction<T>(fn:()=>T):T{this.db.exec('BEGIN IMMEDIATE');try{const v=fn();this.db.exec('COMMIT');return v;}catch(e){this.db.exec('ROLLBACK');throw e;}}
 active(){const a=this.db.prepare('SELECT version,generation FROM active WHERE id=1').get() as {version:string;generation:number};return {...a,...JSON.parse((this.db.prepare('SELECT json FROM versions WHERE id=?').get(a.version) as {json:string}).json)};}
 candidates(){return(this.db.prepare('SELECT json FROM candidates ORDER BY rowid DESC').all() as {json:string}[]).map(r=>JSON.parse(r.json) as Candidate);}
 candidate(id:string){const r=this.db.prepare('SELECT json FROM candidates WHERE id=?').get(id) as {json:string}|undefined;if(!r)throw new Error('candidate_missing');return JSON.parse(r.json) as Candidate;}
 save(c:Candidate){this.db.prepare('INSERT INTO candidates VALUES (?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(c.id,JSON.stringify(c));return c;}
 audit(event:Record<string,unknown>){this.db.prepare('INSERT INTO audit VALUES (?,?,?)').run(randomUUID(),new Date().toISOString(),JSON.stringify(event));}
 history(){return(this.db.prepare('SELECT at,json FROM audit ORDER BY rowid').all() as {at:string;json:string}[]).map(r=>({at:r.at,...JSON.parse(r.json)}));}
 create(spec:Record<string,unknown>){const a=this.active();const c:Candidate={id:`candidate-${randomUUID()}`,baseVersion:a.version,policy:Policy.parse(a.policy),policyHash:digest(a.policy),status:'evaluating',createdAt:new Date().toISOString(),spec};this.save(c);this.audit({action:'experiment-created',candidateId:c.id});return c;}
 proposal(id:string,raw:unknown){const c=this.candidate(id);if(c.status!=='evaluating')throw new Error('candidate_not_evaluating');c.policy=Policy.parse(raw);c.policyHash=digest(c.policy);return this.save(c);}
 recordDevelopment(id:string,baseline:Score,candidate:Score){validScore(baseline);validScore(candidate);const c=this.candidate(id);if(c.status!=='evaluating')throw new Error('candidate_not_evaluating');c.baseline=baseline;c.candidate=candidate;
 c.reason=baseline.policyHash!==digest(JSON.parse((this.db.prepare('SELECT json FROM versions WHERE id=?').get(c.baseVersion) as {json:string}).json).policy)||candidate.policyHash!==c.policyHash?'policy_binding_conflict':!comparable(baseline,candidate)?'incomparable_binding':candidate.p0Failures>baseline.p0Failures?'p0_regression':candidate.unobservable>baseline.unobservable?'observation_regression':candidate.score<=baseline.score?'no_strict_improvement':'development_improvement_requires_human_review';
 c.status=c.reason==='development_improvement_requires_human_review'?'awaiting_review':'rejected';this.save(c);this.audit({action:'development-scored',candidateId:id,status:c.status,reason:c.reason});return c;}
 fail(id:string,error:string){const c=this.candidate(id);if(c.status!=='evaluating')return c;c.status='failed';c.error=error;this.save(c);this.audit({action:'experiment-failed',candidateId:id,error});return c;}
 recover(){for(const c of this.candidates())if(c.status==='evaluating')this.fail(c.id,'interrupted_restart');}
 beginHeldout(id:string){return this.transaction(()=>{const c=this.candidate(id);if(c.status!=='awaiting_review')throw new Error('candidate_not_eligible');if(this.db.prepare('SELECT 1 FROM heldout_attempts WHERE candidateId=?').get(id))throw new Error('heldout_attempt_limit');this.db.prepare('INSERT INTO heldout_attempts VALUES (?,?,?)').run(id,new Date().toISOString(),'running');this.audit({action:'heldout-started',candidateId:id});});}
 recordHeldout(id:string,baseline:Score,candidate:Score){validScore(baseline);validScore(candidate);const c=this.candidate(id);const attempt=this.db.prepare('SELECT status FROM heldout_attempts WHERE candidateId=?').get(id) as {status:string}|undefined;if(attempt?.status!=='running')throw new Error('heldout_attempt_required');c.heldout={baseline,candidate};this.save(c);this.db.prepare("UPDATE heldout_attempts SET status='finished' WHERE candidateId=?").run(id);this.audit({action:'heldout-finished',candidateId:id});}
 recordHostRegression(id:string,passed:boolean,policyHash:string,source:string){const c=this.candidate(id);if(policyHash!==c.policyHash||!source)throw new Error('host_regression_binding_conflict');c.hostRegression={passed,policyHash,source};this.save(c);}
 promotionReasons(c:Candidate){const reasons:string[]=[];if(c.status!=='awaiting_review')reasons.push('candidate_not_eligible');if(!c.baseline||!c.candidate||!comparable(c.baseline,c.candidate))reasons.push('development_binding_missing');if(!c.heldout)reasons.push('heldout_required');else{const {baseline:a,candidate:b}=c.heldout;if(!comparable(a,b)||a.policyHash!==c.baseline?.policyHash||b.policyHash!==c.policyHash)reasons.push('heldout_binding_conflict');if(b.score<a.score||b.p0Failures>a.p0Failures||b.unobservable>a.unobservable)reasons.push('heldout_regression');}
 if(!c.hostRegression?.passed||c.hostRegression.policyHash!==c.policyHash)reasons.push('host_regression_required');return reasons;}
 promote(id:string,generation:number,reviewer:string){return this.transaction(()=>{const c=this.candidate(id),a=this.active();if(!reviewer)throw new Error('human_reviewer_required');if(a.generation!==generation||a.version!==c.baseVersion)throw new Error('active_version_conflict');const reasons=this.promotionReasons(c);if(reasons.length)throw new Error(reasons.join(','));const version=`policy-${c.policyHash.slice(0,16)}`;
 this.db.prepare('INSERT OR IGNORE INTO versions VALUES (?,?)').run(version,JSON.stringify({id:version,policy:c.policy,parentVersion:a.version,candidateId:c.id,createdAt:new Date().toISOString()}));this.db.prepare('UPDATE active SET version=?,generation=generation+1 WHERE id=1 AND generation=?').run(version,generation);c.status='promoted';this.save(c);this.audit({action:'promote',candidateId:id,version,previousVersion:a.version,reviewer,generation:generation+1});return this.active();});}
 reject(id:string,reviewer:string){const c=this.candidate(id);if(c.status!=='awaiting_review')throw new Error('candidate_not_eligible');c.status='rejected';c.reason='human_rejected';this.save(c);this.audit({action:'reject',candidateId:id,reviewer});return c;}
 rollback(version:string,generation:number,reviewer:string){return this.transaction(()=>{if(!reviewer)throw new Error('human_reviewer_required');const a=this.active();if(a.generation!==generation)throw new Error('active_version_conflict');if(!this.db.prepare('SELECT 1 FROM versions WHERE id=?').get(version))throw new Error('version_missing');this.db.prepare('UPDATE active SET version=?,generation=generation+1 WHERE id=1').run(version);this.audit({action:'rollback',version,previousVersion:a.version,reviewer,generation:generation+1});return this.active();});}
}
