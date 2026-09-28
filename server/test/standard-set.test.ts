import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readOnlyLifecycle } from "./helpers/lifecycle.js";
const runner = vi.hoisted(() => ({ run: vi.fn(), cancel: vi.fn().mockResolvedValue(true) }));
vi.mock("../src/exec.js", () => ({ execOnRunner: runner.run, cancelExecution: runner.cancel }));

/**
 * docs/v3/15 阶段 8～9：标准集从真跑通过的用例起草、只有人能冻结、按冻结集打分；
 * 执行模型在冻结集上比，只在那次执行里换模型，换项目模型要人点头。
 */
let dir: string, projectId: string, runId: string, codeRevision: string;
let service: typeof import("../src/runService.js"), db: typeof import("../src/db.js"), execution: typeof import("../src/workflowExecution.js");
let sets: typeof import("../src/standardSets.js"), evals: typeof import("../src/standardEvaluation.js");
const human = { kind: "human" as const, id: "UNIT_TEST_REVIEWER" };
const lifecycle = { version: 1, status: "pass", checks: [], cleanup: [], pendingResources: [], safeToRetry: true };
const verdict = (status: string) => ({ status, infraError: false, durationMs: 5, modelRequests: [], logs: [], oracle: [{ status: status === "passed" ? "pass" : "fail", decidedBy: "machine" }], lifecycle });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "tp-stdset-")); vi.stubEnv("TP_DATA_DIR", dir);
  vi.stubEnv("MIDSCENE_MODEL_NAME", "fixture-executor"); vi.stubEnv("MIDSCENE_MODEL_BASE_URL", "https://executor.test/v1"); vi.stubEnv("MIDSCENE_MODEL_API_KEY", "fixture-key");
  db = await import("../src/db.js"); service = await import("../src/runService.js"); execution = await import("../src/workflowExecution.js");
  sets = await import("../src/standardSets.js"); evals = await import("../src/standardEvaluation.js");
  projectId = db.createProject("Standard set fixture", "http://127.0.0.1:9876").id;
  runId = service.registerHostRun(projectId, { runtime: "codex", externalId: "std", idempotencyKey: "std",
    materials: [{ name: "counter.md", text: "Counter begins at 0. Increment changes it to 1. Reset changes it back to 0. The page shows Count: 0, Count: 1." }] }).runId;
  const stage = await import("../src/runStages.js"), approvals = await import("../src/approvedRuns.js");
  stage.loadRunInstructions(runId, projectId);
  const ref = stage.retrieveRunSpec(runId, projectId, { query: "Increment", budgetTokens: 2000 }).chunks[0].id;
  const stories = [{ id: "s1", title: "Count", acceptance: [] }];
  const kase = (id: string, step: string, value: string) => ({ id, storyId: "s1", title: `${id} title`, designMethod: "boundary", steps: [step],
    expected: `Counter shows ${value}`, tier: 1, key: id, sourceRefs: [ref], lifecycle: readOnlyLifecycle(ref), oracle: { kind: "text", value }, readiness: { design: "candidate", execution: "ready" } });
  stage.writeRunStage(runId, projectId, "stories", { stories });
  stage.writeRunStage(runId, projectId, "cases", { stories, cases: [kase("c1", "Click Increment", "Count: 1"), kase("c2", "Click Reset", "Count: 0")] });
  stage.gateRun(runId, projectId); stage.finalizeRun(runId, projectId);
  approvals.decideRevisions(runId, projectId, { items: approvals.reviewRevisions(runId, projectId).map((c) => ({ caseId: c.caseId, revisionId: c.revision.id, decision: "approved" })) }, human);
  codeRevision = approvals.generateApprovedCode(runId, projectId).revision.id;
  db.setSecret(projectId, "CANDIDATE_KEY", "candidate-secret");
});
afterAll(() => { service.runLedger().close(); db.db.close(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });
const status = (id: string) => (execution.listWorkflowExecutions(runId, projectId) as any[]).find((r) => r.id === id)?.status;

it("起草只收最近一次判定通过的用例；只有人能冻结；冻结的是人看过的那一份", async () => {
  // 第一次：c1 过、c2 挂；第二次：c1 基础设施失败（不算判定）、c2 过。
  runner.run.mockResolvedValueOnce(verdict("passed")).mockResolvedValueOnce(verdict("failed"));
  const a = execution.startWorkflowExecution(runId, projectId, { codeRevision, idempotencyKey: "std-1" });
  await vi.waitFor(() => expect(status(a.executionId)).not.toBe("running"));
  service.runLedger().db.prepare("UPDATE wf_runs SET status='waiting_review' WHERE id=?").run(runId);
  runner.run.mockResolvedValueOnce(verdict("passed"));
  const c = execution.startWorkflowExecution(runId, projectId, { codeRevision, idempotencyKey: "std-2", caseIds: ["c2"] });
  await vi.waitFor(() => expect(status(c.executionId)).not.toBe("running"));
  service.runLedger().db.prepare("UPDATE wf_runs SET status='waiting_review' WHERE id=?").run(runId);
  runner.run.mockResolvedValueOnce({ ...verdict("failed"), infraError: true, failure: { attribution: "infra", code: "MODEL_UNAVAILABLE", retryable: false } });
  const b = execution.startWorkflowExecution(runId, projectId, { codeRevision, idempotencyKey: "std-3", caseIds: ["c1"] });
  await vi.waitFor(() => expect(status(b.executionId)).not.toBe("running"));
  service.runLedger().db.prepare("UPDATE wf_runs SET status='waiting_review' WHERE id=?").run(runId);

  const draft = sets.draftStandardSet(projectId, { runIds: [runId] });
  expect(draft.items.map((i) => [i.caseId, i.passes, i.fails])).toEqual([["c1", 1, 0], ["c2", 1, 1]]);
  expect(() => sets.freezeStandardSet(projectId, draft.id, { itemsHash: draft.itemsHash }, { kind: "agent", id: "planner" })).toThrow("human_review_required");
  expect(() => sets.freezeStandardSet(projectId, draft.id, { itemsHash: "stale" }, human)).toThrow("standard_set_changed");
  const frozen = sets.freezeStandardSet(projectId, draft.id, { itemsHash: draft.itemsHash, exclude: ["c2"], note: "c2 判定不稳" }, human);
  expect(frozen).toMatchObject({ status: "frozen", items: [expect.objectContaining({ caseId: "c1" })], frozen: { by: "UNIT_TEST_REVIEWER" } });
  expect(() => sets.freezeStandardSet(projectId, frozen.id, { itemsHash: frozen.itemsHash }, human)).toThrow("standard_set_already_frozen");
  // 重新起草只换草稿，冻结的不动。
  sets.draftStandardSet(projectId, { runIds: [runId] });
  expect(sets.listStandardSets(projectId).filter((s) => s.status === "frozen")).toHaveLength(1);
  expect(sets.scoreExecutions(projectId, frozen.id, [a.executionId])).toMatchObject({ n: 1, passed: 1, passRate: 1 });
  expect(sets.scoreExecutions(projectId, frozen.id, [b.executionId])).toMatchObject({ n: 1, passed: 0, infra: 1 });
});

it("候选执行模型在冻结集上逐个跑、确定地打分；只在那次执行里换模型；换项目模型要人", async () => {
  const frozen = sets.listStandardSets(projectId).find((s) => s.status === "frozen")!;
  const candidate = { label: "free-pool", endpoint: "https://router.test/v1", model: "vision-a", vlMode: "gemini" as const, apiKeySecret: "CANDIDATE_KEY" };
  expect(() => evals.startEvaluation(projectId, { setId: frozen.id, candidates: [candidate] }, { kind: "agent", id: "planner" })).toThrow("human_review_required");
  runner.run.mockReset();
  runner.run.mockImplementation(async (_spec: unknown, control?: { executorOverride?: { model: string } }) => verdict(control?.executorOverride?.model === "vision-a" ? "passed" : "failed"));
  const started = evals.startEvaluation(projectId, { setId: frozen.id, candidates: [candidate] }, human, { pollMs: 20 });
  expect(started.entries.map((e) => [e.label, e.baseline])).toEqual([["current", true], ["free-pool", false]]);
  await vi.waitFor(() => expect(evals.listEvaluations(projectId)[0]!.status).toBe("awaiting_review"), { timeout: 10000 });
  const done = evals.listEvaluations(projectId)[0]!;
  expect(done.entries.map((e) => [e.label, e.score?.passRate])).toEqual([["current", 0], ["free-pool", 1]]);
  expect(done.recommendation).toBe("free-pool");
  // 运行绑定的执行模型没被评估换掉。
  const snapshot = (await import("../src/modelSnapshots.js")).snapshotExecutor(runId, projectId);
  expect(snapshot.model).toBe("fixture-executor");
  expect(() => evals.decideEvaluation(projectId, done.id, { decision: "promote", label: "current" }, human)).toThrow("evaluation_candidate_mismatch");
  expect(() => evals.decideEvaluation(projectId, done.id, { decision: "promote", label: "free-pool" }, { kind: "agent", id: "planner" })).toThrow("human_review_required");
  const promoted = evals.decideEvaluation(projectId, done.id, { decision: "promote", label: "free-pool" }, human);
  expect(promoted).toMatchObject({ status: "promoted", decision: { label: "free-pool" } });
  const models = await import("../src/modelProfiles.js");
  expect(models.projectModelProfiles(projectId).executor).toMatchObject({ model: "vision-a", endpoint: "https://router.test/v1", vlMode: "gemini", origin: "project" });
});
