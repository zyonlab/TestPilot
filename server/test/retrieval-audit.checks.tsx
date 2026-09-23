import {it,expect,vi,beforeAll,afterAll} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import express from 'express';
import type {Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {translate} from '../../src/lib/i18n';
let lang:'zh'|'en'|'ja'='en';
vi.mock('../../src/lib/prefs',()=>({useT:()=>((key:string,args?:Record<string,any>)=>translate(key,lang,args))}));
import {RevisionContent} from '../../src/components/workbench/RevisionViewer';
import {RetrievalAudit,retrievalArtifacts} from '../../src/components/workbench/RetrievalAudit';
import {NodeDetail} from '../../src/components/workbench/NodeDetail';
import {artifactLabel} from '../../src/components/workbench/artifactLabel';
import {workflowBase,type WorkflowRun} from '../../src/lib/workflowRuns';
let dir:string,url:string,project:string,server:Server,svc:typeof import('../src/runService.js'),db:typeof import('../src/db.js');
beforeAll(async()=>{
 dir=mkdtempSync(join(tmpdir(),'tp-retrieval-ui-'));vi.stubEnv('TP_DATA_DIR',dir);vi.stubEnv('MIDSCENE_MODEL_NAME','fixture');vi.stubEnv('MIDSCENE_MODEL_BASE_URL','https://fixture.test/v1');vi.stubEnv('MIDSCENE_MODEL_API_KEY','fixture');
 svc=await import('../src/runService.js');db=await import('../src/db.js');project=db.createProject('Reading','http://127.0.0.1').id;
 const {runRouter}=await import('../src/runRoutes.js');const app=express();app.use(express.json());app.use('/api/projects/:projectId/workflow-runs',runRouter());server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));url=`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/${workflowBase(project)}`;
});
afterAll(async()=>{await new Promise<void>(r=>server.close(()=>r()));svc.runLedger().close();db.db.close();vi.unstubAllEnvs();vi.unstubAllGlobals();rmSync(dir,{recursive:true,force:true});});
for(const l of ['zh','en','ja'] as const)it(`actual stage → run list → entry filter → artifact HTTP read → reader (${l})`,async()=>{
 lang=l;
 const registered=svc.registerHostRun(project,{runtime:'codex',externalId:l,idempotencyKey:l,materials:[{name:'spec.md',text:'# Login\nUse password.\n# Oversized\n'+'big '.repeat(600)}]});
 const post=(stage:string,body:unknown)=>fetch(`${url}/${registered.runId}/stages/${stage}`,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+registered.writeToken},body:JSON.stringify(body)});
 expect((await post('instructions',{})).status).toBe(200);
 const response=await post('retrieve',{query:'Login',budgetTokens:200,chunkIds:['materials/spec.md#1','materials/spec.md#2','unknown'],node:'invented-node'});expect(response.status).toBe(200);const delivered=await response.json();
 const run=await (await fetch(`${url}/${registered.runId}`)).json() as WorkflowRun;
 const refs=retrievalArtifacts(run.revisions);expect(refs.map(r=>r.id)).toEqual([delivered.audit.revisionId]);
 vi.stubGlobal('window',{innerWidth:1200});
 const nodeHtml=renderToStaticMarkup(<NodeDetail run={run} node="cases" projectId={project} onRunDetails={()=>{}} refresh={()=>{}}/>);
 vi.unstubAllGlobals();
 expect(nodeHtml).toContain(translate('retrieval.runHistory',l));
 expect(nodeHtml).not.toContain('Use password.'); // history is collapsed; content loaded only on selection
 expect(artifactLabel(refs[0].name,k=>translate(k,l))).toContain(translate('retrieval.title',l));
 const read=await fetch(`${url}/${registered.runId}/artifacts/${refs[0].id}`);expect(read.status).toBe(200);const artifact=await read.json();
 const html=renderToStaticMarkup(<RevisionContent kind={artifact.revision.kind} content={artifact.content}/>);
 for(const key of ['title','estimate','budgetOmittedIds','unknownRequiredIds','unassessed','boundary','source.unknown'])expect(html).toContain(translate('retrieval.'+key,l));
 expect(html).toContain('Use password.');expect(html).toContain(delivered.audit.deliveryDigest);expect(html).toContain('invented-node');
});
for(const value of [null,{}, {schemaVersion:'retrieval-audit.v1'}, {schemaVersion:'retrieval-audit.v1',delivery:{chunks:null}}, {chunkIds:['old#1']}])it('treats malformed and legacy audits as unknown instead of zero',()=>{
 lang='en';expect(renderToStaticMarkup(<RetrievalAudit value={value}/>)).toContain(translate('retrieval.unknown','en'));
});
