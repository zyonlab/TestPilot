import { beforeAll, afterAll, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `modules` 节点（docs/v3/history/24 §6、§7）：模型提议 → 服务端机检 → 人冻结。
 * 冻结之后按它切单元；没冻结就回落到规则包里那棵树。
 */
let dir: string, project: string, service: typeof import("../src/runService.js"),
  db: typeof import("../src/db.js"), stage: typeof import("../src/moduleStage.js"),
  controlsModule: typeof import("../src/workflowControls.js");

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "tp-modstage-"));
  vi.stubEnv("TP_DATA_DIR", dir);
  vi.stubEnv("MIDSCENE_MODEL_NAME", "fixture"); vi.stubEnv("MIDSCENE_MODEL_BASE_URL", "https://fixture.test/v1"); vi.stubEnv("MIDSCENE_MODEL_API_KEY", "fixture-key");
  db = await import("../src/db.js"); service = await import("../src/runService.js"); stage = await import("../src/moduleStage.js");
  controlsModule = await import("../src/workflowControls.js");
  project = db.createProject("mod-stage", "http://127.0.0.1:5391/").id;
});
afterAll(() => { service.runLedger().close(); db.db.close(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

const MATERIAL = "# 材料\n\n## 一段\n内容\n\n## 二段\n内容\n\n## 三段\n内容\n";
function newRun(key: string, parameters: Record<string, unknown> = { workUnits: 1 }) {
  return service.registerHostRun(project, { runtime: "codex", externalId: key, idempotencyKey: key,
    materials: [{ name: "m.md", text: MATERIAL }], parameters }).runId;
}
const human = { kind: "human" as const, id: "local-operator" };

it("材料按 ## 标题分段，段 id 是 <材料名>#<序号>", () => {
  const runId = newRun("sections");
  expect(stage.materialSections(runId, project)).toEqual(["m.md#1", "m.md#2", "m.md#3"]);
});

it("假层级整份拒收，并指出是哪个模块", () => {
  const runId = newRun("reject");
  const out = stage.writeModulePlan(runId, project, { modules: [
    { id: "market.header", evidence: ["m.md#1"] },
    { id: "market.book", evidence: ["m.md#2"] },
  ] }) as { status: string; errors: Array<{ code: string; jsonPointer: string }> };
  expect(out.status).toBe("blocked");
  expect(out.errors.map((e) => e.code)).toContain("module_fake_hierarchy");
  expect(out.errors[0]!.jsonPointer).toContain("market.header");
  expect(stage.modulePlanState(runId, project).exists).toBe(false);
});

it("没人认领的材料段是 warning，不拦提议——但会随提议一起记下来", () => {
  const runId = newRun("warn");
  const out = stage.writeModulePlan(runId, project, { modules: [{ id: "market", evidence: ["m.md#1"] }] }) as
    { status: string; findings: Array<{ code: string; sectionId?: string }> };
  expect(out.status).toBe("validated");
  expect(out.findings.filter((f) => f.code === "material_section_unclaimed").map((f) => f.sectionId)).toEqual(["m.md#2", "m.md#3"]);
});

it("冻结必须是人；机器带着 run 令牌来也不行", () => {
  const runId = newRun("freeze-human");
  stage.writeModulePlan(runId, project, { modules: [
    { id: "market", evidence: ["m.md#1"] },
    { id: "market.book", parentId: "market", evidence: ["m.md#2"] },
    { id: "market.trades", parentId: "market", evidence: ["m.md#3"] },
  ] });
  expect(() => stage.freezeModulePlan(runId, project, { kind: "agent", id: "planner" })).toThrow(/human/);
  const f = stage.freezeModulePlan(runId, project, human);
  expect(f.frozen).toBe(true);
  expect(f.openFindings).toBe(0);
});

it("未处理的 warning 不拦冻结，但要随冻结留痕", () => {
  const runId = newRun("freeze-open");
  stage.writeModulePlan(runId, project, { modules: [{ id: "market", evidence: ["m.md#1"] }] });
  const f = stage.freezeModulePlan(runId, project, human);
  expect(f.frozen).toBe(true);
  expect(f.openFindings).toBe(3); // 两段没人认领 + 一棵只有一个节点的「树」
  expect(f.openCodes).toEqual(expect.arrayContaining(["material_section_unclaimed", "module_tree_is_a_list"]));
});

it("冻结之后不再接受新的提议——再改就是新的一版", () => {
  const runId = newRun("frozen-locked");
  stage.writeModulePlan(runId, project, { modules: [{ id: "a", evidence: ["m.md#1"] }] });
  stage.freezeModulePlan(runId, project, human);
  expect(() => stage.writeModulePlan(runId, project, { modules: [{ id: "b", evidence: ["m.md#1"] }] })).toThrow(/frozen/);
});

it("没冻结的树不参与切单元：frozenModules 返回 undefined", () => {
  const runId = newRun("not-frozen");
  stage.writeModulePlan(runId, project, { modules: [{ id: "a", evidence: ["m.md#1"] }] });
  expect(stage.frozenModules(runId, project)).toBeUndefined();
  stage.freezeModulePlan(runId, project, human);
  expect(stage.frozenModules(runId, project)!.map((m) => m.id)).toEqual(["a"]);
});

/**
 * 提议了却没冻结的时候，故事单元不许被切出来（docs/v3/history/24 §8.1）。
 * 这条不在 work-units 那个套件里，是因为它判的是 `modules` 节点的人工闸门，不是单元循环本身。
 */
it("提议过但没冻结：领故事单元直接被拒，而不是悄悄换回规则包那棵树", async () => {
  const units = await import("../src/workUnits.js");
  const runId = newRun("unfrozen-blocks");
  stage.writeModulePlan(runId, project, { modules: [{ id: "a", evidence: ["m.md#1"] }] });
  expect(() => units.planUnits(runId, project, "stories")).toThrow(/module_plan_freeze_required/);
  /**
   * 冻结之后这道闸门就过了，而且**不需要产品模型**：一棵人认过的树本身就是切分依据。
   * 这条以前断言的是 `work_units_require_product_model`——那是限制，不是设计（docs/v3/history/24 §12）。
   */
  stage.freezeModulePlan(runId, project, human);
  expect(units.planUnits(runId, project, "stories").map((u) => u.unitId)).toEqual(["stories:a"]);
  const claimed = units.claimUnit(runId, project, { node: "stories" });
  expect(claimed.unit!.unitId).toBe("stories:a");
  // 没有产品模型的时候，单元材料里功能与规则是空的——空着比编一份假的产品模型诚实。
  expect(claimed.materials!.features).toEqual([]);
  expect(claimed.materials!.modules.map((m) => m.id)).toEqual(["a"]);
});

/**
 * 整份写入那条路上，冻结的树同样管用（docs/v3/history/24 §10）。
 * 这一条以前是个洞：`modules` 冻结了一棵树，规划器写故事时自带另一棵，没人拦。
 */
it("故事挂在冻结树里没有的模块上：整份写入被拒，指出是哪条故事", async () => {
  const stages = await import("../src/runStages.js");
  const runId = newRun("stories-vs-frozen", {}); // 整份写入那条路：这个 run 不开单元循环
  stage.writeModulePlan(runId, project, { modules: [
    { id: "market", evidence: ["m.md#1"] },
    { id: "market.book", parentId: "market", evidence: ["m.md#2"] },
    { id: "market.trades", parentId: "market", evidence: ["m.md#3"] },
  ] });
  stage.freezeModulePlan(runId, project, human);
  stages.loadRunInstructions(runId, project);
  stages.retrieveRunSpec(runId, project, { query: "内容", budgetTokens: 2000 });
  const story = (id: string, moduleIds: string[]) => ({ id, title: `${id} 的业务目的`, role: "交易者", benefit: "控制敞口",
    acceptance: ["前置：无持仓；触发：按产品规则操作；结果：状态按规则更新"], moduleIds, featureRefs: [], ruleRefs: [] });
  const bundle = (stories: unknown[]) => ({ origin: "host", flows: [], derivedFrom: "exploration",
    modules: [{ id: "market", name: "market", kind: "module", flowIds: [], routes: [] },
      { id: "market.book", name: "book", parentId: "market", kind: "submodule", flowIds: [], routes: [] },
      { id: "market.trades", name: "trades", parentId: "market", kind: "submodule", flowIds: [], routes: [] },
      // 规划器自带的那一棵多了一块：bundle 自洽，和冻结的那棵对不上——这正是要抓的那种。
      { id: "market.depth", name: "depth", parentId: "market", kind: "submodule", flowIds: [], routes: [] }], stories });

  const bad = stages.writeRunStage(runId, project, "stories", bundle([story("US-1", ["market.book"]),
    { ...story("US-2", []), moduleIds: ["market.depth"] }])) as { status: string; errors?: Array<{ code: string; jsonPointer: string }> };
  expect(bad.status).toBe("blocked");
  expect(bad.errors![0]!.code).toBe("story_module_unknown");
  expect(bad.errors![0]!.jsonPointer).toContain("US-2");

  // 挂对了就放行；扇出太低不拦，但要留下一份报告。
  const ok = stages.writeRunStage(runId, project, "stories",
    bundle([story("US-1", ["market.book"]), story("US-2", ["market.trades"])])) as { status: string };
  expect(ok.status).toBe("validated");
  // 扇出结论要回到写它的那一方手里，不能只落一份没人读的报告（docs/v3/history/24 §11）。
  expect((ok as unknown as { modulePlan?: Array<{ code: string }> }).modulePlan?.map((f) => f.code))
    .toContain("leaf_fanout_too_low");
  const report = service.runLedger().listRevisions(project, runId).find((r) => r.name === "report/module-fanout");
  expect(report).toBeDefined();
  expect((service.runLedger().readRevision(report!.id, project).content as { findings: Array<{ code: string }> }).findings
    .map((f) => f.code)).toContain("leaf_fanout_too_low");
});

/**
 * 沙箱探索的闸门（docs/v3/history/24 §14）：**只剩禁止名单**。
 * 2026-09-16 起点会改状态的东西不再要求每个环境勾一次——那些动作正是被测产品的功能；
 * 绝不能碰的地址仍然在禁止名单上，主网就在那上面。
 */
it("探索要 interact：禁止名单直接拒，其余放行", async () => {
  const ops = await import("../src/workflowOps.js");
  const { config } = await import("../src/procs.js");
  const base = { idempotencyKey: `ex-${Date.now()}`, sourceKind: "explore" as const, exploreActions: "interact" as const };
  const denied = config.guard.denyHosts[0];
  if (denied) await expect(ops.createWebWorkflow(project, { ...base, sourceUrl: `https://${denied}/trade` })).rejects.toThrow(/explore_host_denied/);
  const attempt = (key: string, sourceUrl: string) => ops.createWebWorkflow(project, { ...base, idempotencyKey: `${key}-${Date.now()}`, sourceUrl })
    .then(() => "created").catch((e: Error) => e.message);
  // 没有环境也照样能建（这里只验闸门，不真起浏览器）。
  expect(await attempt("ex-noenv", "http://127.0.0.1:5391/trade")).not.toMatch(/explore_interact_not_allowed|explore_host_denied/);
});

/**
 * 换了模块 id 就要重新认领功能，否则领域材料整份断在这里（docs/v3/history/24 §27）。
 *
 * 2026-09-12 实测：模型提了一棵新 id 的树，21 个功能一个都没接住；机检只记一条 warn，
 * 冻结之后每个故事单元 `features=0 / rules=0`——规则、观察、生命周期全没流下去，
 * 而故事看上去仍然「写出来了」。一个都没接住不是重新切树，是断了线。
 */
it("新树一个功能都没认领 → 整份拒收；认领了就放行", () => {
  const runId = newRun("reclaim");
  // 这个 run 有产品模型：功能挂在旧树的模块 id 上。
  service.runLedger().putRevision({ runId, projectId: project, name: "product/model-candidate", kind: "report", content: {
    modules: [{ id: "old", name: "旧", parentId: null }],
    features: [{ id: "f.one", moduleId: "old", name: "功能一" }, { id: "f.two", moduleId: "old", name: "功能二" }],
  } }, { kind: "system", id: "test" });
  const tree = (featureIds: string[]) => ({ modules: [
    { id: "m-a", name: "甲", parentId: null, purpose: "用户在这里做甲事", evidence: ["m.md#1"], featureIds },
    { id: "m-a.one", name: "甲之一", parentId: "m-a", purpose: "甲的第一件事", evidence: ["m.md#2"] },
    { id: "m-b", name: "乙", parentId: null, purpose: "用户在这里做乙事", evidence: ["m.md#3"] },
    { id: "m-b.one", name: "乙之一", parentId: "m-b", purpose: "乙的第一件事", evidence: ["m.md#3"] },
  ] });
  const dropped = stage.writeModulePlan(runId, project, tree([])) as { status: string; findings?: Array<{ code: string; severity: string }>; errors?: Array<{ code: string }> };
  expect(dropped.status).toBe("blocked");
  expect((dropped.errors ?? []).map((e) => e.code)).toContain("module_tree_drops_all_features");

  const ok = stage.writeModulePlan(runId, project, tree(["f.one", "f.two"])) as { status: string };
  expect(ok.status).toBe("validated");
});

/**
 * 2026-09-16：Hyperliquid 那一跑里 Claude 用了 43 次 Bash、25 次 Read，其中 15 次在读服务端源码
 * （`moduleStage.ts` / `modulePlan.ts` / `workflowControls.ts`），为的是搞清模块树要交什么、
 * 机检会怎么拒——因为 `modules` 这一步当时只发 `sections`，契约、规则、功能清单一样都没发。
 * 一跑 $6.39，而没有模块节点的那跑 $3.14。这三样现在当数据交出去。
 */
it("begin_stage(modules) 把契约、机检规则与功能清单一并交出去", () => {
  const runId = newRun("modules-contract");
  service.runLedger().putRevision({ runId, projectId: project, name: "product/model-candidate", kind: "report", content: {
    modules: [{ id: "m", name: "模块", parentId: null }],
    features: [{ id: "f.one", moduleId: "m", name: "功能一" }, { id: "f.two", moduleId: "m", name: "功能二" }],
  } }, { kind: "system", id: "test" });

  const begun = stage.beginStage ? stage.beginStage(runId, project, { node: "modules" }) : undefined;
  const out = (begun ?? controlsModule.beginStage(runId, project, { node: "modules" })) as {
    sections?: string[]; structureContract?: string; features?: Array<{ id: string; name?: string }>;
    checks?: Array<{ code: string; severity: string; means: string }>;
  };
  expect(out.sections).toEqual(["m.md#1", "m.md#2", "m.md#3"]);
  expect(out.structureContract).toMatch(/parentId/);
  expect(out.structureContract).toMatch(/EVERY FEATURE MUST BE CLAIMED BY A LEAF/);
  expect(out.features).toEqual([{ id: "f.one", name: "功能一", moduleId: "m" }, { id: "f.two", name: "功能二", moduleId: "m" }]);
  const codes = (out.checks ?? []).map((c) => c.code);
  expect(codes).toContain("module_fake_hierarchy");
  expect(codes).toContain("module_tree_drops_all_features");
  expect(codes).toContain("material_section_unclaimed");
  expect((out.checks ?? []).every((c) => ["error", "warn", "info"].includes(c.severity) && c.means.length > 0)).toBe(true);
});

it("没有产品模型时功能清单是空的，不报错", () => {
  const runId = newRun("modules-no-model");
  const out = controlsModule.beginStage(runId, project, { node: "modules" }) as { features?: unknown[]; structureContract?: string };
  expect(out.features).toEqual([]);
  expect(out.structureContract).toMatch(/AT LEAST TWO LEVELS/);
});

/**
 * 2026-09-16：Hyperliquid 那一跑的模块树冻结是 Claude 按用户当轮授权代按的，
 * 而账本里所有冻结都写成同一行 `frozenBy: local-operator`——事后看不出是人按还是代理代按。
 * 冻结现在收一条 note，并把「谁按的、什么时候、什么说明」一起回出去。
 */
it("冻结留下的痕迹要分得清人和代理", () => {
  const runId = newRun("freeze-note");
  service.runLedger().putRevision({ runId, projectId: project, name: "product/model-candidate", kind: "report", content: {
    modules: [{ id: "m", name: "模块", parentId: null }], features: [{ id: "f.one", moduleId: "m" }],
  } }, { kind: "system", id: "test" });
  stage.writeModulePlan(runId, project, { modules: [
    { id: "m-a", name: "甲", parentId: null, purpose: "用户在这里做甲事", evidence: ["m.md#1"], featureIds: ["f.one"] },
    { id: "m-a.one", name: "甲之一", parentId: "m-a", purpose: "甲的第一件事", evidence: ["m.md#2"] },
  ] });

  expect(stage.modulePlanState(runId, project)).toMatchObject({ exists: true, frozen: false });
  stage.freezeModulePlan(runId, project, { kind: "human", id: "local-operator" }, "由 Claude 代按：用户 2026-09-16 在对话中明确授权");
  const state = stage.modulePlanState(runId, project) as { frozen: boolean; frozenBy?: string; frozenNote?: string; frozenAt?: string };
  expect(state.frozen).toBe(true);
  expect(state.frozenBy).toBe("local-operator");
  expect(state.frozenNote).toMatch(/代按/);
  expect(state.frozenAt).toBeTruthy();
});
