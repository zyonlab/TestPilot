import {beforeAll,afterAll,it,expect,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Server} from 'node:http';
import {captureWebModels} from './helpers/model-snapshot.js';
let dir:string,project:string,other:string,source:string,base:string,server:Server,database:typeof import('../src/db.js'),service:typeof import('../src/runService.js');
beforeAll(async()=>{
 dir=mkdtempSync(join(tmpdir(),'tp-project-assets-http-'));vi.stubEnv('TP_DATA_DIR',dir);database=await import('../src/db.js');service=await import('../src/runService.js');
 project=database.createProject('Assets fixture','http://localhost').id;other=database.createProject('Other fixture','http://localhost').id;
 const run=service.runLedger().register({projectId:project,externalId:'fixture',idempotencyKey:'fixture',binding:{schemaVersion:1,models:captureWebModels().binding,skillVersion:'test',loadedDigest:'a'.repeat(64),materialsHash:null,inputHash:null,environmentHash:null,materialRevisions:[]}}, {kind:'agent',id:'fixture'}).runId;
 source=service.runLedger().putRevision({projectId:project,runId:run,name:'rules',kind:'material',content:{rule:'Test'}},{kind:'agent',id:'fixture'}).id;
 const {default:express}=await import('express');const {projectAssetRouter}=await import('../src/projectAssetRoutes.js');const app=express();app.use(express.json());app.use('/api/projects/:projectId/assets',projectAssetRouter());server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));base=`http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/api/projects/${project}/assets`;
});
afterAll(async()=>{await new Promise<void>(r=>server.close(()=>r()));service.runLedger().close();database.db.close();vi.unstubAllEnvs();rmSync(dir,{recursive:true,force:true});});
const post=(path:string,body:unknown,headers:Record<string,string>={})=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
it('operator imports, reviews, adopts and snapshots through public HTTP routes',async()=>{
 const response=await post('/candidates',{assetKey:'rules',sourceRevision:source,baseVersion:null});expect(response.status).toBe(200);const candidate=await response.json();
 expect((await (await fetch(base+'/versions/'+candidate.id)).json()).content).toEqual({rule:'Test'});
 expect((await post('/versions/'+candidate.id+'/decision',{action:'adopt',expectedHead:null,reason:'reviewed'},{authorization:'Bearer agent'})).status).toBe(403);
 expect((await post('/versions/'+candidate.id+'/decision',{action:'adopt',expectedHead:null,reason:'reviewed'})).status).toBe(200);
 const snapshot=await (await post('/snapshots',{label:'Pinned fixture'})).json();expect(snapshot.heads.rules).toBe(candidate.id);
 expect((await (await fetch(base+'/snapshots/'+snapshot.id)).json()).digest).toBe(snapshot.digest);
 expect((await (await fetch(base)).json()).versions[0].status).toBe('adopted');
 expect((await fetch(base.replace(project,other)+'/versions/'+candidate.id)).status).toBe(409);
});
it('rejects missing projects, forged foreign sources and malformed requests',async()=>{
 expect((await fetch(base.replace(project,'missing'))).status).toBe(404);
 const foreign=await fetch(base.replace(project,other)+'/candidates',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({assetKey:'rules',sourceRevision:source,baseVersion:null})});expect(foreign.status).toBe(409);
 expect((await post('/snapshots',{})).status).toBe(400);
});
