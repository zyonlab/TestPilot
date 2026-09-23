import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const runner = vi.hoisted(() => ({ run: vi.fn(), cancel: vi.fn().mockResolvedValue(true) }));
vi.mock("../src/exec.js", () => ({ execOnRunner: runner.run, cancelExecution: runner.cancel }));
/**
 * 这条 fixture 的判据 2026-09-12 从 `kind: api` 改成了屏幕判据。
 * 不是因为执行层不支持接口判据（它仍然支持，旧归档要跑得动），而是**门禁现在拦它**：
 * 这个产品产出的是端到端 UI 测试，判决必须在屏幕上（`oracle-offsite`，见 CLAUDE.md）。
 */
let dir: string, projectId: string, runId: string, codeRevision: string;
let service: typeof import("../src/runService.js"), db: typeof import("../src/db.js"), execution: typeof import("../src/workflowExecution.js");
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "tp-workflow-exec-")); vi.stubEnv("TP_DATA_DIR", dir);
  vi.stubEnv("MIDSCENE_MODEL_NAME", "fixture-executor"); vi.stubEnv("MIDSCENE_MODEL_BASE_URL", "https://executor.test/v1"); vi.stubEnv("MIDSCENE_MODEL_API_KEY", "fixture-key");
  db = await import("../src/db.js"); service = await import("../src/runService.js"); execution = await import("../src/workflowExecution.js");
  projectId = db.createProject("Execution fixture", "http://127.0.0.1:9876").id;
  runId = service.registerHostRun(projectId, { runtime: "codex", externalId: "fixture", idempotencyKey: "fixture", materials: [{ name: "counter.md", text: "Counter begins at 0. Increment changes it to 1." }] }).runId;
  const stage = await import("../src/runStages.js"), approvals = await import("../src/approvedRuns.js");
  stage.loadRunInstructions(runId, projectId); const ref = stage.retrieveRunSpec(runId, projectId, { query: "Increment", budgetTokens: 2000 }).chunks[0].id;
  const stories = [{ id: "s1", title: "Count", acceptance: [] }];
  stage.writeRunStage(runId, projectId, "stories", { stories });
  stage.writeRunStage(runId, projectId, "cases", { stories, cases: [{ id: "c1", storyId: "s1", title: "Count at zero", designMethod: "boundary", steps: ["Click Increment"], expected: "Count equals 1", tier: 1, readiness: {design:"candidate",execution:"ready"}, key: "zero-one", sourceRefs: [ref], oracle: { kind: "count", value: "Count: 1", op: "eq", n: 1 },
    assertions: [{ id: "A-1", statement: "The counter reads 1", ruleRefs: [], oracle: { kind: "text", value: "Count: 1" } }] }] });
  stage.gateRun(runId, projectId); stage.finalizeRun(runId, projectId);
  const review = approvals.reviewRevisions(runId, projectId);
  approvals.decideRevisions(runId, projectId, { items: review.map(c => ({ caseId: c.caseId, revisionId: c.revision.id, decision: "approved" })) }, { kind: "human", id: "UNIT_TEST_FIXTURE" });
  codeRevision = approvals.generateApprovedCode(runId, projectId).revision.id;
});
afterAll(() => { service.runLedger().close(); db.db.close(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });
function row(id: string) { return execution.listWorkflowExecutions(runId, projectId).find((r: any) => r.id === id) as any; }
it("executes an approved frozen oracle, records lineage, and deduplicates start requests", async () => {
  runner.run.mockResolvedValueOnce({ status: "passed", infraError: false, durationMs: 5, modelRequests: [], pngPaths: [], logs: [], oracle: [{ status: "pass", decidedBy: "machine" }] });
  const started = execution.startWorkflowExecution(runId, projectId, { codeRevision, idempotencyKey: "once" });
  expect(execution.startWorkflowExecution(runId, projectId, { codeRevision, idempotencyKey: "once" })).toMatchObject({ executionId: started.executionId, created: false });
  await vi.waitFor(() => expect(row(started.executionId).status).toBe("passed"));
  expect(runner.run).toHaveBeenCalledTimes(1); expect(runner.run.mock.calls[0][0]).toMatchObject({ modelSnapshotRunId: runId, opts: { oracle: { kind: "count", value: "Count: 1" } } });
  const artifact = service.runLedger().readRevision(row(started.executionId).resultRevision, projectId);
  expect(artifact.revision.sourceRefs).toEqual([codeRevision]);
});
it("cancels the exact runner execution and never records its late success as pass", async () => {
  let finish!: (result: unknown) => void;
  runner.run.mockImplementationOnce(() => new Promise(r => { finish = r; }));
  const started = execution.startWorkflowExecution(runId, projectId, { codeRevision, idempotencyKey: "cancel" });
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  expect(await execution.cancelWorkflowExecutions(runId, projectId)).toEqual({ cancelled: 1 });
  finish({ status: "passed", infraError: false });
  await vi.waitFor(() => expect(row(started.executionId).resultRevision).toBeTruthy());
  expect(row(started.executionId).status).toBe("cancelled"); expect(runner.cancel).toHaveBeenCalledTimes(1);
  expect(() => execution.startWorkflowExecution(runId, projectId, { codeRevision, idempotencyKey: "after-cancel" })).toThrow("run_requires_explicit_resume");
});
it("classifies reset failures as infrastructure and prevents the runner call", async () => {
  const { runEnvReset } = await import("../src/executionPolicy.js");
  expect(runEnvReset(undefined)).toBeNull(); expect(runEnvReset("exit 0")).toEqual(["environment reset completed"]);
  expect(() => runEnvReset("exit 7")).toThrow("ENV_RESET_FAILED");
  service.runLedger().db.prepare("UPDATE wf_runs SET status='waiting_review' WHERE id=?").run(runId);
  db.upsertEnvironment({ projectId, name: "reset-fails", baseUrl: "http://127.0.0.1:9876", vars: { TP_RESET_CMD: "exit 7" } });
  const before = runner.run.mock.calls.length;
  const attempt = execution.startWorkflowExecution(runId, projectId, { codeRevision, idempotencyKey: "reset-fails", envRef: "reset-fails" });
  await vi.waitFor(() => expect(row(attempt.executionId).status).toBe("infra_error"));
  expect(runner.run.mock.calls.length).toBe(before);
  const { classifyFailure } = await import("@testpilot/harness-testing");
  expect(classifyFailure("EXEC_CANCELLED")).toMatchObject({ attribution: "infra", retryable: false });
  expect(classifyFailure("ENV_RESET_FAILED")).toMatchObject({ attribution: "infra", retryable: false });
});

it("enforces the captured executor budget and refuses an unknown explicit environment", async () => {
  service.runLedger().db.prepare("UPDATE wf_runs SET status='waiting_review' WHERE id=?").run(runId);
  expect(() => execution.startWorkflowExecution(runId, projectId, { codeRevision, idempotencyKey: "missing-env", envRef: "not-an-env" })).toThrow("environment_missing");
  vi.stubEnv("TP_EXECUTOR_MAX_CALLS", "0"); const before = runner.run.mock.calls.length;
  const attempt = execution.startWorkflowExecution(runId, projectId, { codeRevision, idempotencyKey: "budget-zero" });
  await vi.waitFor(() => expect(row(attempt.executionId).status).toBe("budget_exhausted"));
  expect(runner.run.mock.calls.length).toBe(before);
  vi.stubEnv("TP_EXECUTOR_MAX_CALLS", "100");
});
it("marks in-flight work interrupted on restart, without launching a retry", async () => {
  service.runLedger().db.prepare("UPDATE wf_runs SET status='waiting_review' WHERE id=?").run(runId);
  service.runLedger().db.prepare("UPDATE workflow_executions SET status='running' WHERE id=(SELECT id FROM workflow_executions LIMIT 1)").run();
  const before = runner.run.mock.calls.length; execution.recoverWorkflowExecutions();
  expect(execution.listWorkflowExecutions(runId, projectId).some((r: any) => r.status === "running")).toBe(false);
  expect(runner.run.mock.calls.length).toBe(before);
});
it('missing runner usage stops the budgeted workflow and remains unknown instead of zero',async()=>{
 service.runLedger().db.prepare("UPDATE wf_runs SET status='waiting_review' WHERE id=?").run(runId);
 db.upsertEnvironment({projectId,name:'usage-probe',baseUrl:'http://127.0.0.1:9876',vars:{}});
 runner.run.mockResolvedValueOnce({status:'passed',infraError:false});
 const attempt=execution.startWorkflowExecution(runId,projectId,{codeRevision,idempotencyKey:'missing-usage',envRef:'usage-probe'});
 await vi.waitFor(()=>expect(row(attempt.executionId).status).toBe('infra_error'));
 const evidence=service.runLedger().readRevision(row(attempt.executionId).resultRevision,projectId).content as any;
 expect(evidence.forwardedExecutorCalls).toBeNull();expect(evidence.usageComplete).toBe(false);
 const spend=await import('../src/roleSpend.js');expect(spend.runRoleSpend(runId,projectId).roles[1]).toMatchObject({coverage:'partial',calls:null,estimatedUsd:null});
});

/**
 * 2026-09-13：81 条串行是 3.4 小时，而第一次上真环境要回答的是「这批代码跑不跑得动」。
 * 按模块切一刀，二十分钟就能量出同样的东西——前提是选择集要记在产物里，
 * 而且没选的那些不能冒充「批次停了没跑到」。
 */
it("只跑选中的用例，并把选择集记进产物", async () => {
  // 前面的用例留下了一个 TP_RESET_CMD=exit 7 的环境；这里要的是干净环境和可执行的运行状态。
  service.runLedger().db.prepare("UPDATE wf_runs SET status='waiting_review' WHERE id=?").run(runId);
  runner.run.mockResolvedValueOnce({ status: "passed", infraError: false, durationMs: 5, modelRequests: [], pngPaths: [], logs: [], oracle: [{ status: "pass", decidedBy: "machine" }] });
  const started = execution.startWorkflowExecution(runId, projectId, { codeRevision, idempotencyKey: "subset", caseIds: ["c1"], envRef: "usage-probe" });
  await vi.waitFor(() => expect(row(started.executionId).status).toBe("passed"));
  const content = service.runLedger().readRevision(row(started.executionId).resultRevision, projectId).content as any;
  expect(content.selection).toMatchObject({ caseIds: ["c1"], ran: 1, of: 1 });
  expect(content.results.filter((r: any) => r.status === "not_run")).toHaveLength(0);
});

it("挑了不在产物里的用例要当场拒绝，不静悄悄少跑", () => {
  service.runLedger().db.prepare("UPDATE wf_runs SET status='waiting_review' WHERE id=?").run(runId);
  expect(() => execution.startWorkflowExecution(runId, projectId, { codeRevision, idempotencyKey: "ghost", caseIds: ["c1", "TC-999"] }))
    .toThrow(/execution_case_not_in_bundle:TC-999/);
});

it("同一把幂等键换了选择集是冲突，不是复用", async () => {
  service.runLedger().db.prepare("UPDATE wf_runs SET status='waiting_review' WHERE id=?").run(runId);
  runner.run.mockResolvedValueOnce({ status: "passed", infraError: false, durationMs: 5, modelRequests: [], pngPaths: [], logs: [], oracle: [] });
  const a = execution.startWorkflowExecution(runId, projectId, { codeRevision, idempotencyKey: "same-key", caseIds: ["c1"], envRef: "usage-probe" });
  await vi.waitFor(() => expect(row(a.executionId).status).toBe("passed"));
  expect(() => execution.startWorkflowExecution(runId, projectId, { codeRevision, idempotencyKey: "same-key", envRef: "usage-probe" }))
    .toThrow(/execution_request_conflict/);
});

/**
 * 2026-09-13 实测（exec-1a32f697）：一次跑 10 条，全是 tier 1、全都声明了 text/noText 判据，
 * 而**实际判决 10 条全是 judge**。整份 81 条里顶层 `oracle` 是 0 条，判据全挂在 v2 的
 * `assertions[]` 上，一共 101 条被原地扔掉——因为这条路只把顶层那个交给执行侧。
 */
it("断言级判据要交到执行侧，否则 tier 1 在执行时只是一个标签", async () => {
  service.runLedger().db.prepare("UPDATE wf_runs SET status='waiting_review' WHERE id=?").run(runId);
  runner.run.mockResolvedValueOnce({ status: "passed", infraError: false, durationMs: 5, modelRequests: [], pngPaths: [], logs: [], oracle: [] });
  const started = execution.startWorkflowExecution(runId, projectId, { codeRevision, idempotencyKey: "assertion-oracles", envRef: "usage-probe" });
  await vi.waitFor(() => expect(row(started.executionId).status).toBe("passed"));
  const opts = runner.run.mock.calls.at(-1)![0].opts;
  expect(opts.assertions).toEqual([{ id: "A-1", statement: "The counter reads 1", ruleRefs: [], oracle: { kind: "text", value: "Count: 1" } }]);
});

/**
 * 2026-09-15 Vikunja：执行里有用例红，整条运行被写成 failed，g2 要求显式恢复——
 * 修完执行器想重编重跑被挡，重跑完又被写回 failed。这份文件里其余测试开头那句手动
 * `UPDATE wf_runs SET status='waiting_review'` 就是一直在绕它。这一条**不做手动重置**。
 */
it("用例没全过只记在执行上：运行回到 waiting_review，不用恢复就能再跑、再进节点", async () => {
  service.runLedger().db.prepare("UPDATE wf_runs SET status='waiting_review' WHERE id=?").run(runId);
  runner.run.mockResolvedValueOnce({ status: "failed", infraError: false, durationMs: 5, modelRequests: [], pngPaths: [], logs: [], failureReason: "页面上没有「Count: 1」", oracle: [{ status: "fail", decidedBy: "machine" }] });
  const red = execution.startWorkflowExecution(runId, projectId, { codeRevision, idempotencyKey: "case-red", envRef: "usage-probe" });
  await vi.waitFor(() => expect(row(red.executionId).status).toBe("failed"));
  // 判决在执行行上；运行本身没有失败。
  expect(service.runLedger().outputs.getRun(runId)?.status).toBe("waiting_review");
  const controls = await import("../src/workflowControls.js");
  expect((controls.beginStage(runId, projectId, { node: "g2" }) as { status: string }).status).not.toBe("failed");

  // 判定不了（unobservable）同理。
  runner.run.mockResolvedValueOnce({ status: "unobservable", infraError: false, durationMs: 5, modelRequests: [], pngPaths: [], logs: [], oracle: [{ status: "unobservable", decidedBy: "machine" }] });
  const unsure = execution.startWorkflowExecution(runId, projectId, { codeRevision, idempotencyKey: "case-unobservable", envRef: "usage-probe" });
  await vi.waitFor(() => expect(row(unsure.executionId).status).toBe("unobservable"));
  expect(service.runLedger().outputs.getRun(runId)?.status).toBe("waiting_review");
});

it('persists every retry, accounts failed-attempt calls before dispatch, and reports zero-call cache as unknown',async()=>{
 service.runLedger().db.prepare("UPDATE wf_runs SET status='waiting_review' WHERE id=?").run(runId);
 const observation={version:1,stages:[{stage:'actions',durationMs:12,status:'failed',model:{source:'role-proxy',forwarded:1,blocked:0},failure:{attribution:'infra',retryable:true}}],cache:{session:'unavailable',midscene:'unknown'},retries:[]};
 const request={requestId:'retry-first',at:new Date().toISOString(),role:'executor',model:'fixture',endpoint:'https://executor.test/v1',thinking:false,status:429,ms:5,forwarded:true};
 runner.run.mockResolvedValueOnce({status:'failed',infraError:true,failure:{retryable:true,code:'MODEL_UNAVAILABLE'},modelRequests:[request],observation});
 runner.run.mockResolvedValueOnce({status:'passed',infraError:false,modelRequests:[],observation:{...observation,stages:[]}});
 const before=runner.run.mock.calls.length;
 const started=execution.startWorkflowExecution(runId,projectId,{codeRevision,idempotencyKey:'retry-observation',envRef:'usage-probe'});
 await vi.waitFor(()=>expect(row(started.executionId).status).toBe('passed'),{timeout:12000});
 const artifact=service.runLedger().readRevision(row(started.executionId).resultRevision,projectId).content as any;
 expect(artifact.forwardedExecutorCalls).toBe(1);expect(artifact.results[0].attempts).toHaveLength(2);
 expect(artifact.results[0].attempts[0].observation.stages[0].status).toBe('failed');
 expect(artifact.results[0].attempts[1].observation.cache.midscene).toBe('unknown');
 expect(runner.run.mock.calls[before+1][0].opts.modelBudget.maxCalls).toBe(runner.run.mock.calls[before][0].opts.modelBudget.maxCalls-1);
 expect(artifact.observation.retries).toEqual([{stage:'retry-wait',reason:'retryable-infrastructure',delayMs:8000}]);
 expect(artifact.observation.stages.filter((s:any)=>s.stage==='validation').length).toBeGreaterThanOrEqual(3);
},15000);

it('persists dispatch cancellation without guessing the unavailable runner stage',async()=>{
 service.runLedger().db.prepare("UPDATE wf_runs SET status='waiting_review' WHERE id=?").run(runId);
 let reject!:(error:Error)=>void;runner.run.mockImplementationOnce(()=>new Promise((_r,j)=>{reject=j;}));
 const started=execution.startWorkflowExecution(runId,projectId,{codeRevision,idempotencyKey:'rpc-cancel-observation',envRef:'usage-probe'});
 await vi.waitFor(()=>expect(reject).toBeTypeOf('function'));await execution.cancelWorkflowExecutions(runId,projectId);reject(new Error('EXEC_CANCELLED'));
 await vi.waitFor(()=>expect(row(started.executionId).resultRevision).toBeTruthy());
 const artifact=service.runLedger().readRevision(row(started.executionId).resultRevision,projectId).content as any;
 expect(artifact.status).toBe('cancelled');expect(artifact.forwardedExecutorCalls).toBeNull();
 expect(artifact.results.find((r:any)=>r.caseId==='c1').attempts[0]).toMatchObject({status:'cancelled',observation:null});
 expect(artifact.observation.stages).toContainEqual(expect.objectContaining({stage:'dispatch',status:'cancelled',model:{source:'unavailable',forwarded:null,blocked:null}}));
});

it('keeps compilation timing separate from deterministic code and projects legacy evidence as uncollected',async()=>{
 service.runLedger().db.prepare("UPDATE wf_runs SET status='waiting_review' WHERE id=?").run(runId);
 const approvals=await import('../src/approvedRuns.js');
 const generated=approvals.generateApprovedCode(runId,projectId);expect(generated.revision.id).toBe(codeRevision);
 const receipts=service.runLedger().listRevisions(projectId,runId).filter(r=>r.name.startsWith('compilation-observation/'));
 expect(receipts.length).toBeGreaterThan(0);
 expect(service.runLedger().readRevision(receipts.at(-1)!.id,projectId).content).toMatchObject({observation:{stages:[{stage:'compilation',model:{source:'deterministic',forwarded:0}}]}});
 const before=receipts.length;approvals.approvedExecutionBundle(runId,projectId,codeRevision);
 expect(service.runLedger().listRevisions(projectId,runId).filter(r=>r.name.startsWith('compilation-observation/'))).toHaveLength(before);
 const detail=await import('../src/executionDetail.js');const legacy=execution.listWorkflowExecutions(runId,projectId).find((r:any)=>r.resultRevision&&(service.runLedger().readRevision(r.resultRevision,projectId).content as any).results[0]?.caseId==='c1'&&!(service.runLedger().readRevision(r.resultRevision,projectId).content as any).results[0]?.observation) as any;
 expect(detail.executionDetail(runId,projectId,legacy.id).cases[0].observation).toBeNull();
});
