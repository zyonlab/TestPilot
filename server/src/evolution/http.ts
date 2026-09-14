import express from 'express';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {readFileSync,existsSync,realpathSync,readdirSync,statSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {EvolutionStore,type Score} from './store.js';
import {EvolutionRunner} from './runner.js';
export interface TrustedGates {
 // Deployment-owned adapters, never uploaded scores or candidate-supplied paths.
 heldout?: (candidateId:string)=>Promise<{baseline:Score;candidate:Score}>;
 hostRegression?: (candidateId:string)=>Promise<{passed:boolean;policyHash:string;source:string}>;
}
export function evaluationApp(store:EvolutionStore,runner:Pick<EvolutionRunner,'start'>,reviewToken:string,repoRoot:string,gates:TrustedGates={}){
 const app=express(),sessions=new Map<string,number>();app.disable('x-powered-by');app.use(express.json({limit:'64kb'}));
 const equal=(a:unknown,b:string)=>typeof a==='string'&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
 app.use((req,res,next)=>{res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');if(req.method!=='GET'&&req.headers.origin&&req.headers.origin!==`${req.protocol}://${req.headers.host}`)return res.status(403).json({error:'origin_denied'});next();});
 app.get('/health',(_req,res)=>res.json({service:'testpilot-penguin-evaluation',schemaVersion:1,instance:process.env.TP_EVOLUTION_INSTANCE??null}));
 app.get('/',(_req,res)=>res.type('html').send(readFileSync(join(repoRoot,'extensions/penguin-evaluation/ui.html'),'utf8')));
 app.post('/api/session',(req,res)=>{if(!equal(req.body.token,reviewToken))return res.status(401).json({error:'reviewer_auth_required'});for(const[k,t]of sessions)if(t<Date.now())sessions.delete(k);if(sessions.size>=100)return res.status(429).json({error:'session_limit'});const id=randomBytes(24).toString('hex');sessions.set(id,Date.now()+8*3600000);res.setHeader('Set-Cookie',`tp_evolution_review=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`);res.json({authenticated:true});});
 const actor=(req:express.Request)=>{const cookie=String(req.headers.cookie??'').split(';').map(s=>s.trim()).find(s=>s.startsWith('tp_evolution_review='))?.split('=')[1];if(!cookie||(sessions.get(cookie)??0)<=Date.now())throw new Error('human_reviewer_required');return `local-reviewer-${cookie.slice(0,8)}`;};
 const wrap=(fn:(req:express.Request,res:express.Response)=>unknown)=>(req:express.Request,res:express.Response)=>{Promise.resolve().then(()=>fn(req,res)).catch(e=>res.status(String(e.message).includes('reviewer')?401:409).json({error:String(e.message).slice(0,300)}));};
 app.get('/api/state',(_req,res)=>res.json({active:store.active(),candidates:store.candidates().map(c=>({...c,promotionBlocks:store.promotionReasons(c)})),history:store.history(),boundary:'Penguin companion UI; TestPilot remains read-only',environmentLabel:process.env.TP_EVOLUTION_ENVIRONMENT_LABEL??'',gates:{heldout:!!gates.heldout,hostRegression:!!gates.hostRegression}}));
 app.post('/api/experiments',wrap((req,res)=>{actor(req);res.status(202).json(runner.start());}));
 app.post('/api/candidates/:id/heldout',wrap(async(req,res)=>{actor(req);if(!gates.heldout)throw new Error('human_frozen_heldout_adapter_required');store.beginHeldout(req.params.id);const result=await gates.heldout(req.params.id);store.recordHeldout(req.params.id,result.baseline,result.candidate);res.json(store.candidate(req.params.id));}));
 app.post('/api/candidates/:id/host-regression',wrap(async(req,res)=>{actor(req);if(!gates.hostRegression)throw new Error('candidate_host_regression_adapter_required');const r=await gates.hostRegression(req.params.id);store.recordHostRegression(req.params.id,r.passed,r.policyHash,r.source);res.json(store.candidate(req.params.id));}));
 app.post('/api/candidates/:id/promote',wrap((req,res)=>res.json(store.promote(req.params.id,req.body.expectedGeneration,actor(req)))));
 app.post('/api/candidates/:id/reject',wrap((req,res)=>res.json(store.reject(req.params.id,actor(req)))));
 app.post('/api/rollback',wrap((req,res)=>res.json(store.rollback(String(req.body.version),req.body.expectedGeneration,actor(req)))));
 app.get('/api/candidates/:id/evidence',wrap((req,res)=>{const c=store.candidate(req.params.id),dir=join(store.root,'evidence',c.id);res.json({files:existsSync(dir)?readdirSync(dir).filter(f=>/^[\w.-]+\.json(l)?$/.test(f)&&statSync(join(dir,f)).isFile()):[]});}));
 app.get('/api/candidates/:id/evidence/:file',wrap((req,res)=>{const c=store.candidate(req.params.id);if(!/^[\w.-]+\.json(l)?$/.test(req.params.file))throw new Error('evidence_file_denied');const dir=realpathSync(join(store.root,'evidence',c.id)),file=realpathSync(resolve(dir,req.params.file));if(!file.startsWith(dir+sep))throw new Error('evidence_file_denied');res.type('text/plain').send(readFileSync(file,'utf8'));}));
 return app;
}
