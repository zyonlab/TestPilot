import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CharterTracker, buildExplorationReport, buildProductModel, charterFromRulePack, coverageOfGraph, validateRulePack,
  ContextManifestSchema, manifestBlockers, type ControlLike, type ProductRulePack,
} from "../src/domain/index.js";
import { StateFlowGraphSchema, type StateFlowGraph } from "../src/exec/sfg.js";

/**
 * 探索回执、覆盖计数与产品模型（docs/v3/history/21 §8 反例 2、3、5、7、9、10、11）。
 * 全部喂合成数据，不开浏览器、不问模型；同一套函数在真实探索里跑。
 */
const packPath = resolve(import.meta.dirname, "../../../fixtures/perp-lab/rules.json");
const pack = (() => { const v = validateRulePack(JSON.parse(readFileSync(packPath, "utf8"))); if (!v.ok) throw new Error("pack"); return v; })();
const charter = charterFromRulePack(pack.pack, pack.hash, { entryUrl: "http://127.0.0.1:5391/", maxScreens: 8 });

const ctl = (display: string, label: string, over: Partial<ControlLike> = {}): ControlLike => ({
  display, label, selector: `#${label.toLowerCase().replace(/[^a-z]/g, "")}`, role: "", href: "", external: false, submit: false, clickable: display.startsWith("button"), fillable: display.startsWith("input[text]"), state: "", ...over,
});
const entryControls: ControlLike[] = [
  ctl("button[button]: Market", "Market", { state: "cls:on" }),
  ctl("button[button]: Limit", "Limit"),
  ctl("button[button]: Stop Limit", "Stop Limit"),
  ctl("button[button]: Cross", "Cross", { state: "pressed=true" }),
  ctl("button[button]: Isolated", "Isolated", { state: "pressed=false" }),
  ctl("input[text]: Price (USDC)", "Price (USDC)"),
  ctl("input[text]: Leverage", "Leverage"),
  ctl("input[checkbox]: Reduce Only", "Reduce Only", { clickable: false, state: "checked=false" }),
  ctl("button[button]: TP/SL", "TP/SL", { state: "pressed=false" }),
  ctl("button[button]: Place Order", "Place Order"),
  ctl("button[button]: Close Position", "Close Position"),
  ctl("button[button]: Cancel All", "Cancel All"),
];
const graphOf = (edges: StateFlowGraph["transitions"], states: string[] = ["/"]): StateFlowGraph =>
  StateFlowGraphSchema.parse({ abstraction: "route+controls+state/norm", collector: "aria-roles/v2", entry: states[0], states: states.map((id) => ({ id, route: id.split("~")[0], title: "Perp Demo", controls: [] })), transitions: edges, stoppedBecause: "", unvisited: [] });

describe("覆盖计数由代码算", () => {
  it("50 条边、7 条走过：walked 分子是 7，43 条 observed-only 不计入", () => {
    const edges: StateFlowGraph["transitions"] = [];
    for (let i = 0; i < 7; i++) edges.push({ from: "/a", to: `/b${i}`, action: { kind: "goto", target: `/b${i}`, selector: "" }, ok: true, walked: true, effect: { controlsAdded: ["x"], controlsRemoved: [], stateChanged: [], textAdded: [] } });
    for (let i = 0; i < 43; i++) edges.push({ from: "/a", to: `/b${i % 7}`, action: { kind: "goto", target: `/b${i}`, selector: "" }, ok: true, walked: false });
    const c = coverageOfGraph(graphOf(edges, ["/a", ...Array.from({ length: 7 }, (_, i) => `/b${i}`)]));
    expect(c).toMatchObject({ edgesSeen: 43, edgesWalked: 7, transitionsAsserted: 7, statesSeen: 8, visitedUrls: 8 });
  });

  const audited = resolve(import.meta.dirname, "../../../docs/v3/evidence/domain-material-audit-2026-09-10/exploration-graph.json");
  it.skipIf(!existsSync(audited))("2026-09-10 审计里的真实 Hyperliquid 探索图：8 状态 / 50 边 / 7 走过", () => {
    const g = JSON.parse(readFileSync(audited, "utf8")) as { states: unknown[]; transitions: unknown[] };
    const c = coverageOfGraph({ states: g.states as StateFlowGraph["states"], transitions: g.transitions as StateFlowGraph["transitions"] });
    expect(c.statesSeen).toBe(8);
    expect(c.edgesWalked).toBe(7);
    expect(c.edgesSeen).toBe(43);
  });
});

