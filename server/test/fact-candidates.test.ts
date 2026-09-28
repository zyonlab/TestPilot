import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** docs/v3/15 阶段 7：经验沉淀成界面事实候选，人确认才进领域参考。 */
let dir: string, projectId: string, runId: string;
let facts: typeof import("../src/factCandidates.js"), db: typeof import("../src/db.js"), library: typeof import("../src/knowledgeLibrary.js");
const human = { kind: "human" as const, id: "UNIT_TEST_REVIEWER" };

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "tp-facts-")); vi.stubEnv("TP_DATA_DIR", dir);
  vi.stubEnv("MIDSCENE_MODEL_NAME", "fixture-executor"); vi.stubEnv("MIDSCENE_MODEL_BASE_URL", "https://executor.test/v1"); vi.stubEnv("MIDSCENE_MODEL_API_KEY", "fixture-key");
  db = await import("../src/db.js"); const service = await import("../src/runService.js");
  facts = await import("../src/factCandidates.js"); library = await import("../src/knowledgeLibrary.js");
  projectId = db.createProject("Facts fixture", "http://127.0.0.1:9876").id;
  library.saveKnowledgeLibrary(projectId, "domainKnowledge", { title: "ref", value: "# Ref\n\nThe order panel has a Place Order button." }, human);
  runId = service.registerHostRun(projectId, { runtime: "codex", externalId: "facts", idempotencyKey: "facts", materials: [{ name: "m.md", text: "Available to Trade shows the balance." }] }).runId;
});
afterAll(() => { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

describe("literalsFromResult", () => {
  const known = "the order panel has a place order button. available to trade shows the balance.";
  it("keeps quoted labels the domain data does not know, and marks whether the recorded screen text has them", () => {
    const out = facts.literalsFromResult({
      failureReason: "Failed to plan actions: 下单面板底部的按钮当前为禁用的「Not Enough Margin」，不存在可点击的「Place Order」按钮。",
      oracle: [{ detail: "找到「Available to Trade」" }, { detail: "页面上没有「Order placed」" }],
      observations: [{ text: "Buy / Long\nNot Enough Margin" }],
    }, known, JSON.stringify(["Click Place Order", { kind: "text", value: "Order placed" }]));
    expect(out.map((o) => [o.literal, o.kind])).toEqual([["Not Enough Margin", "screen"]]);
  });
  it("drops sentences, variables and bare numbers", () => {
    expect(facts.literalsFromResult({ failureReason: "判官：「这一行的价格是 42,000，不是 Filled」「${env.SIZE}」「0.001」「Reduce Only Too Large」" }, known)
      .map((o) => [o.literal, o.kind])).toEqual([["Reduce Only Too Large", "reported"]]);
  });
});

describe("candidates and the human decision", () => {
  it("adds evidence on repeats, needs a human and a sentence to accept, and folds the fact into a new domain reference version", () => {
    const result = { failureReason: "按钮显示为禁用的「Not Enough Margin」" };
    facts.recordFactCandidates({ projectId, runId, caseId: "C1", receipt: "rev-1", result });
    facts.recordFactCandidates({ projectId, runId, caseId: "C1", receipt: "rev-1", result });
    facts.recordFactCandidates({ projectId, runId, caseId: "C2", receipt: "rev-2", result });
    const [c] = facts.listFactCandidates(projectId, "pending");
    expect(c).toMatchObject({ literal: "Not Enough Margin", seen: 2 });
    expect(() => facts.decideFactCandidate(projectId, c!.id, { decision: "accepted", fact: "x" }, { kind: "agent", id: "planner" })).toThrow("human_review_required");
    expect(() => facts.decideFactCandidate(projectId, c!.id, { decision: "accepted" }, human)).toThrow("fact_statement_required");
    const out = facts.decideFactCandidate(projectId, c!.id, { decision: "accepted", fact: "数量或所需保证金超过可用额时，下单按钮直接变成禁用的这几个字" }, human);
    expect(out.status).toBe("recorded");
    const saved = library.readKnowledgeLibrary(projectId, "domainKnowledge", out.referenceId!);
    expect(saved.value).toContain("The order panel has a Place Order button.");
    expect(saved.value).toContain("## 界面实测事实（自动沉淀，人已确认）");
    expect(saved.value).toContain("「Not Enough Margin」：数量或所需保证金超过可用额时");
    // 已并进领域参考：以后再出现不会再成为候选。
    expect(facts.recordFactCandidates({ projectId, runId, caseId: "C3", receipt: "rev-3", result })).toEqual([]);
  });
  it("never resurfaces a dismissed literal", () => {
    const result = { failureReason: "看到「Connect Wallet」" };
    const [c] = facts.recordFactCandidates({ projectId, runId, caseId: "C4", receipt: "rev-4", result });
    facts.decideFactCandidate(projectId, c!.id, { decision: "dismissed", note: "登录前才有" }, human);
    expect(facts.recordFactCandidates({ projectId, runId, caseId: "C5", receipt: "rev-5", result })).toEqual([]);
    expect(facts.listFactCandidates(projectId, "dismissed")).toHaveLength(1);
  });
});
