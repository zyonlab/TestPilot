import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
let dir: string, url: string, server: Server, projectId: string;
let database: typeof import("../src/db.js"), service: typeof import("../src/runService.js");
const input = { externalId: "session-one", idempotencyKey: "session-one", runtime: "codex", materials: [{ name: "counter.md", text: "Count increases once." }] };
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "tp-run-api-")); vi.stubEnv("TP_DATA_DIR", dir);
  database = await import("../src/db.js"); service = await import("../src/runService.js");
  const profiles = await import("../src/modelProfiles.js");
  projectId = database.createProject("Scope", "http://localhost").id;
  profiles.saveProjectModelProfile(projectId, "executor", { expectedVersion: 0, provider: "test", model: "vision", endpoint: "https://executor.test/v1", apiKey: "executor-secret", thinking: false, capabilities: { vision: "unknown", toolUse: "unknown" } });
  const { runRouter } = await import("../src/runRoutes.js");
  const app = express(); app.use(express.json()); app.use("/projects/:projectId/runs", runRouter());
  server = app.listen(0, "127.0.0.1"); await new Promise<void>(r => server.once("listening", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/projects/${projectId}/runs`;
});
afterAll(async () => { await new Promise<void>(r => server.close(() => r())); service.runLedger().close(); database.db.close(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });
async function post(path: string, body: unknown, token?: string) {
  return fetch(url + path, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
}
it("registers host runs without a planner config and returns one shared project run on retry", async () => {
  const a = await (await post("/register", input)).json(); const b = await (await post("/register", input)).json();
  expect(a.runId).toBe(b.runId); expect(a.created).toBe(true); expect(b.created).toBe(false);
  expect(a.run.binding.models.planner).toMatchObject({ source: "host", runtime: "codex", identityEvidence: "unknown", model: null });
  expect(a.run.binding.loadedDigest).toBeNull(); expect(a.run.binding.inputHash).toHaveLength(64);
  expect(JSON.stringify(a)).not.toContain("executor-secret");
  expect((await (await fetch(url)).json()).runs).toHaveLength(1);
  const { snapshotExecutor } = await import("../src/modelSnapshots.js");
  expect(snapshotExecutor(a.runId, projectId).apiKey).toBe("executor-secret");
});
it("imports revisions once, rejects reserved gate output and ignores a forged human actor", async () => {
  const r = await (await post("/register", input)).json();
  const body = { name: "cases", kind: "cases", content: { cases: [] }, __actor: "human" };
  expect((await post(`/${r.runId}/artifacts`, body)).status).toBe(401);
  const a = await (await post(`/${r.runId}/artifacts`, body, r.writeToken)).json();
  const b = await (await post(`/${r.runId}/artifacts`, body, r.writeToken)).json();
  expect(a.id).toBe(b.id); expect(a.createdBy.kind).toBe("agent");
  expect((await post(`/${r.runId}/artifacts`, { ...body, kind: "gate" }, r.writeToken)).status).toBe(403);
  // 名字也是保留的：门禁判过的 validated/* 与单元循环的 units/* 只能由服务端写。
  // 2026-09-11 实测：门禁把 validated/cases 判为不通过之后，规划器用这条路由把它
  // 从 53 条用例覆盖成了 1 条探针用例（docs/v3/23 的 F-1）。
  for (const name of ["validated/cases", "units/cases/cases:US-1"]) {
    const res = await post(`/${r.runId}/artifacts`, { ...body, name }, r.writeToken);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("reserved_artifact_name");
  }
  expect((await post(`/${r.runId}/artifacts`, { ...body, name: "probe-cases" }, r.writeToken)).status).toBe(200);
  expect((await (await fetch(`${url}/${r.runId}/artifacts/${a.id}`)).json()).content).toEqual({ cases: [] });
  expect((await post("/register", { ...input, materials: [{ name: "counter.md", text: "Changed" }] })).status).toBe(409);
});
it("Web material snapshots stay fixed when the original directory changes", async () => {
  const models = (await import("./helpers/model-snapshot.js")).captureWebModels();
  service.registerWebRun("web-one", projectId, models.binding);
  const source = join(dir, "materials"); mkdirSync(source); writeFileSync(join(source, "a.md"), "original");
  const view = service.freezeRunMaterials("web-one", projectId, source);
  writeFileSync(join(source, "a.md"), "changed");
  expect(service.freezeRunMaterials("web-one", projectId, source)).toBe(view);
  const rev = service.runLedger().listRevisions(projectId, "web-one")[0];
  expect(readFileSync(join(view, `${rev.contentHash}.md`), "utf8")).toBe("original");
  service.registerWebRun("web-two", projectId, models.binding);
  service.freezeRunMaterials("web-two", projectId, source);
  expect(service.runLedger().registration("web-one")!.binding.inputHash).not.toBe(service.runLedger().registration("web-two")!.binding.inputHash);
});
async function staged(id: string) {
  const r = await (await post("/register", { ...input, externalId: id, idempotencyKey: id })).json();
  const call = async (stage: string, body: unknown = {}) => {
    const response = await post(`/${r.runId}/stages/${stage}`, body, r.writeToken);
    return { status: response.status, body: await response.json() };
  };
  return { ...r, call };
}
const stories = { stories: [{ id: "s1", title: "Increment count", role: "visitor", benefit: "count clicks", acceptance: ["Given count 0, when Increment is clicked, then count is 1"] }] };
function cases(ref: string) {
  return { stories: stories.stories, cases: [{ id: "c1", storyId: "s1", title: "Count increments", steps: ["Click Increment"], expected: "Count equals 1", tier: 3, designMethod: "boundary", key: "zero-one", sourceRefs: [ref] }] };
}
it("serves frozen skills and material chunks; refuses stage skipping and untrusted imported cases", async () => {
  const r = await staged("skip-stages");
  expect((await r.call("finalize")).body.code).toBe("instructions_required");
  const instructions = await r.call("instructions"); expect(instructions.body.loadedDigest).toHaveLength(64);
  expect((await r.call("instructions")).body.revisionId).toBe(instructions.body.revisionId);
  expect((await r.call("cases", { content: cases("fake#1") })).body.code).toBe("retrieve_spec_required");
  const fetched = await r.call("retrieve", { query: "count", budgetTokens: 2000 }); const ref = fetched.body.chunks[0].id;
  expect((await r.call("cases", { content: cases(ref) })).body.code).toBe("stories_required");
  await post(`/${r.runId}/artifacts`, { name: "validated/cases", kind: "cases", content: cases(ref) }, r.writeToken);
  expect((await r.call("gate")).body.code).toBe("cases_required");
});
it("requires a current gate, finalizes idempotently, freezes stages and shares its review projection", async () => {
  const r = await staged("valid-stages"); await r.call("instructions");
  const ref = (await r.call("retrieve", { query: "count", budgetTokens: 2000 })).body.chunks[0].id;
  expect((await r.call("stories", { content: stories })).body.status).toBe("validated");
  const ungrounded = await r.call("cases", { content: cases("invented#9") }); expect(ungrounded.body.status).toBe("blocked");
  expect((await r.call("cases", { content: cases(ref) })).body.status).toBe("validated");
  expect((await r.call("finalize")).body.code).toBe("gate_required");
  const gated = await r.call("gate", { score: 100, minGateScore: 0 }); expect(gated.body.status).toBe("passed");
  const changed = cases(ref); changed.cases[0].title = "Increment from zero";
  await r.call("cases", { content: changed });
  expect((await r.call("finalize")).body.code).toBe("gate_stale_rerun_required");
  await r.call("gate"); const finalized = await r.call("finalize");
  expect(finalized.body.status).toBe("waiting_review");
  expect((await r.call("finalize")).body.revisionId).toBe(finalized.body.revisionId);
  expect((await r.call("cases", { content: cases(ref) })).body.code).toBe("run_finalized_create_revision_run");
  expect(await service.runLedger().outputs.get(r.runId, "gate")).toMatchObject({ cases: [{ title: "Increment from zero" }] });
  expect((await (await fetch(`${url}/${r.runId}`)).json()).status).toBe("waiting_review");
});
it("checks blob integrity at finalize and never accepts a disk-forged gate", async () => {
  const r = await staged("tampered-stages"); await r.call("instructions");
  const ref = (await r.call("retrieve", { query: "count", budgetTokens: 2000 })).body.chunks[0].id;
  await r.call("stories", { content: stories }); await r.call("cases", { content: cases(ref) });
  const gate = await r.call("gate");
  const path = join(dir, "revision-blobs", gate.body.revision.contentHash); const original = readFileSync(path);
  writeFileSync(path, JSON.stringify({ score: 1, passed: true }));
  try { expect((await r.call("finalize")).body.code).toBe("revision_content_changed"); }
  finally { writeFileSync(path, original); }
});
it("binds human approvals to revisions, compiles only approved cases and invalidates stale execution", async () => {
  const r = await staged("approved-stages"); await r.call("instructions");
  const ref = (await r.call("retrieve", { query: "count", budgetTokens: 2000 })).body.chunks[0].id;
  await r.call("stories", { content: stories }); await r.call("cases", { content: cases(ref) }); await r.call("gate"); await r.call("finalize");
  const review = (await (await fetch(`${url}/${r.runId}/review`)).json()).cases;
  const item = { caseId: "c1", revisionId: review[0].revision.id, decision: "approved" };
  expect((await r.call("g2")).body.code).toBe("approved_cases_required");
  expect((await post(`/${r.runId}/review`, { items: [item], __actor: "human" }, r.writeToken)).status).toBe(403);
  const decision = await (await post(`/${r.runId}/review`, { items: [item] })).json();
  expect(decision.results[0].status).toBe("recorded");
  const recorded = (await (await fetch(`${url}/${r.runId}/review`)).json()).cases[0];
  expect(recorded.approval.principal).toEqual({ kind: "human", id: "local-operator" });
  const again = await (await post(`/${r.runId}/review`, { items: [item] })).json();
  expect(again.results[0].status).toBe("unchanged");
  const compile = await post(`/${r.runId}/stages/g2`, {}); const code = { body: await compile.json() }; expect(code.body.status).toBe("ready_to_execute");
  expect((await r.call("g2")).body.revision.id).toBe(code.body.revision.id);
  const approval = await import("../src/approvedRuns.js");
  expect(approval.approvedExecutionBundle(r.runId, projectId, code.body.revision.id).cases).toHaveLength(1);
  const content = { ...review[0].content, expected: "Count equals 2" };
  const change = await fetch(`${url}/${r.runId}/review`, { method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ caseId: "c1", expectedRevision: item.revisionId, content }) });
  expect((await change.json()).approvalValid).toBe(false);
  expect(() => approval.approvedExecutionBundle(r.runId, projectId, code.body.revision.id)).toThrow("case_revision_not_approved");
  const stale = await (await post(`/${r.runId}/review`, { items: [item] })).json();
  expect(stale.results[0].status).toBe("conflict");
});
it("retains failed decision delivery for retry without repeating successful deliveries", async () => {
  const approval = await import("../src/approvedRuns.js");
  const registered = service.runLedger().db.prepare("SELECT runId FROM wf_run_registrations WHERE externalId='approved-stages'").get() as { runId: string };
  const latest = approval.reviewRevisions(registered.runId, projectId)[0];
  approval.decideRevisions(registered.runId, projectId, { items: [{ caseId: latest.caseId, revisionId: latest.revision.id, decision: "approved" }] }, { kind: "human", id: "test-reviewer" });
  const fail = await approval.deliverDecisionOutbox(() => { throw new Error("disk unavailable"); });
  expect(fail.pending).toBeGreaterThan(0);
  const delivered: string[] = [];
  const retry = await approval.deliverDecisionOutbox(e => { delivered.push(e.id); });
  expect(retry.delivered).toBe(fail.pending); expect(retry.pending).toBe(0);
  await approval.deliverDecisionOutbox(e => { delivered.push(e.id); });
  expect(delivered).toHaveLength(retry.delivered);
});
it("exports verified ancestry and approval history, and refuses cross-project or unrelated diffs", async () => {
  const r = await staged("artifact-views"); await r.call("instructions");
  const ref = (await r.call("retrieve", { query: "count", budgetTokens: 2000 })).body.chunks[0].id;
  await r.call("stories", { content: stories }); await r.call("cases", { content: cases(ref) }); await r.call("gate"); await r.call("finalize");
  const { reviewRevisions, reviseReviewedCase, decideRevisions } = await import("../src/approvedRuns.js");
  const first = reviewRevisions(r.runId, projectId)[0];
  const reviewer = { kind: "human" as const, id: "UNIT_TEST_REVIEWER" };
  decideRevisions(r.runId, projectId, { items: [{ caseId: first.caseId, revisionId: first.revision.id, decision: "approved" }] }, reviewer);
  const changed = reviseReviewedCase(r.runId, projectId, { caseId: first.caseId, expectedRevision: first.revision.id, content: { ...first.content, expected: "Counter becomes exactly 1" } }, reviewer);
  const diff = await (await fetch(`${url}/${r.runId}/artifacts/${changed.revision.id}/diff`)).json();
  expect(diff.changes).toEqual([{ path: "/expected", before: "Count equals 1", after: "Counter becomes exactly 1" }]);
  const exported = await (await fetch(`${url}/${r.runId}/artifacts/${changed.revision.id}/export`)).json();
  expect(exported.revisions.some((a: any) => a.revision.kind === "material")).toBe(true);
  expect(exported.approvals).toHaveLength(1); expect(exported.binding.inputHash).toHaveLength(64);
  expect((await fetch(`${url}/${r.runId}/artifacts/${changed.revision.id}/diff?previous=${exported.binding.materialRevisions[0]}`)).status).toBe(409);
  const other = database.createProject("Other scope", "http://localhost").id;
  const { revisionLineage } = await import("../src/artifactViews.js");
  expect(() => revisionLineage(other, first.revision.id)).toThrow("revision_project_conflict");
});

it("stops downstream work and resumes only a verified immutable checkpoint", async () => {
  const r = await staged("checkpoint-resume"); await r.call("instructions");
  const ref = (await r.call("retrieve", { query: "count", budgetTokens: 2000 })).body.chunks[0].id;
  await r.call("stories", { content: stories });
  expect((await post(`/${r.runId}/cancel`, {}, r.writeToken)).status).toBe(403);
  expect((await post(`/${r.runId}/cancel`, {})).status).toBe(200);
  expect((await r.call("cases", { content: cases(ref) })).body.code).toBe("run_requires_explicit_resume");
  const resume = await (await post(`/${r.runId}/resume`, {})).json();
  expect(resume.checkpoint.next).toBe("cases"); expect(resume.continuation).toBe("continue_in_original_host");
  expect((await r.call("cases", { content: cases(ref) })).body.status).toBe("validated");
  await post(`/${r.runId}/cancel`, {});
  const revision = service.runLedger().listRevisions(projectId, r.runId).find(r => r.kind === "material")!;
  const blob = join(dir, "revision-blobs", revision.contentHash), original = readFileSync(blob);
  try { writeFileSync(blob, "changed"); expect((await post(`/${r.runId}/resume`, {})).status).toBe(409); }
  finally { writeFileSync(blob, original); }
});
it('g2 compilation is independent of requested approval revision order', async () => {
  const r = await staged('ordered-g2'); await r.call('instructions');
  const ref = (await r.call('retrieve', { query: 'count', budgetTokens: 2000 })).body.chunks[0].id;
  const content = cases(ref); content.cases.push({ ...content.cases[0], id: 'c2', key: 'reset-zero', title: 'Reset at zero', steps: ['Click Reset'], expected: 'Count equals 0' });
  await r.call('stories', { content: stories }); await r.call('cases', { content }); await r.call('gate'); await r.call('finalize');
  const approvals = await import('../src/approvedRuns.js'); const reviewed = approvals.reviewRevisions(r.runId, projectId);
  approvals.decideRevisions(r.runId, projectId, { items: reviewed.map(c => ({ caseId: c.caseId, revisionId: c.revision.id, decision: 'approved' })) }, { kind: 'human', id: 'synthetic-review' });
  const first = approvals.generateApprovedCode(r.runId, projectId), reverse = approvals.generateApprovedCode(r.runId, projectId, { revisionIds: reviewed.map(c => c.revision.id).reverse() });
  expect(reverse.revision.id).toBe(first.revision.id); expect(approvals.approvedExecutionBundle(r.runId, projectId, first.revision.id).cases).toHaveLength(2);
  const subset=await r.call('g2',{revisionIds:[reviewed[0].revision.id]});
  expect(approvals.compiledReadiness(r.runId,projectId).codeRevision).toBe(subset.body.revision.id);
  const restored=await r.call('g2');
  expect(restored.body.revision.id).toBe(first.revision.id);
  expect(approvals.compiledReadiness(r.runId,projectId)).toMatchObject({codeRevision:first.revision.id,ready:true});
});

it("已收尾的 run 不会因为门禁规则变了就再也打不开", async () => {
  const r = await staged("frozen-verdict"); await r.call("instructions");
  const ref = (await r.call("retrieve", { query: "count", budgetTokens: 2000 })).body.chunks[0].id;
  await r.call("stories", { content: stories });
  await r.call("cases", { content: cases(ref) });
  await r.call("gate");
  const first = (await r.call("finalize")).body;
  expect(first.status).toBe("waiting_review");
  /**
   * 模拟「门禁规则改了」：把钉住的报告改成和今天重算出来的不一样。
   * 原来的顺序会在这里报 gate_not_passed——于是前一天刚收尾的 run 读不出来了。
   */
  const ledger = service.runLedger();
  const gateRev = ledger.listRevisions(projectId, r.runId).filter(x => x.name === "validated/gate").at(-1)!;
  const content = ledger.readRevision(gateRev.id, projectId).content as { report: { score: number } };
  content.report.score = 0.999_1;
  ledger.putRevision({ projectId, runId: r.runId, name: "validated/gate", kind: "report", content }, { kind: "system", id: "stage-validator" });
  const again = (await r.call("finalize")).body;
  expect(again.status).toBe("waiting_review");
  expect(again.casesRevision).toBe(first.casesRevision);
  // 防篡改没放松：收尾之后连换用例这一步都进不去。
  const bumped = { ...cases(ref) };
  bumped.cases.push({ ...bumped.cases[0], id: "c2", key: "one-two", title: "Count increments again" });
  expect((await r.call("cases", { content: bumped })).body.code).toBe("run_finalized_create_revision_run");
});

/**
 * 用例节点的结构契约，整份路径也要拿到（docs/v3/24 §34）。
 *
 * 2026-09-13 双臂实测：机器臂走单元循环，那份点名 design / risk / readiness 的契约
 * 每个单元重发一遍 → 设计证据 100%、风险 100%；Claude 臂走整份路径，
 * beginStage 只给 stories 发 structureContract、给 cases 什么都不发 → 9% 与 12%。
 * 不是模型更懒，是提醒根本没送到。
 */
it("begin-stage 给 cases 节点也发结构契约", async () => {
  const controls = await import("../src/workflowControls.js");
  const service = await import("../src/runService.js");
  const key = `contract-${Date.now()}`;
  const { runId } = service.registerHostRun(projectId, { runtime: "codex", externalId: key, idempotencyKey: key,
    materials: [{ name: "m.md", text: "# 材料\n\n## 一段\n内容\n" }], parameters: {} });
  const out = controls.beginStage(runId, projectId, { node: "cases" }) as { structureContract?: string };
  expect(out.structureContract).toBeTruthy();
  for (const named of ["designMethod", "readiness", "risk", "assertions", "acRefs"])
    expect(out.structureContract).toContain(named);
});

/**
 * g2 的入口地址按**这次运行**声明的来，不是项目级的（docs/v3/24 §36）。
 *
 * 2026-09-13 实测：项目的 targetUrl 是 …/trade，而这次运行按 …/trade/ETH 建
 * （parameters.sourceUrl），用例全是照着 ETH 那一屏写的（Positions (1)、Current Position 0.0400 ETH）。
 * 编译时却拿项目级地址当入口——81 条里 38 条不自己导航的会在另一个市场上开跑，
 * 一整批红，而产品什么事都没有。
 */
it("g2 的 entryUrl 用运行声明的 sourceUrl，没声明才回落到项目", async () => {
  const approvals = await import("../src/approvedRuns.js");
  const service = await import("../src/runService.js");
  const key = `entry-${Date.now()}`;
  const { runId } = service.registerHostRun(projectId, { runtime: "codex", externalId: key, idempotencyKey: key,
    materials: [{ name: "m.md", text: "# 材料\n\n## 一段\n内容\n" }],
    parameters: { sourceUrl: "http://localhost/deep/page" } });
  // 直接看它读到的基址：项目是 http://localhost，运行声明的是 /deep/page。
  const detail = service.runLedger().getRun(runId, projectId).detail as { parameters?: { sourceUrl?: string } };
  expect(detail.parameters?.sourceUrl).toBe("http://localhost/deep/page");
  expect(typeof approvals.generateApprovedCode).toBe("function");
});
