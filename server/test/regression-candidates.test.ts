import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const runner = vi.hoisted(() => ({ run: vi.fn(), cancel: vi.fn().mockResolvedValue(true) }));
vi.mock("../src/exec.js", () => ({ execOnRunner: runner.run, cancelExecution: runner.cancel }));

/**
 * 失败 → 回归候选 → 人批准 → 项目回归集（regressionCandidates.ts）。
 * 真实账本、临时数据目录；执行器是假的，判决由测试给。
 */
let dir: string, projectId: string, runId: string, codeRevision: string;
let service: typeof import("../src/runService.js"), db: typeof import("../src/db.js"),
  execution: typeof import("../src/workflowExecution.js"), regression: typeof import("../src/regressionCandidates.js");
const human = { kind: "human" as const, id: "UNIT_TEST_REVIEWER" };

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "tp-regression-")); vi.stubEnv("TP_DATA_DIR", dir);
  vi.stubEnv("MIDSCENE_MODEL_NAME", "fixture-executor"); vi.stubEnv("MIDSCENE_MODEL_BASE_URL", "https://executor.test/v1"); vi.stubEnv("MIDSCENE_MODEL_API_KEY", "fixture-key");
  db = await import("../src/db.js"); service = await import("../src/runService.js");
  execution = await import("../src/workflowExecution.js"); regression = await import("../src/regressionCandidates.js");
  projectId = db.createProject("Regression fixture", "http://127.0.0.1:9876").id;
  runId = service.registerHostRun(projectId, { runtime: "codex", externalId: "regression", idempotencyKey: "regression",
    materials: [{ name: "counter.md", text: "Counter begins at 0. Increment changes it to 1. Reset changes it back to 0." }] }).runId;
  const stage = await import("../src/runStages.js"), approvals = await import("../src/approvedRuns.js");
  stage.loadRunInstructions(runId, projectId);
  const ref = stage.retrieveRunSpec(runId, projectId, { query: "Increment", budgetTokens: 2000 }).chunks[0].id;
  const stories = [{ id: "s1", title: "Count", acceptance: [] }];
  const kase = (id: string, title: string, step: string, value: string) => ({ id, storyId: "s1", title, designMethod: "boundary", steps: [step],
    expected: `Counter shows ${value}`, tier: 1, key: id, sourceRefs: [ref], oracle: { kind: "text", value } });
  stage.writeRunStage(runId, projectId, "stories", { stories });
  stage.writeRunStage(runId, projectId, "cases", { stories, cases: [
    kase("c1", "Increment once", "Click Increment", "Count: 1"),
    kase("c2", "Reset", "Click Reset", "Count: 0"),
    kase("c3", "Increment twice", "Click Increment twice", "Count: 2"),
  ] });
  stage.gateRun(runId, projectId); stage.finalizeRun(runId, projectId);
  const review = approvals.reviewRevisions(runId, projectId);
  approvals.decideRevisions(runId, projectId, { items: review.filter((c) => c.caseId !== "c3").map((c) => ({ caseId: c.caseId, revisionId: c.revision.id, decision: "approved" })) }, human);
  // c3 被驳回并写了理由：这就是「反例」来源。
  const c3 = review.find((c) => c.caseId === "c3")!;
  const rejected = approvals.decideRevisions(runId, projectId, { items: [{ caseId: "c3", revisionId: c3.revision.id, decision: "rejected" }],
    note: "需求里没有「点两次」这个操作，用例在编造交互" }, human);
  regression.proposeFromRejections(runId, projectId, rejected as never, "需求里没有「点两次」这个操作，用例在编造交互");
  codeRevision = approvals.generateApprovedCode(runId, projectId).revision.id;
});
afterAll(() => { service.runLedger().close(); db.db.close(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });
const row = (id: string) => execution.listWorkflowExecutions(runId, projectId).find((r: any) => r.id === id) as any;
const pending = (kind: string) => regression.listRegressionCandidates(projectId, { runId, status: "pending" }).filter((c) => c.kind === kind);

it("驳回且写了理由的用例成为反例候选；没写理由的不收", () => {
  const [c] = pending("rejection");
  expect(c).toMatchObject({ caseId: "c3", title: "Increment twice", evidence: { reason: expect.stringContaining("编造交互"), rejectedBy: "UNIT_TEST_REVIEWER" } });
  expect(regression.proposeFromRejections(runId, projectId, [{ decision: "rejected", status: "recorded", caseId: "c3", revisionId: c.sourceRevisionId }], " ")).toEqual({ created: [], updated: [] });
});

it("驳回不写理由会被服务端拦下——界面上一路点「拒绝」就把反例丢光的那条路堵住了", async () => {
  const approvals = await import("../src/approvedRuns.js");
  const review = approvals.reviewRevisions(runId, projectId);
  const target = review.find((c) => c.caseId === "c2")!;
  const reject = (note?: string) =>
    approvals.decideRevisions(runId, projectId, { items: [{ caseId: "c2", revisionId: target.revision.id, decision: "rejected" }], ...(note === undefined ? {} : { note }) }, human);
  expect(() => reject()).toThrow(/rejection_requires_reason/);
  expect(() => reject("  短 ")).toThrow(/rejection_requires_reason/);
  // 批准不受影响：理由是给「为什么不该生成」用的。
  expect(() => approvals.decideRevisions(runId, projectId, { items: [{ caseId: "c2", revisionId: target.revision.id, decision: "approved" }] }, human)).not.toThrow();
});

it("执行里判定失败的用例自动成为缺陷候选；环境失败不收；同一版再挂一次不重复", async () => {
  runner.run
    .mockResolvedValueOnce({ status: "failed", infraError: false, durationMs: 5, modelRequests: [], logs: [], failureReason: "页面上没有「Count: 1」", oracle: [{ status: "fail", decidedBy: "machine", assertion: "Counter shows Count: 1" }] })
    .mockResolvedValueOnce({ status: "failed", infraError: true, durationMs: 5, modelRequests: [], logs: [], failureReason: "ECONNREFUSED",
      failure: { code: "EXEC_ENV", attribution: "infra", retryable: false, message: "ECONNREFUSED" }, oracle: [] });
  const first = execution.startWorkflowExecution(runId, projectId, { codeRevision, idempotencyKey: "red-1" });
  // 一条环境失败就让整批记成 infra_error；同批里判定失败的那条照样要进候选。
  await vi.waitFor(() => expect(row(first.executionId).status).toBe("infra_error"));
  await vi.waitFor(() => expect(pending("defect")).toHaveLength(1));
  const [defect] = pending("defect");
  expect(defect).toMatchObject({ caseId: "c1", seen: 1, evidence: { executionId: first.executionId, failureCode: "EXEC_ASSERT", boardCaseId: expect.stringMatching(/^tc-rev-/) } });

  // 手动再收一次：c2 因为是环境失败被跳过，并说明原因。
  const again = regression.proposeFromExecution(runId, projectId, { executionId: first.executionId });
  expect(again.created).toEqual([]);
  expect(again.skipped).toContainEqual({ caseId: "c2", reason: "attribution_infra" });
  expect(pending("defect")[0]!.seen).toBe(2);
  // 候选在原运行上留了一条修订，名字是保留前缀。
  const rev = service.runLedger().readRevision(defect.revisionId, projectId);
  expect(rev.revision.name).toBe(`regression-candidate/c1/${defect.id}`);
  expect(rev.revision.sourceRefs).toContain(defect.sourceRevisionId);
});

it("只有人能批准；批准后进项目回归集，驳回的不再冒出来", async () => {
  const [defect] = pending("defect");
  const [negative] = pending("rejection");
  expect(() => regression.decideRegressionCandidate(projectId, defect.id, { decision: "approved" }, { kind: "agent", id: "planner" })).toThrow("human_review_required");

  const approved = regression.decideRegressionCandidate(projectId, defect.id, { decision: "approved", note: "确认是计数器的缺陷" }, human);
  expect(approved).toMatchObject({ status: "recorded", candidate: { status: "approved", decision: { by: "UNIT_TEST_REVIEWER" } }, suiteEntry: { role: "regression-case", caseId: "c1" } });
  expect(regression.decideRegressionCandidate(projectId, defect.id, { decision: "approved" }, human)).toMatchObject({ status: "unchanged" });
  expect(() => regression.decideRegressionCandidate(projectId, defect.id, { decision: "dismissed" }, human)).toThrow("regression_candidate_already_decided");

  regression.decideRegressionCandidate(projectId, negative.id, { decision: "approved" }, human);
  const suite = regression.regressionSuite(projectId);
  expect(suite.map((e) => [e.kind, e.role, e.caseId])).toEqual([["defect", "regression-case", "c1"], ["rejection", "generator-negative-eval", "c3"]]);
  expect(regression.regressionSuite(projectId, "defect")).toHaveLength(1);
  expect((suite[1]!.case as { title: string }).title).toBe("Increment twice");

  // 已经决定过的那一版再挂一次：不会重新变成待定候选。
  service.runLedger().db.prepare("UPDATE wf_runs SET status='waiting_review' WHERE id=?").run(runId);
  runner.run.mockResolvedValueOnce({ status: "failed", infraError: false, durationMs: 5, modelRequests: [], logs: [], failureReason: "页面上没有「Count: 1」", oracle: [] })
    .mockResolvedValueOnce({ status: "passed", infraError: false, durationMs: 5, modelRequests: [], logs: [], oracle: [] });
  const second = execution.startWorkflowExecution(runId, projectId, { codeRevision, idempotencyKey: "red-2" });
  await vi.waitFor(() => expect(row(second.executionId).status).toBe("failed"));
  const out = regression.proposeFromExecution(runId, projectId, { executionId: second.executionId });
  expect(out.created).toEqual([]);
  expect(pending("defect")).toEqual([]);
});

it("没有执行就说清楚", () => {
  expect(() => regression.proposeFromExecution(runId, projectId, { executionId: "nope" })).toThrow("execution_not_found");
});
