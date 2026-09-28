import {afterAll,beforeAll,it,expect,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import { readOnlyLifecycle } from "./helpers/lifecycle.js";
/** 2026-09-25：宿主撞用量额度时，等到重置时刻再续，不在额度恢复前把 3 次续起用完。 */
const fake=vi.hoisted(()=>({run:vi.fn(),host:vi.fn().mockResolvedValue({sessionId:'fixture'}),cancel:vi.fn(),resetAt:vi.fn()}));
vi.mock('../src/exec.js',()=>({execOnRunner:fake.run,cancelExecution:fake.cancel}));
vi.mock('../src/runtimes.js',()=>({getRuntime:()=>({startRun:fake.host})}));
vi.mock('../src/claudecode.js',()=>({isRunning:()=>false,cancelRun:fake.cancel,hostRateLimitResetAt:fake.resetAt}));
let dir:string,project:string,run:string;
let svc:typeof import('../src/runService.js'),db:typeof import('../src/db.js'),prep:typeof import('../src/preparation.js');
beforeAll(async()=>{
 dir=mkdtempSync(join(tmpdir(),'tp-prep-ratelimit-'));vi.stubEnv('TP_DATA_DIR',dir);vi.stubEnv('MIDSCENE_MODEL_NAME','fixture');vi.stubEnv('MIDSCENE_MODEL_BASE_URL','https://executor.test/v1');vi.stubEnv('MIDSCENE_MODEL_API_KEY','fixture');
 db=await import('../src/db.js');svc=await import('../src/runService.js');prep=await import('../src/preparation.js');const approvals=await import('../src/approvedRuns.js');const stage=await import('../src/runStages.js');
 project=db.createProject('RateLimit','http://localhost:9876').id;run=svc.registerHostRun(project,{runtime:'claude-code',externalId:'ratelimit',idempotencyKey:'ratelimit',materials:[{name:'counter.md',text:'Click increment raises counter to one.'}]}).runId;
 stage.loadRunInstructions(run,project);const ref=stage.retrieveRunSpec(run,project,{query:'increment',budgetTokens:2000}).chunks[0].id;
 const stories=[{id:'s1',title:'Count',acceptance:[]}];stage.writeRunStage(run,project,'stories',{stories});stage.writeRunStage(run,project,'cases',{stories,cases:[{id:'c1',storyId:'s1',title:'Increment',designMethod:'boundary',steps:['Click Increment'],expected:'Counter is one',tier:1,readiness:{design:'candidate',execution:'blocked',reason:'Control not located'},key:'increment',sourceRefs:[ref],lifecycle:readOnlyLifecycle(ref),oracle:{kind:'text',value:'Count: 1'}}]});stage.gateRun(run,project);stage.finalizeRun(run,project);
 const c=approvals.reviewRevisions(run,project)[0];approvals.decideRevisions(run,project,{items:[{caseId:'c1',revisionId:c.revision.id,decision:'approved'}]},{kind:'human',id:'fixture'});
});
afterAll(async()=>{await new Promise(r=>setTimeout(r,3100));svc.runLedger().close();db.db.close();vi.unstubAllEnvs();rmSync(dir,{recursive:true,force:true});});

it('waits for the usage-limit reset instead of burning relaunches, then continues',async()=>{
 // 第一次退出时额度被拒、约 4 秒后（加 60 秒宽限前移）恢复；之后不再撞额度。
 fake.resetAt.mockReturnValueOnce(Date.now()-56_000).mockReturnValue(undefined);
 await prep.startPreparation(run,project,{mode:'all'});
 await vi.waitFor(()=>expect(fake.host).toHaveBeenCalledTimes(1),{timeout:5000,interval:100});
 await new Promise(r=>setTimeout(r,3500));
 expect(fake.host).toHaveBeenCalledTimes(1);
 await vi.waitFor(()=>expect(fake.host).toHaveBeenCalledTimes(2),{timeout:10000,interval:200});
 expect(prep.preparationStatus(run,project)?.status).toBe('running');
 await prep.cancelPreparation(run,project);
},30000);
