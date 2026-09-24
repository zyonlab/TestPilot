import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
/**
 * 领域参考是用户写的项目数据，不是生成的历史资产（docs/reports/workflow-review-2026-09-24.md §2.5）。
 * 新建表单全走运行计划之后，clean / incremental / rebuild 运行都要冻结绑定项目当前那一版，
 * 并且计划的配置指纹要含它：计划之后改了领域参考，启动时要求重新规划。
 */
const startWebRun=vi.fn(async(input:Record<string,unknown>)=>({wfRunId:input.wfRunId}));
vi.mock('../src/penguinRun.js',()=>({startRun:startWebRun,cancelRun:vi.fn()}));
let dir:string,projectId:string,db:typeof import('../src/db.js'),service:typeof import('../src/runService.js'),ops:typeof import('../src/workflowOps.js'),plans:typeof import('../src/projectRunPlans.js'),refs:typeof import('../src/domainReferences.js');
beforeAll(async()=>{
 dir=mkdtempSync(join(tmpdir(),'tp-plan-domain-ref-'));vi.stubEnv('TP_DATA_DIR',dir);
 vi.stubEnv('MIDSCENE_MODEL_NAME','fixture-executor');vi.stubEnv('MIDSCENE_MODEL_BASE_URL','https://executor.test/v1');vi.stubEnv('MIDSCENE_MODEL_API_KEY','fixture-key');
 vi.stubEnv('TP_CLAUDE_BIN',process.execPath);vi.stubEnv('TP_CODEX_BIN',process.execPath);
 db=await import('../src/db.js');service=await import('../src/runService.js');ops=await import('../src/workflowOps.js');plans=await import('../src/projectRunPlans.js');refs=await import('../src/domainReferences.js');
 projectId=db.createProject('Plan domain reference','http://127.0.0.1:9881').id;
});
afterAll(()=>{service.runLedger().close();db.db.close();vi.unstubAllEnvs();rmSync(dir,{recursive:true,force:true});});
const configuration={sourceKind:'spec',planner:'claude-code',materials:[{name:'requirements.md',text:'# Requirements\n\nUsers can create a task.\n'}]};

it('clean and rebuild plan runs freeze-bind the project domain reference',async()=>{
 const saved=refs.saveDomainReference(projectId,{text:'- Empty titles are rejected and the list does not grow'});
 for(const mode of ['clean','rebuild'] as const){
  const plan=plans.createProjectRunPlan(projectId,{mode,label:mode+' run',configuration});
  const {wfRunId}=await ops.createWebWorkflow(projectId,plans.projectPlanInputs(projectId,plan.id));
  expect(service.runLedger().requireRun(wfRunId,projectId).input.parameters.projectRunMode).toBe(mode);
  expect(refs.boundDomainReference(wfRunId,projectId)).toContain('Empty titles are rejected');
  expect(plan.domainReferenceHash).toBe(saved.hash);
 }
});

it('changing the domain reference after planning requires a new plan',async()=>{
 const plan=plans.createProjectRunPlan(projectId,{mode:'clean',label:'Before reference edit',configuration});
 await new Promise(r=>setTimeout(r,5));
 refs.saveDomainReference(projectId,{text:'- Titles longer than 200 characters are rejected'});
 expect(()=>plans.projectPlanInputs(projectId,plan.id)).toThrow('project_configuration_changed_replan');
 const replanned=plans.createProjectRunPlan(projectId,{mode:'clean',label:'After reference edit',configuration});
 const {wfRunId}=await ops.createWebWorkflow(projectId,plans.projectPlanInputs(projectId,replanned.id));
 expect(refs.boundDomainReference(wfRunId,projectId)).toContain('longer than 200 characters');
});