describe("CharterTracker：看见 ≠ 试过", () => {
  it("入口页登记目标：ui-only 可点，state-change 立即 blocked，observe-only 立即完成", () => {
    const t = new CharterTracker(charter);
    const found = t.noteState("/", "/", entryControls, 0);
    expect(found.map((f) => f.targetSpecId)).toEqual(expect.arrayContaining(["T-ORDER-TYPE-LIMIT", "T-MARGIN-ISOLATED", "T-REDUCE-ONLY", "T-TPSL", "T-PLACE-ORDER", "T-LEVERAGE-INPUT"]));
    const status = (id: string) => t.observations.filter((o) => o.targetSpecId === id).map((o) => `${o.status}:${o.reason}`);
    expect(status("T-PLACE-ORDER")).toEqual(["blocked:policy:side_effect"]);
    expect(status("T-CLOSE-POSITION")).toEqual(["blocked:policy:side_effect"]);
    expect(status("T-LEVERAGE-INPUT")).toEqual(["observed_only:observe_only"]);
    expect(status("T-ORDER-TYPE-LIMIT")).toEqual([]);
  });

  it("下一步按领域顺序挑，不按 DOM 顺序；当前已选中的 Market 跳过", () => {
    const t = new CharterTracker(charter);
    t.noteState("/", "/", entryControls, 0);
    const first = t.next("/", entryControls)!;
    expect(first.spec.id).toBe("T-ORDER-TYPE-LIMIT");
    expect(t.observations.some((o) => o.targetSpecId === "T-ORDER-TYPE-MARKET" && o.status === "skipped_equivalent")).toBe(false);
    t.markAttempted(first.target.stableId);
    expect(t.next("/", entryControls)!.spec.id).toBe("T-ORDER-TYPE-STOP");
  });

  it("到 8 屏上限、还有目标没试：partial + frontier，不能说完成探索", () => {
    const t = new CharterTracker(charter);
    t.noteState("/", "/", entryControls, 0);
    const pick = t.next("/", entryControls)!;
    t.markAttempted(pick.target.stableId);
    t.record({ targetId: pick.target.stableId, targetSpecId: pick.spec.id, featureId: pick.spec.featureId, status: "attempted", stateBefore: "/", stateAfter: "/~1", action: { kind: "click", target: "Limit", selector: "#limit" }, effect: { controlsAdded: [], controlsRemoved: [], stateChanged: ["button[button]: Limit: （无） → cls:on"], textAdded: [] }, controlsAfter: [], evidenceRefs: ["sfg:edge:0"], round: 1 });
    const edges: StateFlowGraph["transitions"] = [{ from: "/", to: "/~1", action: { kind: "click", target: "Limit", selector: "#limit" }, ok: true, walked: true, effect: { controlsAdded: [], controlsRemoved: [], stateChanged: ["x"], textAdded: [] } }];
    const r = t.report(graphOf(edges, ["/", "/~1"]), { kind: "screenCap", n: 8 }, { maxScreens: 8, screens: 8, rounds: 12, maxRounds: 40 });
    expect(r.completion).toBe("partial");
    expect(r.frontier.map((f) => f.targetSpecId)).toEqual(expect.arrayContaining(["T-MARGIN-ISOLATED", "T-REDUCE-ONLY", "T-TPSL"]));
    expect(r.coverage).toMatchObject({ targetsAttempted: 1, targetsBlocked: 3, edgesWalked: 1 });
    expect(r.plannedTargets.find((p) => p.targetSpecId === "T-FUNDING")).toMatchObject({ status: "not_found", reason: "not_found_in_scope" });
    expect(r.unknowns.join("\n")).toContain("T-FUNDING");
  });
});

