import { beforeAll, afterAll, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * 工作单元循环（docs/v3/22）：拆分由服务端按产品模型做，规划器一次只领一个单元，
 * 校验只针对该单元的范围，全部完成后由代码合并。真实账本、临时数据目录、不调模型。
 */
let dir: string, project: string, service: typeof import("../src/runService.js"), db: typeof import("../src/db.js"),
  stages: typeof import("../src/runStages.js"), units: typeof import("../src/workUnits.js"),
  moduleStage: typeof import("../src/moduleStage.js");
let pack: import("@testpilot/harness-testing/domain").ProductRulePack, model: import("@testpilot/harness-testing/domain").ProductModel;

const packRaw = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../fixtures/perp-lab/rules.json"), "utf8"));

/** 一份「面板都试过、提交类被策略挡住」的合成回执，等价于真实探索的结果形状。 */
async function syntheticModel() {
  const d = await import("@testpilot/harness-testing/domain");
  const v = d.validateRulePack(packRaw);
  if (!v.ok) throw new Error("pack invalid");
  const charter = d.charterFromRulePack(v.pack, v.hash, { entryUrl: "http://127.0.0.1:5391/", maxScreens: 8 });
  const tracker = new d.CharterTracker(charter);
  const controls = [
    { display: "button: Limit", label: "Limit" }, { display: "button: Isolated", label: "Isolated" },
    { display: "input[checkbox]: Reduce Only", label: "Reduce Only" }, { display: "button: TP/SL", label: "TP/SL" },
    { display: "input[text]: Price (USDC)", label: "Price (USDC)" }, { display: "button: Place Order", label: "Place Order" },
  ].map((c) => ({ selector: `#${c.label.replace(/\W/g, "")}`, role: "", href: "", external: false, submit: false, clickable: true, fillable: false, state: "", ...c }));
  tracker.noteState("/", "/", controls, 0);
  const edges: Array<Record<string, unknown>> = [];
  for (let i = 0; ; i++) {
    const pick = tracker.next("/", controls);
    if (!pick) break;
    tracker.markAttempted(pick.target.stableId);
    const effect = { controlsAdded: pick.control.label === "TP/SL" ? ["input[text]: Take Profit Price"] : [], controlsRemoved: [], stateChanged: [`${pick.control.display}: （无） → cls:on`], textAdded: [] };
    edges.push({ from: "/", to: `/~${i + 1}`, action: { kind: "click", target: pick.control.label, selector: pick.control.selector }, ok: true, walked: true, effect });
    tracker.record({ targetId: pick.target.stableId, targetSpecId: pick.spec.id, featureId: pick.spec.featureId, status: "attempted", stateBefore: "/", stateAfter: `/~${i + 1}`, action: { kind: "click", target: pick.control.label, selector: pick.control.selector }, effect, controlsAfter: [...controls.map((c) => c.display), ...effect.controlsAdded], evidenceRefs: [`sfg:edge:${i}`], round: i + 1 });
  }
  const { StateFlowGraphSchema } = await import("@testpilot/harness-testing/exec");
  const graph = StateFlowGraphSchema.parse({ entry: "/", states: [{ id: "/", route: "/", title: "Perp", controls: [] }, ...edges.map((_, i) => ({ id: `/~${i + 1}`, route: "/", title: "Perp", controls: [] }))], transitions: edges, stoppedBecause: "", unvisited: [] });
  const report = tracker.report(graph, { kind: "dry", n: 3 }, { maxScreens: 8, screens: edges.length + 1, rounds: edges.length, maxRounds: 40 });
  return { pack: v.pack, hash: v.hash, report, model: d.buildProductModel({ pack: v.pack, report }) };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "tp-units-"));
  vi.stubEnv("TP_DATA_DIR", dir);
  vi.stubEnv("MIDSCENE_MODEL_NAME", "fixture"); vi.stubEnv("MIDSCENE_MODEL_BASE_URL", "https://fixture.test/v1"); vi.stubEnv("MIDSCENE_MODEL_API_KEY", "fixture-key");
  db = await import("../src/db.js"); service = await import("../src/runService.js");
  stages = await import("../src/runStages.js"); units = await import("../src/workUnits.js");
  moduleStage = await import("../src/moduleStage.js");
  project = db.createProject("Units", "http://127.0.0.1:5391/").id;
  const built = await syntheticModel();
  pack = built.pack; model = built.model;
});
afterAll(() => { service.runLedger().close(); db.db.close(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

function newRun(key: string, workUnits = 1) {
  const runId = service.registerHostRun(project, { runtime: "codex", externalId: key, idempotencyKey: key,
    materials: [{ name: "exploration.md", text: "Observed the BTC perp order panel: Limit / Stop Limit tabs, Cross and Isolated buttons, a Reduce Only checkbox and a TP/SL toggle." }],
    parameters: workUnits ? { workUnits: 1 } : {} }).runId;
  const ledger = service.runLedger();
  ledger.putRevision({ projectId: project, runId, name: `knowledge/rulepack/${pack.id}`, kind: "report", content: { name: `rulepack/${pack.id}`, roles: ["source", "stories", "cases"], trust: "user-provided", executable: false, rulePack: pack, rulePackHash: model.rulePack.hash } }, { kind: "system", id: "web" });
  ledger.putRevision({ projectId: project, runId, name: "product/model-candidate", kind: "report", content: model }, { kind: "system", id: "stage-validator" });
  stages.loadRunInstructions(runId, project);
  const ref = stages.retrieveRunSpec(runId, project, { query: "order panel", budgetTokens: 2000 }).chunks[0]!.id;
  return { runId, ref };
}

it("按产品模型的主模块拆故事单元，跨模块旅程排在最后并依赖它们", () => {
  const { runId } = newRun("plan");
  const planned = units.planUnits(runId, project, "stories");
  expect(planned.map((u) => u.unitId)).toEqual(["stories:trade-panel", "stories:order-lifecycle", "stories:position-risk", "stories:journeys"]);
  expect(planned[0]!.scope).toMatchObject({ kind: "module", moduleIds: expect.arrayContaining(["trade-panel", "trade-panel.order-entry", "trade-panel.risk"]) });
  expect(planned.at(-1)!.dependsOn).toHaveLength(3);
  // 幂等：再拆一次不会产生新单元。
  expect(units.planUnits(runId, project, "stories").map((u) => u.unitId)).toEqual(planned.map((u) => u.unitId));
});

it("领到的单元只带本模块的功能、规则与观察；其他模块的功能不在材料里", () => {
  const { runId } = newRun("claim");
  const first = units.claimUnit(runId, project, { node: "stories" });
  expect(first.unit!.unitId).toBe("stories:trade-panel");
  const ids = first.materials!.features.map((f) => f.id);
  expect(ids).toEqual(expect.arrayContaining(["order.type", "order.reduce-only", "order.margin-mode"]));
  expect(ids).not.toContain("order.submit");
  expect(ids).not.toContain("account.funding");
  expect(first.manifest!.knowledge[0]).toMatchObject({ packId: pack.id, purpose: "story acceptance basis" });
  expect(first.manifest!.isolationEvidence).toBe("host-best-effort");
  expect(first.materials!.rules.every((r) => first.unit!.scope.kind === "module" && first.unit!.scope.ruleIds.includes(r.id))).toBe(true);
  // 同一个单元没写完之前，领到的还是它。
  expect(units.claimUnit(runId, project, { node: "stories" }).unit!.unitId).toBe("stories:trade-panel");
});

it("越界写入被拒：别的模块、别的功能、缺角色或验收，都指出 jsonPointer 且只修这一个单元", () => {
  const { runId } = newRun("reject");
  const unit = units.claimUnit(runId, project, { node: "stories" }).unit!;
  const bad = units.writeUnit(runId, project, { unitId: unit.unitId, content: { stories: [
    { id: "US-1", title: "下单", acceptance: ["提交后成交"], role: "交易者", benefit: "建仓", moduleIds: ["order-lifecycle"], featureRefs: ["order.submit"], ruleRefs: ["R-SUBMIT-SIDE-EFFECT"] },
    { id: "US-2", title: "切限价", acceptance: [], moduleIds: ["trade-panel.order-entry"], featureRefs: ["order.type"], ruleRefs: [] },
  ] } }) as { status: string; errors: Array<{ code: string; jsonPointer: string }>; repairScope: string };
  expect(bad.status).toBe("blocked");
  const codes = bad.errors.map((e) => e.code);
  expect(codes).toEqual(expect.arrayContaining(["module_out_of_unit_scope", "feature_out_of_unit_scope", "rule_out_of_unit_scope", "story_without_acceptance", "story_without_role_or_benefit"]));
  expect(bad.repairScope).toBe(unit.unitId);
  expect(units.unitStatus(runId, project, "stories").units.find((u) => u.unitId === unit.unitId)!.status).toBe("failed");
  // 失败的单元可以重领重写，不影响别的单元。
  expect(units.claimUnit(runId, project, { node: "stories" }).unit!.unitId).toBe(unit.unitId);
});

const storiesFor = (unitId: string, n: number) => ({ stories: [{
  id: `US-${unitId.split(":")[1]}-${n}`, title: `在${unitId}里完成一件事`, role: "永续合约交易者", benefit: "控制敞口",
  acceptance: ["前置：账户无持仓；触发：切到该控件；结果：面板按产品规则更新"],
  moduleIds: [unitId.split(":")[1]!], featureRefs: [], ruleRefs: [],
}] });

it("逐个单元写完 → 服务端合并成整份 stories，并拒绝规划器直接整份写入", () => {
  const { runId } = newRun("merge");
  expect(() => stages.writeRunStage(runId, project, "stories", { stories: [{ id: "x", title: "y", acceptance: [] }] })).toThrow(/stage_requires_units/);
  for (;;) {
    const claimed = units.claimUnit(runId, project, { node: "stories" });
    if (!claimed.unit) { expect(claimed.instruction).toContain("All units are done"); break; }
    const u = claimed.unit;
    const scope = u.scope as { kind: string; moduleIds?: string[] };
    const moduleIds = u.unitId === "stories:journeys" ? ["trade-panel", "order-lifecycle"] : [scope.moduleIds![0]!];
    const out = units.writeUnit(runId, project, { unitId: u.unitId, content: { stories: [{
      id: `US-${u.unitId.replace(/\W/g, "-")}`, title: `${u.unitId} 的业务目的`, role: "永续合约交易者", benefit: "控制资金敞口",
      acceptance: ["前置：无持仓；触发：按产品规则操作；结果：状态按规则更新"], moduleIds,
      featureRefs: (claimed.materials!.features[0] ? [claimed.materials!.features[0].id] : []), ruleRefs: [],
    }] } }) as { status: string };
    expect(out.status).toBe("validated");
  }
  const merged = service.runLedger().listRevisions(project, runId).filter((r) => r.name === "validated/stories");
  expect(merged).toHaveLength(1);
  const bundle = service.runLedger().readRevision(merged[0]!.id, project).content as { stories: unknown[]; modules: unknown[]; origin: string };
  expect(bundle.origin).toBe("work-units");
  expect(bundle.stories).toHaveLength(4);
  expect(bundle.modules.length).toBe(model.modules.length);
});

it("旅程单元必须跨两个主模块，且不能重复模块单元里已有的故事 id", () => {
  const { runId } = newRun("journey");
  let journey: string | undefined;
  for (;;) {
    const c = units.claimUnit(runId, project, { node: "stories" });
    if (!c.unit) break;
    if (c.unit.unitId === "stories:journeys") { journey = c.unit.unitId; 
      const single = units.writeUnit(runId, project, { unitId: journey, content: { stories: [{ id: "US-J", title: "只挂一个模块", role: "交易者", benefit: "x", acceptance: ["a"], moduleIds: ["trade-panel"], featureRefs: [], ruleRefs: [] }] } }) as { status: string; errors: Array<{ code: string }> };
      expect(single.errors.map((e) => e.code)).toContain("journey_needs_two_modules");
      units.claimUnit(runId, project, { node: "stories" });
      const dup = units.writeUnit(runId, project, { unitId: journey, content: { stories: [{ id: "US-stories-trade-panel", title: "重复 id", role: "交易者", benefit: "x", acceptance: ["a"], moduleIds: ["trade-panel", "order-lifecycle"], featureRefs: [], ruleRefs: [] }] } }) as { errors: Array<{ code: string }> };
      expect(dup.errors.map((e) => e.code)).toContain("duplicate_story_id_across_units");
      break;
    }
    const scope = c.unit.scope as { moduleIds: string[] };
    units.writeUnit(runId, project, { unitId: c.unit.unitId, content: { stories: [{ id: `US-${c.unit.unitId.replace(/\W/g, "-")}`, title: "t", role: "交易者", benefit: "b", acceptance: ["a"], moduleIds: [scope.moduleIds[0]!], featureRefs: [], ruleRefs: [] }] } });
  }
  expect(journey).toBe("stories:journeys");
});

it("用例单元一条故事一个；规则 riskFloor 为 P0 时不许把优先级写低", () => {
  const { runId, ref } = newRun("cases");
  for (;;) {
    const c = units.claimUnit(runId, project, { node: "stories" });
    if (!c.unit) break;
    const scope = c.unit.scope as { kind: string; moduleIds?: string[] };
    const moduleIds = c.unit.unitId === "stories:journeys" ? ["trade-panel", "order-lifecycle"] : [scope.moduleIds![0]!];
    const feature = c.materials!.features.find((f) => f.ruleIds.some((r) => c.materials!.rules.find((x) => x.id === r)?.riskFloor === "P0"));
    units.writeUnit(runId, project, { unitId: c.unit.unitId, content: { stories: [{ id: `US-${c.unit.unitId.replace(/\W/g, "-")}`, title: "t", role: "交易者", benefit: "b", acceptance: ["a"], moduleIds, featureRefs: feature ? [feature.id] : [], ruleRefs: [] }] } });
  }
  const caseUnits = units.planUnits(runId, project, "cases");
  expect(caseUnits).toHaveLength(4);
  expect(caseUnits[0]!.scope).toMatchObject({ kind: "story" });
  const claimed = units.claimUnit(runId, project, { node: "cases" });
  const storyId = (claimed.unit!.scope as { storyId: string }).storyId;
  expect(claimed.materials!.story!.id).toBe(storyId);
  const p0Rule = claimed.materials!.rules.find((r) => r.riskFloor === "P0");
  const base = { storyId, title: "切到逐仓保证金", designMethod: "state-transition" as const, tier: 3 as const, steps: ["打开下单面板", "点 Isolated"], expected: "接口返回的保证金模式为 isolated", sourceRefs: [ref], featureRefs: [claimed.materials!.features[0]!.id] };
  if (p0Rule) {
    const low = units.writeUnit(runId, project, { unitId: claimed.unit!.unitId, content: { cases: [{ ...base, id: "TC-1", key: "k1", priority: "P1", ruleRefs: [p0Rule.id] }] } }) as { errors: Array<{ code: string }> };
    expect(low.errors.map((e) => e.code)).toContain("priority_below_rule_floor");
    units.claimUnit(runId, project, { node: "cases" });
  }
  const okOut = units.writeUnit(runId, project, { unitId: claimed.unit!.unitId, content: { cases: [{ ...base, id: "TC-1", key: "k1", priority: "P0", ruleRefs: p0Rule ? [p0Rule.id] : [] }] } }) as { status: string };
  expect(okOut.status).toBe("validated");
  // 别的故事的用例不能写进这个单元。
  units.claimUnit(runId, project, { node: "cases" });
  const wrong = units.writeUnit(runId, project, { unitId: units.unitStatus(runId, project, "cases").units.find((u) => u.status === "claimed")!.unitId, content: { cases: [{ ...base, id: "TC-2", key: "k2", storyId, priority: "P0", ruleRefs: [] }] } }) as { errors: Array<{ code: string }> };
  expect(wrong.errors.map((e) => e.code)).toContain("case_story_out_of_unit");
});

it("合并可以单独重试：最后一个单元写完之后整份校验失败，仍有入口重来", () => {
  const { runId } = newRun("merge-retry");
  for (;;) {
    const c = units.claimUnit(runId, project, { node: "stories" });
    if (!c.unit) break;
    const scope = c.unit.scope as { kind: string; moduleIds?: string[] };
    const moduleIds = c.unit.unitId === "stories:journeys" ? ["trade-panel", "order-lifecycle"] : [scope.moduleIds![0]!];
    units.writeUnit(runId, project, { unitId: c.unit.unitId, content: { stories: [{ id: `US-${c.unit.unitId.replace(/\W/g, "-")}`, title: "t", role: "交易者", benefit: "b", acceptance: ["a"], moduleIds, featureRefs: [], ruleRefs: [] }] } });
  }
  // 全部 done 之后，合并是幂等的：再调一次仍然返回同一份校验结果，而不是报「单元没写完」。
  const again = units.mergeUnits(runId, project, "stories") as { status: string };
  expect(again.status).toBe("validated");
});

it("没开 workUnits 的 run 照旧整份写入，不受影响", () => {
  const { runId } = newRun("legacy", 0);
  expect(units.unitStatus(runId, project).enabled).toBe(false);
  const out = stages.writeRunStage(runId, project, "stories", { stories: [{ id: "s1", title: "旧路径", acceptance: [] }] }) as { status: string };
  expect(out.status).toBe("validated");
  expect(() => units.planUnits(runId, project, "stories")).toThrow(/work_units_disabled_for_run/);
});

/**
 * 2026-09-11 第二轮实测暴露的范围缺陷（docs/v3/23 的 F-7）。
 */
it("故事自己声明的规则也进用例单元的范围——featureRefs 推不出来的那条不该被判越界", () => {
  const { runId, ref } = newRun("scope-rulerefs");
  // 这条故事的 featureRefs 只有 order.type，却显式声明了另一条同模块的规则
  // （「切了保证金模式之后这条故事才成立」）。它在故事单元的范围里，
  // 但按 featureRefs 反推的用例单元范围里没有——修复前引用它会被判越界。
  for (let guard = 0; ; guard++) {
    expect(guard).toBeLessThan(12);
    const c = units.claimUnit(runId, project, { node: "stories" });
    if (!c.unit) break;
    const scope = c.unit.scope as { kind: string; moduleIds?: string[] };
    const isPanel = c.unit.unitId === "stories:trade-panel";
    const moduleIds = c.unit.unitId === "stories:journeys" ? ["trade-panel", "order-lifecycle"] : [scope.moduleIds![0]!];
    const out = units.writeUnit(runId, project, { unitId: c.unit.unitId, content: { stories: [{
      id: `US-${c.unit.unitId.replace(/\W/g, "-")}`, title: "t", role: "交易者", benefit: "b",
      acceptance: ["前置：面板已加载；触发：切换控件；结果：面板按规则更新"],
      moduleIds, featureRefs: isPanel ? ["order.type"] : [],
      ruleRefs: isPanel ? ["R-MARGIN-MODE"] : [],
    }] } }) as { status: string };
    expect(out.status).toBe("validated");
  }
  const caseUnits = units.planUnits(runId, project, "cases");
  const target = caseUnits.find((u) => (u.scope as { storyId: string }).storyId === "US-stories-trade-panel")!;
  expect((target.scope as { ruleIds: string[] }).ruleIds).toContain("R-MARGIN-MODE");
  units.claimUnit(runId, project, { node: "cases" });
  const claimedId = units.unitStatus(runId, project, "cases").units.find((u) => u.status === "claimed")!.unitId;
  expect(claimedId).toBe(target.unitId);
  const out = units.writeUnit(runId, project, { unitId: target.unitId, content: { cases: [{
    id: "TC-SCOPE-1", storyId: "US-stories-trade-panel", title: "切到逐仓之后这条故事才成立",
    designMethod: "equivalence" as const, tier: 3 as const, steps: ["打开面板", "切到 Isolated"],
    expected: "接口返回的保证金模式为 isolated", key: "k-scope", sourceRefs: [ref],
    featureRefs: ["order.type"], ruleRefs: ["R-MARGIN-MODE"], priority: "P0" as const,
  }] } }) as { status: string; errors?: Array<{ code: string }> };
  expect(out.errors?.map((e) => e.code) ?? []).not.toContain("rule_out_of_unit_scope");
  expect(out.status).toBe("validated");
});

it("整份导入故事的 run 在 stories 节点没有单元可领，用例单元直接按导入的故事拆", async () => {
  const ops = await import("../src/workflowOps.js");
  const stories = { stories: [{ id: "US-IMPORT-1", title: "切到逐仓", role: "交易者", benefit: "隔离风险",
    acceptance: ["前置：面板已加载；触发：切到 Isolated；结果：该仓位的保证金与账户其余部分隔离"],
    moduleIds: ["trade-panel.risk"], featureRefs: ["order.margin-mode"], ruleRefs: ["R-MARGIN-MODE"] }], modules: [] };
  // 没开 workUnits 时拒绝导入：导入的意义就是让两条臂领到同一批单元。
  await expect(ops.createWebWorkflow(project, { idempotencyKey: "imp-no-units", sourceKind: "spec",
    materials: [{ name: "m.md", text: "面板有 Cross 与 Isolated。" }], importStories: stories })).rejects.toThrow(/imported_stories_require_work_units/);
});

/** 门禁 → 规划器的修复回路（docs/v3/23 F-11）与单元重试上限（F-8）。 */
it("门禁不通过时，被扣分的用例所在的单元重新打开，并带着门禁的话回来", () => {
  const { runId, ref } = newRun("repair-loop");
  for (let guard = 0; ; guard++) {
    expect(guard).toBeLessThan(12);
    const c = units.claimUnit(runId, project, { node: "stories" });
    if (!c.unit) break;
    const scope = c.unit.scope as { moduleIds?: string[] };
    const moduleIds = c.unit.unitId === "stories:journeys" ? ["trade-panel", "order-lifecycle"] : [scope.moduleIds![0]!];
    units.writeUnit(runId, project, { unitId: c.unit.unitId, content: { stories: [{
      id: `US-${c.unit.unitId.replace(/\W/g, "-")}`, title: "t", role: "交易者", benefit: "b",
      acceptance: ["前置：面板已加载；触发：切换控件；结果：面板按规则更新"], moduleIds, featureRefs: [], ruleRefs: [] }] } });
  }
  const caseUnits = units.planUnits(runId, project, "cases");
  for (const u of caseUnits) {
    units.claimUnit(runId, project, { node: "cases" });
    const claimed = units.unitStatus(runId, project, "cases").units.find(x => x.status === "claimed")!;
    const storyId = (caseUnits.find(x => x.unitId === claimed.unitId)!.scope as { storyId: string }).storyId;
    units.writeUnit(runId, project, { unitId: claimed.unitId, content: { cases: [{
      id: `TC-${claimed.unitId.replace(/\W/g, "-")}`, storyId, title: "切到逐仓", designMethod: "state-transition" as const,
      tier: 3 as const, steps: ["打开面板", "点 Isolated"], expected: "接口返回的保证金模式为 isolated",
      key: `k-${claimed.unitId}`, sourceRefs: [ref], priority: "P0" as const }] } });
  }
  const someCase = `TC-${caseUnits[0]!.unitId.replace(/\W/g, "-")}`;
  const out = units.reopenUnitsFromGate(runId, project, [
    { caseId: someCase, rule: "tier-unbacked", severity: "warn", message: "claims tier 1 but carries no oracle" },
    { caseId: someCase, rule: "oracle-vague", severity: "info", message: "只是提醒，不该重开单元" },
    { caseId: "TC-NOT-OURS", rule: "tier-unbacked", severity: "warn", message: "别的 run 的用例" },
  ]);
  expect(out.reopened).toEqual([caseUnits[0]!.unitId]);
  expect(out.round).toBe(1);
  // 重新领到的就是它，而且带着门禁那句话；契约里也写进去了。
  const again = units.claimUnit(runId, project, { node: "cases" });
  expect(again.unit!.unitId).toBe(caseUnits[0]!.unitId);
  expect(again.repair!.cases.map(c => c.rule)).toEqual(["tier-unbacked"]);
  expect(again.contract).toContain("REPAIR ROUND 1");
  expect(again.contract).toContain(someCase);
});

it("同一个单元最多重来 5 次，之后交给人——不再无限发回", () => {
  const { runId } = newRun("attempt-cap");
  const bad = { stories: [{ id: "US-BAD", title: "t", acceptance: [], moduleIds: ["order-lifecycle"] }] };
  let last: ReturnType<typeof units.claimUnit> | undefined;
  // 一个单元到顶之后会换下一个单元，所以要把这一节点的所有单元都撞到顶。
  for (let i = 0; i < units.MAX_UNIT_ATTEMPTS * 6; i++) {
    last = units.claimUnit(runId, project, { node: "stories" });
    if (!last.unit) break;
    units.writeUnit(runId, project, { unitId: last.unit.unitId, content: bad });
  }
  const status = units.unitStatus(runId, project, "stories");
  expect(status.units.every((u) => u.attempt <= units.MAX_UNIT_ATTEMPTS)).toBe(true);
  expect(last!.unit).toBeNull();
  expect(last!.instruction).toContain(`after ${units.MAX_UNIT_ATTEMPTS} attempts`);
  expect(last!.instruction).toContain("A person has to look at these");
});

/**
 * `modules` 节点和单元循环的接缝（docs/v3/24 §6）。
 * 冻结过的树决定单元怎么切；没冻结的提议一点作用都没有。
 */
it("冻结过的模块树压过规则包里那一棵：单元按新的根切", () => {
  const { runId } = newRun("frozen-tree");
  // 把规则包里三个根收到一个新根下面——单元数应该从 4 掉到 1。
  const tree = [{ id: "perp", name: "永续合约交易", evidence: [] },
    ...model.modules.map((m) => ({ id: m.id, name: m.name, parentId: m.parentId ?? "perp", evidence: [] }))];
  const proposed = moduleStage.writeModulePlan(runId, project, { modules: tree }) as { status: string };
  expect(proposed.status).toBe("validated");
  // 只提议不冻结的时候，谁都别想往下走：不回落到规则包那棵树，直接拒绝切单元。
  expect(() => units.planUnits(runId, project, "stories")).toThrow(/module_plan_freeze_required/);

  const { runId: second } = newRun("frozen-tree-2");
  moduleStage.writeModulePlan(second, project, { modules: tree });
  moduleStage.freezeModulePlan(second, project, { kind: "human", id: "local-operator" });
  const planned = units.planUnits(second, project, "stories");
  expect(planned.map((u) => u.unitId)).toEqual(["stories:perp"]);
  // 换的是分组，不是内容：功能与规则一个都没少。
  expect((planned[0]!.scope as { featureIds: string[] }).featureIds).toHaveLength(model.features.length);
});

it("故事单元可以提议修树：单独落一份修订，但一个字都不进 validated/stories", () => {
  const { runId } = newRun("amendments");
  const first = units.claimUnit(runId, project, { node: "stories" }).unit!;
  const scope = first.scope as { moduleIds: string[] };
  const out = units.writeUnit(runId, project, { unitId: first.unitId, content: {
    stories: [{ id: "US-A-1", title: "在下单面板里完成一件事", role: "永续合约交易者", benefit: "控制敞口",
      acceptance: ["前置：无持仓；触发：按产品规则操作；结果：状态按规则更新"],
      moduleIds: [scope.moduleIds[0]!], featureRefs: [], ruleRefs: [] }],
    moduleAmendments: [{ kind: "missing-module", reason: "资金费率结算这条故事在树里没有落点", storyId: "US-A-1", evidence: ["exploration.md#1"] }],
  } }) as { status: string };
  expect(out.status).toBe("validated");

  const ledger = service.runLedger();
  const amendment = ledger.listRevisions(project, runId).find((r) => r.name === `module-amendment/${first.unitId}`);
  expect(amendment).toBeDefined();
  expect((ledger.readRevision(amendment!.id, project).content as { amendments: unknown[] }).amendments).toHaveLength(1);
  // 单元产物里也不能有：合并之后的整份故事不带修树提议。
  const unitRev = ledger.listRevisions(project, runId).find((r) => r.name === `units/stories/${first.unitId}`);
  expect(JSON.stringify(ledger.readRevision(unitRev!.id, project).content)).not.toContain("moduleAmendments");
});

/**
 * 判据里的出处要真的存在（docs/v3/24 §33）。
 *
 * 契约要求每条判据以「（依据 file.md#N）」收尾，"说不出出处的判据是猜的"，
 * 而服务端只核对模块的 evidence，不核对故事判据里的那个 N。
 *
 * 注意这个写法有**两套编号**：材料分节（## / ===== 数出来的）与 retrieve_spec 的检索块，
 * 同一份材料可以是 24 与 50。所以只有两套都容不下的号才算不存在——
 * 第一版只比对分节数，把合法的检索块 id 误判成了「不存在的段」。
 */
it("判据引了材料里不存在的段 → 这一单元打回", () => {
  const { runId } = newRun("cite");
  // 这一条要能数出段来才查得了；夹具的默认材料没有分节符（段数 0 时本检查按设计跳过）。
  service.runLedger().putRevision({ projectId: project, runId, name: "sections.md", kind: "material",
    content: "# 材料\n\n## 一段\n内容\n\n## 二段\n内容\n" }, { kind: "system", id: "test" });
  const c = units.claimUnit(runId, project, { node: "stories" });
  const scope = c.unit!.scope as { moduleIds: string[] };
  const story = (acceptance: string) => ({ stories: [{
    id: "US-CITE", title: "t", role: "交易者", benefit: "b", acceptance: [acceptance],
    moduleIds: [scope.moduleIds[0]!], featureRefs: [], ruleRefs: [] }] });
  // sections.md 只有两段；检索索引这一侧的块数也远小于 99（两套编号都容不下才算真的不存在）
  const bad = units.writeUnit(runId, project, { unitId: c.unit!.unitId, content: story("前置：无 / 触发：点 / 结果：变（依据 sections.md#99）") }) as
    { status: string; errors: Array<{ code: string }> };
  expect(bad.status).toBe("blocked");
  expect(bad.errors.map((e) => e.code)).toContain("acceptance_cites_missing_section");
  units.claimUnit(runId, project, { node: "stories" });
  const ok = units.writeUnit(runId, project, { unitId: c.unit!.unitId, content: story("前置：无 / 触发：点 / 结果：变（依据 sections.md#2）") }) as { status: string };
  expect(ok.status).toBe("validated");
});

/**
 * 2026-09-16：40 个单元的 claim 返回合计 110 万字符，其中领域参考 40 次完全相同、
 * storyIndex 只有两种取值、角色与词表各只有一种——整跑级事实被逐单元重发了 39 遍，
 * 而每一轮都算进 cache_read（那一跑 7,780 万 token 缓存读、$36，output 只有 3,200）。
 * 它们现在只在 load_run_instructions 发一次。
 */
it("claim_unit 不重发整跑级材料，load_run_instructions 发一次", () => {
  const { runId } = newRun("slim-claim");
  // newRun 内部已经调过一次 load_run_instructions；它幂等，第二次返回同一份回执。
  const instructions = stages.loadRunInstructions(runId, project) as { runScope?: Record<string, unknown> };
  expect(instructions.runScope).toBeTruthy();
  const scope = instructions.runScope!;
  // 这份夹具本来就没有领域参考、角色与词表，所以只验形状：字段在、类型对。
  expect(typeof scope.domainReference).toBe("string");
  for (const arrayField of ["actionVocabulary", "volatileReadings", "roles"]) expect(Array.isArray(scope[arrayField])).toBe(true);

  const claimed = units.claimUnit(runId, project, { node: "stories" }) as { materials?: Record<string, unknown>; runScope?: string };
  // 只剔大的：领域参考全文占被剔总量的 91.5%，它整跑发一次就够。
  for (const gone of ["domainReference", "productModelRevision"]) expect(claimed.materials).not.toHaveProperty(gone);
  /*
   * 词表必须留在单元材料里。2026-09-16 的 A/B 把它一起剔掉过，同项目同模块树下
   * 动作型验收准则从 64.3% 掉到 37.7%、`story_has_no_actionable_criterion` 从 0 变 5：
   * 词表既是判定动作型的尺子，也是模型写单元时眼前唯一的动词来源。它只有 46 字符。
   */
  for (const kept of ["features", "rules", "modules", "actionVocabulary", "volatileReadings", "roles", "rulePack"])
    expect(claimed.materials).toHaveProperty(kept);
  expect(claimed.runScope).toMatch(/load_run_instructions/);
});
