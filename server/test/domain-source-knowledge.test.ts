import { beforeAll, afterAll, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
/**
 * source 节点的知识绑定：规则包 → charter + ContextManifest（docs/v3/20 §11 切片 2 的服务端半边）。
 * 真实账本、临时数据目录；不开浏览器、不问模型。
 */
let dir: string, project: string, service: typeof import("../src/runService.js"), db: typeof import("../src/db.js"), ops: typeof import("../src/workflowOps.js");
const packRaw = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../fixtures/perp-lab/rules.json"), "utf8"));
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "tp-domain-src-"));
  vi.stubEnv("TP_DATA_DIR", dir);
  db = await import("../src/db.js");
  service = await import("../src/runService.js");
  ops = await import("../src/workflowOps.js");
  project = db.createProject("Domain", "http://127.0.0.1:5391/").id;
  const { captureWebModels } = await import("./helpers/model-snapshot.js");
  service.registerWebRun("domain-run", project, captureWebModels().binding, { stageControlVersion: 1, sourceKind: "explore", sourceUrl: "http://127.0.0.1:5391/" });
  service.registerWebRun("generic-run", project, captureWebModels().binding, { stageControlVersion: 1, sourceKind: "explore", sourceUrl: "http://127.0.0.1:5391/" });
});
afterAll(() => { service.runLedger().close(); db.db.close(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

it("没有规则包：通用探索，manifest 明写没有知识、没有 charter", () => {
  const bound = ops.sourceKnowledge("generic-run", project, "http://127.0.0.1:5391/", 8);
  expect(bound.charter).toBeUndefined();
  expect(bound.manifest).toMatchObject({ node: "source", knowledge: [], isolationEvidence: "service-scoped", budget: { maxScreens: 8 } });
});

it("绑定规则包：charter 带规则包哈希与目标，manifest 记下 revision / hash / ruleIds", async () => {
  const ledger = service.runLedger();
  const { validateRulePack } = await import("@testpilot/harness-testing/domain");
  const v = validateRulePack(packRaw);
  if (!v.ok) throw new Error("pack invalid");
  const rev = ledger.putRevision({ projectId: project, runId: "domain-run", name: `knowledge/rulepack/${v.pack.id}`, kind: "report", content: { name: `rulepack/${v.pack.id}`, roles: ["source", "stories"], trust: "user-provided", executable: false, rulePack: v.pack, rulePackHash: v.hash } }, { kind: "system", id: "web" });
  ledger.putRevision({ projectId: project, runId: "domain-run", name: "knowledge/notes.md", kind: "report", content: { name: "notes.md", text: "free text", roles: ["source"], trust: "user-provided", executable: false } }, { kind: "system", id: "web" });
  const bound = ops.sourceKnowledge("domain-run", project, "http://127.0.0.1:5391/", 12);
  expect(bound.charter).toMatchObject({ rulePack: { id: v.pack.id, hash: v.hash }, scope: { entryUrl: "http://127.0.0.1:5391/", routes: [] }, budgets: { maxScreens: 12 } });
  expect(bound.charter!.featureTargets.length).toBe(v.pack.targets.length);
  expect(bound.manifest.knowledge).toEqual([
    expect.objectContaining({ packId: v.pack.id, revision: rev.id, hash: v.hash, ruleIds: v.pack.rules.map((r) => r.id), purpose: "exploration charter" }),
    expect.objectContaining({ packId: "notes.md", purpose: "free-text knowledge (not machine-checked)", ruleIds: [] }),
  ]);
  expect(bound.packRevision).toBe(rev.id);
});

it("落盘的哈希和内容对不上 → 409，不能拿改过的包冒充绑定版本", async () => {
  const ledger = service.runLedger();
  const { captureWebModels } = await import("./helpers/model-snapshot.js");
  service.registerWebRun("tampered-run", project, captureWebModels().binding, { stageControlVersion: 1 });
  ledger.putRevision({ projectId: project, runId: "tampered-run", name: "knowledge/rulepack/perp-lab-rules", kind: "report", content: { name: "rulepack/perp-lab-rules", roles: ["source"], trust: "user-provided", executable: false, rulePack: packRaw, rulePackHash: "0".repeat(64) } }, { kind: "system", id: "web" });
  expect(() => ops.sourceKnowledge("tampered-run", project, "http://127.0.0.1:5391/", 8)).toThrow("bound_rule_pack_hash_mismatch");
});

it("createWebWorkflow 在创建时拒绝坏规则包，并说出错在哪", async () => {
  const bad = structuredClone(packRaw) as { rules: Array<{ featureIds: string[] }> };
  bad.rules[0]!.featureIds = ["order.nope"];
  await expect(ops.createWebWorkflow(project, { idempotencyKey: "bad-pack", sourceKind: "explore", sourceUrl: "http://127.0.0.1:5391/", rulePacks: [bad] })).rejects.toThrow("invalid_rule_pack:dangling_ref@/rules/0/featureIds/0");
});