/** 一次「全部目标都做完」的合成回执，供产品模型用。 */
function fullReport(opts: { tpslReveals: boolean }) {
  const t = new CharterTracker(charter);
  t.noteState("/", "/", entryControls, 0);
  const edges: StateFlowGraph["transitions"] = [];
  let round = 0;
  for (;;) {
    const pick = t.next("/", entryControls);
    if (!pick) break;
    round += 1;
    t.markAttempted(pick.target.stableId);
    const label = pick.control.label;
    const effect = {
      controlsAdded: label === "Stop Limit" ? ["input[text]: Trigger Price (USDC)"] : label === "TP/SL" && opts.tpslReveals ? ["input[text]: Take Profit Price (USDC)", "input[text]: Stop Loss Price (USDC)"] : [],
      controlsRemoved: [],
      stateChanged: [
        label === "Limit" || label === "Stop Limit" || label === "Market" ? `button[button]: ${label}: （无） → cls:on` :
        label === "Isolated" || label === "Cross" ? `button[button]: ${label}: pressed=false → pressed=true` :
        label === "Reduce Only" ? "input[checkbox]: Reduce Only: checked=false → checked=true" :
        "button[button]: TP/SL: pressed=false → pressed=true",
      ],
      textAdded: [],
    };
    edges.push({ from: "/", to: `/~${round}`, action: { kind: "click", target: label, selector: pick.control.selector }, ok: true, walked: true, effect });
    t.record({ targetId: pick.target.stableId, targetSpecId: pick.spec.id, featureId: pick.spec.featureId, status: "attempted", stateBefore: "/", stateAfter: `/~${round}`, action: { kind: "click", target: label, selector: pick.control.selector }, effect, controlsAfter: [...entryControls.map((c) => c.display), ...effect.controlsAdded], evidenceRefs: [`sfg:edge:${edges.length - 1}`], round });
  }
  return t.report(graphOf(edges, ["/", ...edges.map((_, i) => `/~${i + 1}`)]), { kind: "dry", n: 3 }, { maxScreens: 12, screens: edges.length + 1, rounds: round, maxRounds: 60 });
}

describe("ProductModel：功能是 confirmed / unverified / blocked / conflicted 中哪一种", () => {
  it("健康 fixture：面板功能 confirmed，提交类 blocked，输入类 unverified，未发现的 funding 是 blocked 而不是 not_applicable", () => {
    const r = fullReport({ tpslReveals: true });
    expect(r.completion).toBe("complete");
    const m = buildProductModel({ pack: pack.pack, report: r });
    const v = (id: string) => m.features.find((f) => f.id === id)!;
    expect(v("order.type").verification).toBe("confirmed");
    expect(v("order.margin-mode").verification).toBe("confirmed");
    expect(v("order.reduce-only").verification).toBe("confirmed");
    expect(v("order.tpsl").verification).toBe("confirmed");
    expect(v("order.submit")).toMatchObject({ verification: "blocked", verificationReason: expect.stringContaining("policy:side_effect") });
    expect(v("order.leverage").verification).toBe("unverified");
    expect(v("account.funding")).toMatchObject({ verification: "blocked", applicability: "unresolved", verificationReason: expect.stringContaining("not observed ≠ not applicable") });
    const b = (id: string) => m.ruleBindings.find((x) => x.ruleId === id)!;
    expect(b("R-MARGIN-MODE").status).toBe("verified");
    expect(b("R-TPSL-PANEL").status).toBe("verified");
    // 接口类规则不是探索能验证的：UI 有入口不等于金融规则已核。
    expect(b("R-REDUCE-ONLY-EXEC").status).toBe("not_explorable");
    expect(b("R-LEVERAGE-RANGE").status).toBe("unverified");
    expect(b("R-REDUCE-ONLY-DOMAIN").status).toBe("open");
    expect(m.conflicts).toEqual([]);
    expect(m.summary).toMatchObject({ confirmed: 4, conflicted: 0, inconclusive: 0 });
    expect(m.claims.filter((c) => c.claimType === "hypothesis").every((c) => c.support === "unresolved")).toBe(true);
  });

  it("通道瞎了不算冲突：整次探索一条选中态都取不到时，依赖它的规则是 inconclusive", () => {
    const r = fullReport({ tpslReveals: true });
    // 模拟 app.hyperliquid.xyz：无 ARIA、class 是构建哈希，采集器取不到任何选中态。
    const blind = { ...r, observations: r.observations.map((o) => (o.effect ? { ...o, effect: { ...o.effect, stateChanged: [] } } : o)) };
    const m = buildProductModel({ pack: pack.pack, report: blind });
    const b = (id: string) => m.ruleBindings.find((x) => x.ruleId === id)!;
    expect(b("R-MARGIN-MODE")).toMatchObject({ status: "inconclusive", reason: expect.stringContaining("evidence channel unavailable") });
    expect(m.features.find((f) => f.id === "order.margin-mode")!.verification).toBe("inconclusive");
    expect(m.conflicts).toEqual([]);
    // 半份证据也不算验证通过：TP/SL 的面板确实出现了（控件通道可判），
    // 但「开关变成选中」取不到，理由里只列瞎掉的那一维。
    expect(b("R-TPSL-PANEL")).toMatchObject({ status: "inconclusive", reason: expect.stringContaining("stateChanged") });
    expect(b("R-TPSL-PANEL").reason).not.toContain("controlsPresent");
    expect(m.claims.find((c) => c.ruleId === "R-MARGIN-MODE")!.support).toBe("unresolved");
  });

  it("tpsl-panel 缺陷：开关变了状态、面板没出来 → 规则 contradicted，功能 conflicted，两边证据都保留", () => {
    const m = buildProductModel({ pack: pack.pack, report: fullReport({ tpslReveals: false }) });
    expect(m.features.find((f) => f.id === "order.tpsl")!.verification).toBe("conflicted");
    expect(m.ruleBindings.find((x) => x.ruleId === "R-TPSL-PANEL")).toMatchObject({ status: "conflicted", reason: expect.stringContaining("controlsPresent:Take profit") });
    expect(m.conflicts).toHaveLength(1);
    expect(m.conflicts[0]!.observed).toContain("pressed=false → pressed=true");
    expect(m.claims.find((c) => c.ruleId === "R-TPSL-PANEL")!.support).toBe("contradicted");
    // 其他功能不受影响：一个冲突不会把整张图染红。
    expect(m.features.find((f) => f.id === "order.margin-mode")!.verification).toBe("confirmed");
  });

  it("回执的规则包哈希跟着 charter 走；换了包就不能拿旧回执建模", () => {
    const r = fullReport({ tpslReveals: true });
    expect(r.rulePack.hash).toBe(pack.hash);
    const other: ProductRulePack = { ...pack.pack, version: "other" };
    const v = validateRulePack(other);
    expect(v.ok && v.hash !== pack.hash).toBe(true);
  });
});

