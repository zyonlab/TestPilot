import {afterAll,beforeAll,it,expect,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import { readOnlyLifecycle } from "./helpers/lifecycle.js";
/**
 * 2026-09-25：试点准备里 Claude Code 会话每 30–60 分钟结束一次，批次每次停在 interrupted 等人续。
 * 还有未完成用例、预算未尽时服务端自动重起宿主，最多 3 次；再退出才停下保留断点。
 */
const fake=vi.hoisted(()=>({run:vi.fn(),host:vi.fn().mockResolvedValue({sessionId:'fixture'}),cancel:vi.fn(),running:true}));
vi.mock('../src/exec.js',()=>({execOnRunner:fake.run,cancelExecution:fake.cancel}));
vi.mock('../src/runtimes.js',()=>({getRuntime:()=>({startRun:fake.host})}));
vi.mock('../src/codex.js',()=>({isRunning:()=>fake.running,cancelRun:fake.cancel}));
let dir:string,project:string,run:string;
let svc:typeof import('../src/runService.js'),db:typeof import('../src/db.js'),prep:typeof import('../src/preparation.js'),approvals:typeof import('../src/approvedRuns.js');
beforeAll(async()=>{
 dir=mkdtempSync(join(tmpdir(),'tp-prep-relaunch-'));vi.stubEnv('TP_DATA_DIR',dir);vi.stubEnv('MIDSCENE_MODEL_NAME','fixture');vi.stubEnv('MIDSCENE_MODEL_BASE_URL','https://executor.test/v1');vi.stubEnv('MIDSCENE_MODEL_API_KEY','fixture');
 db=await import('../src/db.js');svc=await import('../src/runService.js');prep=await import('../src/preparation.js');approvals=await import('../src/approvedRuns.js');const stage=await import('../src/runStages.js');
 project=db.createProject('Relaunch','http://localhost:9876').id;run=svc.registerHostRun(project,{runtime:'codex',externalId:'relaunch',idempotencyKey:'relaunch',materials:[{name:'counter.md',text:'Click increment raises counter to one. The page then shows Count: 1.'}]}).runId;
 stage.loadRunInstructions(run,project);const ref=stage.retrieveRunSpec(run,project,{query:'increment',budgetTokens:2000}).chunks[0].id;
 const stories=[{id:'s1',title:'Count',acceptance:[]}];stage.writeRunStage(run,project,'stories',{stories});stage.writeRunStage(run,project,'cases',{stories,cases:[{id:'c1',storyId:'s1',title:'Increment',designMethod:'boundary',steps:['Click Increment'],expected:'Counter is one',tier:1,readiness:{design:'candidate',execution:'blocked',reason:'Control not located'},key:'increment',sourceRefs:[ref],lifecycle:readOnlyLifecycle(ref),oracle:{kind:'text',value:'Count: 1'}}]});stage.gateRun(run,project);stage.finalizeRun(run,project);
 const c=approvals.reviewRevisions(run,project)[0];approvals.decideRevisions(run,project,{items:[{caseId:'c1',revisionId:c.revision.id,decision:'approved'}]},{kind:'human',id:'fixture'});
});
afterAll(async()=>{await new Promise(r=>setTimeout(r,3100));svc.runLedger().close();db.db.close();vi.unstubAllEnvs();rmSync(dir,{recursive:true,force:true});});

it('relaunches an exited host while cases remain, at most three times, then stops keeping the checkpoint',async()=>{
 fake.running=false;
 await prep.startPreparation(run,project,{mode:'all'});
 await vi.waitFor(()=>expect(fake.host).toHaveBeenCalledTimes(4),{timeout:20000,interval:200});
 expect(String(fake.host.mock.calls[1][0].message)).toContain('Continuation 1');
 await vi.waitFor(()=>expect(prep.preparationStatus(run,project)?.status).toBe('interrupted'),{timeout:10000,interval:200});
 expect(fake.host).toHaveBeenCalledTimes(4);
},40000);
