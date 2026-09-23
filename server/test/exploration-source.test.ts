import {beforeAll,afterAll,it,expect,vi} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {partialObservationPath,StateFlowGraphSchema} from '@testpilot/harness-testing/exec';
import {explorationExecId,type ExplorationAttempt} from '@testpilot/harness-testing/domain';
import {captureWebModels} from './helpers/model-snapshot.js';
const mocks=vi.hoisted(()=>({observe:vi.fn(),start:vi.fn(async()=>({}))}));
vi.mock('../src/procs.js',async original=>({...await original<typeof import('../src/procs.js')>(),observeProduct:mocks.observe}));
vi.mock('../src/penguinRun.js',async original=>({...await original<typeof import('../src/penguinRun.js')>(),startRun:mocks.start}));
let dir:string,project:string,service:typeof import('../src/runService.js'),db:typeof import('../src/db.js'),ops:typeof import('../src/workflowOps.js');
beforeAll(async()=>{
 dir=mkdtempSync(join(tmpdir(),'tp-source-completion-'));vi.stubEnv('TP_DATA_DIR',dir);
 db=await import('../src/db.js');service=await import('../src/runService.js');ops=await import('../src/workflowOps.js');project=db.createProject('Source tests','https://example.test/').id;
});
afterAll(()=>{service.runLedger().close();db.db.close();vi.unstubAllEnvs();rmSync(dir,{recursive:true,force:true});});
async function run(runId:string,observe:(input:{sourceAttempt:ExplorationAttempt;url:string})=>Promise<unknown>){
 mocks.observe.mockImplementationOnce(observe);
 service.registerWebRun(runId,project,captureWebModels().binding,{stageControlVersion:1,sourceKind:'explore',sourceUrl:'https://example.test/',maxScreens:8,limit:1});
 mkdirSync(join(dir,'uploads',runId),{recursive:true});
 service.runLedger().db.prepare("UPDATE wf_runs SET status='failed' WHERE id=?").run(runId);
 await ops.resumeProjectWorkflow(runId,project);
 await vi.waitFor(()=>expect(service.runLedger().nodeStates(runId).some(n=>n.node==='source'&&['done','failed'].includes(n.phase))).toBe(true));
 const revisions=service.runLedger().listRevisions(project,runId);
 return {revisions,read:(name:string)=>{const r=revisions.find(r=>r.name===name);return r?service.runLedger().readRevision(r.id,project).content as Record<string,any>:undefined;}};
}
function partial(sourceAttempt:ExplorationAttempt,over:Record<string,unknown>={}){
 const path=partialObservationPath(db.ARTIFACT_DIR,explorationExecId(sourceAttempt));mkdirSync(join(path,'..'),{recursive:true});
 writeFileSync(path,JSON.stringify({partial:true,sourceAttempt,at:new Date().toISOString(),url:sourceAttempt.entryUrl,screens:1,notes:'Captured Open control',...over}));
}
it('dispatches an identity, validates returned provenance and persists a bounded generic report',async()=>{
 const result=await run('normal',async input=>({url:input.url,sourceAttempt:input.sourceAttempt,notes:'Open',screens:1,graph:StateFlowGraphSchema.parse({states:[{id:'entry',route:'/',controls:['Open']}]}),stopped:{kind:'dry'}}));
 expect(result.read('exploration/attempt')).toMatchObject({runId:'normal',projectId:project,entryUrl:'https://example.test/'});
 expect(result.read('exploration/report')?.assessment).toMatchObject({status:'unknown',scope:{denominator:null},stop:{kind:'dry'}});
 expect(result.read('exploration/observations')?.sourceAttempt).toEqual(result.read('exploration/attempt'));
});
it('same-attempt partial is recovered as failed/unknown, with no invented graph',async()=>{
 const result=await run('partial',async input=>{partial(input.sourceAttempt);throw new Error('browser disconnected');});
 expect(result.read('report/exploration-partial')?.reason).toBe('browser disconnected');
 expect(result.read('exploration/report')?.assessment).toMatchObject({status:'unknown',progress:null,stop:{kind:'failed'}});
});
it.each(['old-attempt','other-target','no-identity'])('first failure rejects %s material and keeps the source failed',async fault=>{
 const result=await run(fault,async input=>{
  partial(input.sourceAttempt,{sourceAttempt:fault==='no-identity'?undefined:{...input.sourceAttempt,...(fault==='old-attempt'?{attemptId:'6142eab2-23c7-4d1e-a3c3-7783c25f6ca3'}:{entryUrl:'https://other.test/'})}});
  throw new Error('first capture failed');
 });
 expect(result.read('exploration/report')).toBeUndefined();expect(result.read('exploration/observations')).toBeUndefined();
 expect(service.runLedger().getRun(fault,project).status).toBe('failed');
});
it('a normal RPC response from another attempt is rejected, not relabeled',async()=>{
 const result=await run('wrong-response',async input=>({sourceAttempt:{...input.sourceAttempt,runId:'elsewhere'},url:input.url,notes:'Old material'}));
 expect(result.read('exploration/observations')).toBeUndefined();expect(service.runLedger().getRun('wrong-response',project).status).toBe('failed');
});