describe("ContextManifest v2", () => {
  it("缺必需规则 → 阻断原因，而不是空数组继续", () => {
    const m = ContextManifestSchema.parse({ schemaVersion: "context-manifest.v2", manifestId: "ctx-1", node: "source", attempt: 0, role: { id: "explorer-planner", version: "1" }, isolationEvidence: "service-scoped", truncation: { omittedOptionalRefs: [], missingRequiredRefs: ["R-REDUCE-ONLY-UI"] } });
    expect(manifestBlockers(m)).toEqual(["missing_required_ref:R-REDUCE-ONLY-UI"]);
    expect(() => ContextManifestSchema.parse({ schemaVersion: "context-manifest.v2", manifestId: "ctx-1", node: "source", attempt: 0, role: { id: "x", version: "1" }, isolationEvidence: "strict" })).toThrow();
  });
});

describe("buildExplorationReport 直接调用", () => {
  it("没有任何目标被发现时全部 not_found，completion 仍按停止原因判", () => {
    const r = buildExplorationReport({ charter, graph: graphOf([]), targets: [], observations: [], stop: { kind: "dry", n: 3 }, budget: { maxScreens: 8, screens: 1, rounds: 3, maxRounds: 40 } });
    expect(r.coverage.targetsNotFound).toBe(charter.featureTargets.length);
    expect(r.completion).toBe("complete");
    expect(r.unknowns).toHaveLength(charter.featureTargets.length);
  });
});

/**
 * 闸门不是确证（docs/v3/history/24 §21）。
 * 实测：探索点「全仓」弹出保证金弹窗、点「Place Order」弹出确认框，
 * 回执里都有「新控件」，于是两个功能都被判成 confirmed——而保证金一次没切成、订单一张没下。
 */
describe("闸门文案：点出一道门不算把功能验了", () => {
  const pack = (extra: Record<string, unknown> = {}) => ({
    schemaVersion: "product-rule-pack.v1", id: "p", version: "1", domain: "d", product: "p", network: "n",
    accountMode: "m", sources: [{ id: "SRC", kind: "official-doc", locator: "https://x.test", fetchedAt: "2026-09-12" }],
    modules: [{ id: "m1", name: "M", parentId: null }],
    features: [{ id: "f1", moduleId: "m1", name: "提交" }],
    rules: [], targets: [{ id: "T1", featureId: "f1", match: { label: ["^Place Order$"] } }], ...extra,
  });
  const reportWith = (added: string[]) => ({
    schemaVersion: "exploration-report.v1", charterId: "c", entryUrl: "https://x.test/", rulePack: { id: "p", version: "1", hash: "h" },
    stateAbstraction: "route", states: [{ id: "/", route: "/", title: "t" }], targets: [], plannedTargets: [],
    observations: [{ id: "o1", targetId: "/::T1::Place Order", targetSpecId: "T1", featureId: "f1", status: "attempted",
      stateBefore: "/", round: 1, controlsAfter: [], evidenceRefs: [], effect: { controlsAdded: added, controlsRemoved: [], stateChanged: [], textAdded: [] } }],
    frontier: [], coverage: {}, budget: {}, completion: {}, stopReason: "exhausted",
  });
  const verdict = (gateLabels: string[], added: string[]) => {
    const v = validateRulePack(pack(gateLabels.length ? { gateLabels } : {}));
    if (!v.ok) throw new Error(JSON.stringify(v.errors.slice(0, 2)));
    const model = buildProductModel({ pack: v.pack, report: reportWith(added) as never });
    return model.features[0]!;
  };

  it("效果里出现闸门文案 → inconclusive，并说出卡在哪一道", () => {
    const f = verdict(["Confirm Order"], ["button: Confirm Order"]);
    expect(f.verification).toBe("inconclusive");
    expect(f.verificationReason).toContain("Confirm Order");
  });
  it("同样的效果，没声明闸门文案时仍然算 confirmed——这条规矩跟着产品走", () => {
    expect(verdict([], ["button: Confirm Order"]).verification).toBe("confirmed");
  });
  it("效果不是闸门 → 照旧 confirmed", () => {
    expect(verdict(["Confirm Order"], ["div: Isolated"]).verification).toBe("confirmed");
  });
  /**
   * 声明了「点完屏幕上该出现什么」，就以屏幕为准（docs/v3/history/24 §24.3）。
   *
   * 2026-09-12 实测：机器臂走完整条下单链、点了弹窗里的确认键，这里判 confirmed，
   * 数的却是上一步「弹窗打开了」那个效果；同一时刻账户页上是「尚无开放仓位」。
   * 「有个控件响应了」不是「订单提交了」。
   */
  const expecting = (added: string[], expectOnScreen: string[]) => {
    const v = validateRulePack(pack({ targets: [{ id: "T1", featureId: "f1", match: { label: ["^Place Order$"] }, expectOnScreen }] }));
    if (!v.ok) throw new Error(JSON.stringify(v.errors.slice(0, 2)));
    return buildProductModel({ pack: v.pack, report: reportWith(added) as never }).features[0]!;
  };

  it("点了，有效果，但屏幕上没出现声明的东西 → inconclusive，并说出缺的是哪一句", () => {
    const f = expecting(["div: Confirm Order"], ["Positions? \\(\\d+\\)", "Filled"]);
    expect(f.verification).toBe("inconclusive");
    expect(f.verificationReason).toContain("Filled");
  });
  it("屏幕上出现的是别的话 → 判决里带上产品自己说的那一句", () => {
    const f = expecting(["div: Order could not match against any resting orders."], ["Positions? \\(\\d+\\)"]);
    expect(f.verification).toBe("inconclusive");
    expect(f.verificationReason).toContain("could not match");
  });
  it("屏幕上出现了声明的东西 → confirmed，并说出是哪一行作的证", () => {
    const f = expecting(["div: Positions (1)"], ["Positions? \\(\\d+\\)", "Filled"]);
    expect(f.verification).toBe("confirmed");
    expect(f.verificationReason).toContain("Positions (1)");
  });
  /**
   * 声明了期望、目标却**从没点过** → 不是确证（docs/v3/history/24 §32）。
   *
   * 2026-09-12 第二次撞见同一件事的另一条路：`missed` 只数 attempted 的观察，
   * 「看见了但没点」落不进它，判决滑到「有效果且不是闸门」那一支——
   * 而那个效果是上一步（打开弹窗）留下的。回执里写着 `found_not_activated`，
   * 判决却说 confirmed。
   */
  it("声明了期望的目标被看见却没点 → unverified，并说出没验的是什么", () => {
    const v = validateRulePack(pack({ targets: [{ id: "T1", featureId: "f1", match: { label: ["^Place Order$"] },
      expectOnScreen: ["Positions? \\(\\d+\\)"] }] }));
    if (!v.ok) throw new Error(JSON.stringify(v.errors.slice(0, 2)));
    const r = reportWith(["div: Confirm Order"]) as never as {
      observations: Array<{ targetSpecId: string }>; plannedTargets: Array<unknown>;
    };
    // 这一屏留下了效果，但那条观察属于别的目标；T1 只是「看见了」。
    r.observations[0]!.targetSpecId = "T-OTHER";
    r.plannedTargets = [{ targetSpecId: "T1", featureId: "f1", status: "observed_only", reason: "found_not_activated", targetIds: [], observationIds: [], action: "activate", terminal: false }];
    const f = buildProductModel({ pack: v.pack, report: r as never }).features[0]!;
    expect(f.verification).toBe("unverified");
    expect(f.verificationReason).toContain("never activated");
  });

  /** 带文字证据的回执：`textPresent` 期望要能被判，文字通道就不能是瞎的。 */
  const reportWithText = (added: string[]) => {
    const r = reportWith([]) as never as { observations: Array<{ effect: { textAdded: string[] } }> };
    r.observations[0]!.effect.textAdded = added;
    return r;
  };

  /**
   * **假设没被满足 ≠ 产品错了**（docs/v3/history/24 §35）。
   *
   * `conflicted` 是在指控产品有缺陷，那个指控只有 normative（背后有官方文档 / 产品规格 /
   * fixture 契约）才提得起。2026-09-13 实测：`REFERENCE-domain-perp.md` 的五条不变量搬进
   * 规则包时被校验逼着自报家门成 `hypothesis`，可判决这一侧不看 claimType，
   * 于是它们一落空就把 7 个功能判成了 conflicted——校验挡住了包，模型这一侧没挡住。
   */
  it("hypothesis 的 ui 期望落空 → inconclusive，不是 conflicted", () => {
    const raw = pack();
    raw.rules = [{ id: "R-H", featureIds: ["f1"], claimType: "hypothesis", statement: "点完应当出现某一行",
      appliesWhen: "任何时候", sourceRefs: [(raw.sources as { id: string }[])[0]!.id],
      verification: { kind: "ui-state", expect: { controlsPresent: [], stateChanged: [], textPresent: ["永远不会出现的一行"] } } } as never];
    const v = validateRulePack(raw);
    if (!v.ok) throw new Error(JSON.stringify(v.errors.slice(0, 2)));
    const model = buildProductModel({ pack: v.pack, report: reportWithText(["别的东西"]) as never });
    expect(model.features[0]!.verification).toBe("inconclusive");
    expect(model.conflicts).toEqual([]);
    expect(model.ruleBindings[0]!.reason).toContain("cannot convict the product");
  });

  it("normative 的 ui 期望落空 → 照旧 conflicted：那才是指控产品有缺陷的地方", () => {
    const raw = pack();
    const src = (raw.sources as { id: string; kind: string }[])[0]!;
    src.kind = "official-doc";
    raw.rules = [{ id: "R-N", featureIds: ["f1"], claimType: "normative", statement: "点完必须出现某一行",
      appliesWhen: "任何时候", sourceRefs: [src.id],
      verification: { kind: "ui-state", expect: { controlsPresent: [], stateChanged: [], textPresent: ["永远不会出现的一行"] } } } as never];
    const v = validateRulePack(raw);
    if (!v.ok) throw new Error(JSON.stringify(v.errors.slice(0, 2)));
    const model = buildProductModel({ pack: v.pack, report: reportWithText(["别的东西"]) as never });
    expect(model.features[0]!.verification).toBe("conflicted");
    expect(model.conflicts.length).toBe(1);
  });

  it("没声明期望的目标照旧按「有效果且不是闸门」判——这条只约束声明了的", () => {
    expect(verdict([], ["div: Confirm Order"]).verification).toBe("confirmed");
  });
  it("expectedStates 没有人读：写了就报错，指向 expectOnScreen", () => {
    const v = validateRulePack(pack({ targets: [{ id: "T1", featureId: "f1", match: { label: ["^X$"] }, expectedStates: ["s1"] }] }));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.map((e) => e.code)).toContain("expected_states_not_implemented");
  });

  it("点了但什么都没变 → 不算确证", () => {
    const v = validateRulePack(pack());
    if (!v.ok) throw new Error("pack invalid");
    const r = reportWith([]) as never as { observations: Array<{ effect?: unknown }> };
    delete r.observations[0]!.effect;
    expect(buildProductModel({ pack: v.pack, report: r as never }).features[0]!.verification).toBe("inconclusive");
  });
});
