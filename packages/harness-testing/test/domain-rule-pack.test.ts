import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { charterFromRulePack, validateRulePack, matchTarget, activationBlocker, routeAllowed, buildProductModel, CharterTracker, DEFAULT_FORBID_LABELS, type ControlLike } from "../src/domain/index.js";

/**
 * 规则包与 charter 的硬事实校验（docs/v3/history/21 §8 反例 1、8、10 的服务端半边）。
 * 这些都不需要模型：一个悬空的 sourceRef、一条没有依据的 P0，在写入之前就该被拒。
 */
const packPath = resolve(import.meta.dirname, "./fixtures/perp-lab-rules.json");
const load = () => JSON.parse(readFileSync(packPath, "utf8")) as Record<string, unknown>;

describe("ProductRulePack v1", () => {
  it("perp-lab 的规则包本身合法，且哈希稳定", () => {
    const a = validateRulePack(load());
    const b = validateRulePack(load());
    expect(a.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.hash).toBe(b.hash);
    expect(a.pack.rules.length).toBeGreaterThan(5);
  });

  it("规则引用不存在的功能 → dangling_ref，并指出 jsonPointer 与 ruleId", () => {
    const raw = load();
    (raw.rules as Array<{ id: string; featureIds: string[] }>)[0]!.featureIds = ["order.nope"];
    const v = validateRulePack(raw);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.errors[0]).toMatchObject({ code: "dangling_ref", jsonPointer: "/rules/0/featureIds/0", ruleId: "R-ORDER-TYPE-LIMIT" });
  });

  it("normative 规则只有领域参考来源 → 拒绝：通用参考不能自动升级成产品要求", () => {
    const raw = load();
    (raw.rules as Array<{ id: string; sourceRefs: string[] }>)[0]!.sourceRefs = ["SRC-DOMAIN-REF"];
    const v = validateRulePack(raw);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.errors.map((e) => e.code)).toContain("normative_without_product_source");
  });

  it("假设类规则设 P0 下限 → 拒绝（无依据 P0：只有领域参考，没有产品来源）", () => {
    const raw = load();
    const rule = (raw.rules as Array<Record<string, unknown>>).find((r) => r.id === "R-FUNDING")!;
    rule.riskFloor = "P0";
    const v = validateRulePack(raw);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.errors.map((e) => e.code)).toContain("p0_without_source");
  });

  it("模块父子成环 → 拒绝", () => {
    const raw = load();
    const mods = raw.modules as Array<{ id: string; parentId: string | null }>;
    mods.find((m) => m.id === "trade-panel")!.parentId = "trade-panel.risk";
    const v = validateRulePack(raw);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.errors.map((e) => e.code)).toContain("module_cycle");
  });

  it("未知字段被 strict schema 拒绝，不会被静默吞掉", () => {
    const raw = load();
    raw.extra = 1;
    expect(validateRulePack(raw).ok).toBe(false);
  });
});

const ctl = (over: Partial<ControlLike> & { display: string; label: string }): ControlLike => ({
  selector: "#x", role: "", href: "", external: false, submit: false, clickable: true, fillable: false, state: "", ...over,
});

describe("charter：目标匹配与动作策略", () => {
  const v = validateRulePack(load());
  if (!v.ok) throw new Error("fixture pack invalid");
  const charter = charterFromRulePack(v.pack, v.hash, { entryUrl: "http://127.0.0.1:5391/", maxScreens: 8 });
  const spec = (id: string) => charter.featureTargets.find((t) => t.id === id)!;

  it("普通 <button> 也能匹配目标——不要求它在 ARIA 组里", () => {
    expect(matchTarget(ctl({ display: "button[button]: Isolated", label: "Isolated" }), spec("T-MARGIN-ISOLATED"), "/")).toBe(true);
    expect(activationBlocker(ctl({ display: "button[button]: Isolated", label: "Isolated" }), spec("T-MARGIN-ISOLATED"), charter.actionsPolicy, new Set())).toBeUndefined();
  });

  it("checkbox 输入框匹配 Reduce Only，且可激活", () => {
    const c = ctl({ display: "input[checkbox]: Reduce Only", label: "Reduce Only", clickable: false, fillable: false });
    expect(matchTarget(c, spec("T-REDUCE-ONLY"), "/")).toBe(true);
    expect(activationBlocker(c, spec("T-REDUCE-ONLY"), charter.actionsPolicy, new Set())).toBeUndefined();
  });

  it("state-change 目标（Place Order）永远被策略阻断，即使文案不在词表里", () => {
    const c = ctl({ display: "button[button]: Go", label: "Go" });
    const s = { ...spec("T-PLACE-ORDER"), match: { label: ["^Go$"], roles: [], within: [] } };
    expect(activationBlocker(c, s, charter.actionsPolicy, new Set())).toBe("policy:side_effect");
  });

  it("缺前提（position-fixture）→ requires:…，目标保留而不是删掉", () => {
    const c = ctl({ display: "button[button]: Close Position", label: "Close Position" });
    const s = { ...spec("T-CLOSE-POSITION"), sideEffect: "ui-only" as const };
    expect(activationBlocker(c, s, charter.actionsPolicy, new Set())).toBe("requires:position-fixture");
    expect(activationBlocker(c, s, charter.actionsPolicy, new Set(["position-fixture"]))).toBe("policy:forbidden_label");
  });

  it("方向切换不在禁点词表里：Buy / Long、Sell / Short 是 ui-only，词表不许越过声明挡掉它们", () => {
    const buy = ctl({ display: "div: Buy / Long", label: "Buy / Long" });
    const s = { ...spec("T-ORDER-TYPE-LIMIT"), id: "T-SIDE", match: { label: ["^Buy ?/ ?Long$"], roles: [], within: [] } };
    expect(activationBlocker(buy, s, charter.actionsPolicy, new Set())).toBeUndefined();
  });

  it("交叉检查兜底：一个控件命中任何 state-change 目标，就不许以别的目标名义点它", () => {
    const submit = ctl({ display: "button[button]: Place Order", label: "Place Order" });
    const pretend = { ...spec("T-ORDER-TYPE-LIMIT"), id: "T-PRETEND", match: { label: ["Place Order"], roles: [], within: [] } };
    const stateChange = charter.featureTargets.filter((t) => t.sideEffect === "state-change");
    expect(activationBlocker(submit, pretend, charter.actionsPolicy, new Set())).toBe("policy:forbidden_label");
    const noWords = { ...charter.actionsPolicy, forbidLabels: [] };
    expect(activationBlocker(submit, pretend, noWords, new Set())).toBeUndefined();
    expect(activationBlocker(submit, pretend, noWords, new Set(), stateChange, "/")).toMatch(/^policy:matches_state_change:/);
  });

  it("词表是第三道保险：ui-only 目标撞上「Reduce Only & Place」也不点", () => {
    const c = ctl({ display: "button[button]: Reduce Only & Place", label: "Reduce Only & Place" });
    // 角色约束已经把按钮挡在 checkbox 目标之外；去掉角色约束，词表仍然拦得住。
    expect(matchTarget(c, spec("T-REDUCE-ONLY"), "/")).toBe(false);
    const loose = { ...spec("T-REDUCE-ONLY"), match: { ...spec("T-REDUCE-ONLY").match, roles: [] } };
    expect(matchTarget(c, loose, "/")).toBe(true);
    expect(activationBlocker(c, loose, charter.actionsPolicy, new Set())).toBe("policy:forbidden_label");
    /**
     * charter 的词表 = **通用默认 + 这个规则包自带的行业词**。
     *
     * 以前这里断言的是「等于默认」，而那个默认里混着 deposit / 平仓 / 撤单 这类
     * 只有交易类产品才有的词——通用生成器里焊死一个行业的副作用观念，换个产品就错。
     * 现在行业词跟着规则包走（`pack.forbidLabels`），默认里只留任何 Web 产品都成立的那几个。
     */
    expect(charter.actionsPolicy.forbidLabels.slice(0, DEFAULT_FORBID_LABELS.length)).toEqual(DEFAULT_FORBID_LABELS);
    expect(charter.actionsPolicy.forbidLabels).toContain("close position");
    expect(DEFAULT_FORBID_LABELS).not.toContain("close position");
  });

  it("observe-only 目标（杠杆输入框）：看见即完成，不点", () => {
    const c = ctl({ display: "input[text]: Leverage", label: "Leverage", clickable: false, fillable: true });
    expect(matchTarget(c, spec("T-LEVERAGE-INPUT"), "/")).toBe(true);
    expect(activationBlocker(c, spec("T-LEVERAGE-INPUT"), charter.actionsPolicy, new Set())).toBe("observe_only");
  });

  it("路由限域：默认只留在入口路由，全局导航不能把预算带走", () => {
    expect(routeAllowed(charter, "/trade", "/trade")).toBe(true);
    expect(routeAllowed(charter, "/trade", "/portfolio")).toBe(false);
    expect(routeAllowed(undefined, "/trade", "/portfolio")).toBe(true);
    expect(routeAllowed({ ...charter, scope: { ...charter.scope, routes: ["^/portfolio"] } }, "/trade", "/portfolio")).toBe(true);
  });
});

/**
 * 前提从哪来必须说得出（docs/v3/history/24 §16）。
 * 真实撞出来的形状：`T-CONNECT` 写 `requires: ["wallet-session"]`——它要求的正是它自己产出的东西，
 * 于是四次探索里它四次被挡，而回执上那四行看起来像是策略在正常工作。
 */
describe("前提的供给关系", () => {
  const base = load() as Record<string, any>;
  const withTargets = (targets: unknown[], external?: string[]) =>
    validateRulePack({ ...base, targets, ...(external ? { externalCapabilities: external } : {}) });
  const target = (patch: Record<string, unknown>) => ({
    id: "T-X", featureId: (base.features as Array<{ id: string }>)[0]!.id, match: { label: ["^X$"] }, ...patch,
  });

  it("要求一个没人产出、也没声明来自外部的前提：拒收", () => {
    const v = withTargets([target({ requires: ["wallet-session"] })]);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.map((e) => e.code)).toContain("target_requires_unprovidable");
  });

  it("另一个目标 provides 它，就过", () => {
    expect(withTargets([target({ requires: ["wallet-session"] }),
      { ...target({ provides: ["wallet-session"] }), id: "T-CONNECT-X" }]).ok).toBe(true);
  });

  it("声明成外部前提，也过（fixture 准备的东西探索拿不到）", () => {
    expect(withTargets([target({ requires: ["position-fixture"] })], ["position-fixture"]).ok).toBe(true);
  });

  it("同时 requires 和 provides 同一个前提：拒收", () => {
    const v = withTargets([target({ requires: ["wallet-session"], provides: ["wallet-session"] })]);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.map((e) => e.code)).toContain("target_requires_what_it_provides");
  });

  it("点成之后，它产出的前提变成可用", () => {
    const v = validateRulePack(load());
    if (!v.ok) throw new Error("fixture invalid");
    const charter = charterFromRulePack({ ...v.pack, targets: [
      { ...target({ provides: ["wallet-session"] }), id: "T-CONNECT-X", ruleRefs: [], action: "activate",
        sideEffect: "ui-only", requires: [], expectedStates: [] } as never] }, v.hash,
      { entryUrl: "https://x.test/", maxScreens: 4 });
    const tracker = new CharterTracker(charter);
    expect(tracker.capabilities()).not.toContain("wallet-session");
    tracker.record({ targetId: "x", targetSpecId: "T-CONNECT-X", featureId: charter.featureTargets[0]!.featureId,
      status: "attempted", stateBefore: "/", round: 1, controlsAfter: [], evidenceRefs: [] } as never);
    expect(tracker.capabilities()).toContain("wallet-session");
  });
});

/** `fill`：探索能填一个**规则包声明过的**值，不自己编（docs/v3/history/24 §17）。 */
describe("fill 目标", () => {
  const base = load() as Record<string, any>;
  const t = (patch: Record<string, unknown>) => ({ id: "T-F", featureId: (base.features as Array<{ id: string }>)[0]!.id,
    match: { label: ["^Size$"] }, ...patch });
  const v = (targets: unknown[]) => validateRulePack({ ...base, targets, externalCapabilities: ["position-fixture"] });

  it("fill 没给 value：拒收", () => {
    const r = v([t({ action: "fill" })]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.code)).toContain("fill_target_without_value");
  });
  it("不是 fill 却带 value：拒收", () => {
    const r = v([t({ action: "activate", value: "0.01" })]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.code)).toContain("value_on_non_fill_target");
  });
  it("文本输入框对 fill 目标不再是 unsupported:value_input", () => {
    const r = v([t({ action: "fill", value: "0.01" })]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const charter = charterFromRulePack(r.pack, r.hash, { entryUrl: "https://x.test/", maxScreens: 4 });
    const spec = charter.featureTargets.find((x) => x.id === "T-F")!;
    const input: ControlLike = { display: "input[text]: Size", label: "Size", role: "", state: "", clickable: false,
      fillable: true, submit: false, external: false, selector: "#size", href: "", selectedNow: false } as never;
    expect(activationBlocker(input, spec, charter.actionsPolicy, new Set())).toBeUndefined();
  });
});

/**
 * 沙箱放开的是「可以改状态」，不是「点错也无所谓」（docs/v3/history/24 §17）。
 * 真实代价：`T-CONFIRM` 的文案曾写成 `^Buy / Long$`，而那也是下单面板方向切换的名字。
 */
it("沙箱模式下，一个控件同时命中两个目标仍然要挡", () => {
  const v = validateRulePack(load());
  if (!v.ok) throw new Error("fixture invalid");
  const sandbox = charterFromRulePack(v.pack, v.hash, { entryUrl: "https://x.test/", maxScreens: 4, allowStateChange: true });
  const stateChange = sandbox.featureTargets.filter((t) => t.sideEffect === "state-change");
  const victim = sandbox.featureTargets.find((t) => t.sideEffect !== "state-change" && stateChange.length)!;
  const ctl: ControlLike = { display: "button[button]: X", label: "X", role: "", state: "", clickable: true,
    fillable: false, submit: false, external: false, selector: "#x", href: "", selectedNow: false } as never;
  // 造一个「同时命中两个目标」的控件：拿 state-change 目标的文案去配一个 ui-only 目标。
  const twin = { ...victim, match: { ...victim.match, label: stateChange[0]!.match.label } };
  const label = stateChange[0]!.match.label[0]!.replace(/[\^$]/g, "");
  expect(activationBlocker({ ...ctl, label }, twin, sandbox.actionsPolicy, new Set(), stateChange, "/trade"))
    .toMatch(/matches_state_change/);
});

/**
 * 通用默认里不许再有行业词（docs/v3/history/24 §19）。
 * 这个生成器要能对任何 Web 产品用；焊死一个行业的副作用观念，换个产品就是拿别人的词表去探索。
 */
it("默认禁点词表只有通用破坏性动作；行业词一律在规则包里", () => {
  for (const industry of ["place", "connect", "approve", "deposit", "withdraw", "close position",
    "cancel all", "下单", "平仓", "撤单", "充值", "提现"])
    expect(DEFAULT_FORBID_LABELS.join(" ")).not.toContain(industry);
  for (const universal of ["delete", "remove", "reset", "log ?out", "删除", "退出", "提交", "确认"])
    expect(DEFAULT_FORBID_LABELS).toContain(universal);
  // 规则包把自己的行业词接在默认后面，两边合起来才是这次探索的词表。
  const v = validateRulePack(load());
  if (!v.ok) throw new Error("fixture invalid");
  const charter = charterFromRulePack(v.pack, v.hash, { entryUrl: "https://x.test/", maxScreens: 4 });
  for (const w of ["close position", "下单", "connect"]) expect(charter.actionsPolicy.forbidLabels).toContain(w);
});

/**
 * `match.within`：同一串文案在页面上出现几十次，只有弹窗里的那一个是要点的（docs/v3/history/24 §24.1）。
 *
 * 真实撞到的是这个：Hyperliquid 的「Buy / Long」在下单面板、在确认弹窗、在每一行成交记录里
 * 都出现，一轮探索里数到 45 个。交叉检查（policy:matches_state_change）看到重名就全挡，
 * 于是机器臂永远点不到确认键——它挡的是「分不清是哪一个」，而不是「这个不能点」。
 * `within` 给目标补上容器判据：限定了容器的目标，只跟同样限定了容器的目标比重名。
 */
describe("charter：match.within 把目标限定在容器里", () => {
  const v = validateRulePack(load());
  if (!v.ok) throw new Error("fixture pack invalid");
  const charter = charterFromRulePack(v.pack, v.hash, { entryUrl: "https://x.test/", maxScreens: 4 });
  const base = charter.featureTargets[0]!;
  const scoped = { ...base, id: "T-SCOPED", sideEffect: "ui-only" as const, requires: [], action: "activate" as const,
    match: { label: ["^Buy / Long$"], roles: [], within: ["Confirm Order", "确认订单"] } };
  const c = (container: string) => ctl({ display: "div: Buy / Long", label: "Buy / Long", container });

  it("容器文案对不上就不算命中——面板上那个同名控件不会被当成弹窗里的", () => {
    expect(matchTarget(c("Buy / Long Sell / Short Size USD"), scoped, "/")).toBe(false);
    expect(matchTarget(c(""), scoped, "/")).toBe(false);
  });

  it("在弹窗里才命中，大小写不敏感", () => {
    expect(matchTarget(c("Confirm Order Market Buy 0.01 ETH"), scoped, "/")).toBe(true);
    expect(matchTarget(c("confirm order market buy"), scoped, "/")).toBe(true);
  });

  it("限定了容器的目标，不被没限定容器的同名 state-change 目标挡住", () => {
    const rival = { ...base, id: "T-RIVAL", sideEffect: "state-change" as const,
      match: { label: ["^Buy / Long$"], roles: [], within: [] } };
    const inDialog = c("Confirm Order Market Buy 0.01 ETH");
    const policy = { ...charter.actionsPolicy, forbidLabels: [] };
    // 没有 within 时：两个目标都命中同一个控件 → 交叉检查挡掉。
    const loose = { ...scoped, match: { ...scoped.match, within: [] } };
    expect(activationBlocker(inDialog, loose, policy, new Set(), [rival], "/")).toMatch(/^policy:matches_state_change:/);
    // 有 within 时：对手里没有同样限定容器的，不算重名。
    expect(activationBlocker(inDialog, scoped, policy, new Set(), [rival], "/")).toBeUndefined();
  });

  it("两个目标都限定了容器且都命中，仍然算重名——放开的是精度，不是这道检查", () => {
    const rival = { ...base, id: "T-RIVAL2", sideEffect: "state-change" as const,
      match: { label: ["^Buy / Long$"], roles: [], within: ["Confirm"] } };
    const policy = { ...charter.actionsPolicy, forbidLabels: [] };
    expect(activationBlocker(c("Confirm Order Market Buy"), scoped, policy, new Set(), [rival], "/"))
      .toMatch(/^policy:matches_state_change:/);
  });
});

/**
 * 同一个文案被两个会改状态的目标认领 = 两个一起点不动（docs/v3/history/24 §24.2）。
 *
 * 这条是 2026-09-12 那一轮探索换来的：`T-SUBMIT` 写 `^Enable Trading$`，
 * `T-CONNECT` 写 `Connect|Enable Trading`，页面上那个按钮两边都命中，
 * 歧义检查对称地挡掉两个，回执上两行 `policy:matches_state_change:…` 看着像策略在正常工作，
 * 实际是下单链第一步就没起步。校验要在上传规则包时就说出来，而不是花一轮探索去发现。
 */
describe("校验：一个文案两个主人", () => {
  const withTargets = (targets: unknown[]) => {
    const raw = load();
    raw.targets = targets;
    return validateRulePack(raw);
  };
  const t = (id: string, label: string[], sideEffect: string, within: string[] = []) => ({
    id, featureId: (load().features as { id: string }[])[0]!.id, ruleRefs: [], match: { label, roles: [], within },
    action: "activate", sideEffect, requires: [], provides: [],
  });

  it("字面文案撞上另一个 state-change 目标的模式 → 拒收", () => {
    const v = withTargets([t("T-A", ["^Enable Trading$"], "state-change"), t("T-B", ["Connect|Enable Trading"], "state-change")]);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.map((e) => e.code)).toContain("target_label_claimed_twice");
  });

  it("ui-only 目标撞上 state-change 目标也算——被挡死的是它", () => {
    const v = withTargets([t("T-A", ["^Buy / Long$"], "ui-only"), t("T-B", ["^Buy / Long$"], "state-change")]);
    expect(v.ok).toBe(false);
  });

  it("两个 state-change 之间不撞就放行；容器限定把它们分开时也放行", () => {
    expect(withTargets([t("T-A", ["^Place Order$"], "state-change"), t("T-B", ["^Connect$"], "state-change")]).ok).toBe(true);
    // 一个在弹窗里、一个在面板上：具体的那个不跟笼统的那个比，这正是 within 要解决的事。
    expect(withTargets([t("T-A", ["^Buy / Long$"], "state-change", ["Confirm Order"]), t("T-B", ["^Buy / Long$"], "ui-only")]).ok).toBe(true);
  });
});

/**
 * 链要连续，不只是有先后（docs/v3/history/24 §24.6）。
 *
 * 实测：`T-SIZE-INPUT` 第 7 轮就把数量填了，然后广度遍历点了二十几个别的控件，
 * 第 20 轮才下单——面板早就不是当初那一单，产品回的是
 * `Order could not match against any resting orders`。
 * `requires`/`provides` 管得住先后，管不住连续。
 */
describe("charter：一条链要一次走完", () => {
  const packWith = (targets: unknown[]) => {
    const raw = load();
    raw.targets = targets;
    raw.externalCapabilities = [];
    const v = validateRulePack(raw);
    if (!v.ok) throw new Error(JSON.stringify(v.errors.slice(0, 2)));
    return charterFromRulePack(v.pack, v.hash, { entryUrl: "https://x.test/", maxScreens: 8 });
  };
  const fid = (load().features as { id: string }[])[0]!.id;
  const spec = (id: string, label: string, over: Record<string, unknown> = {}) => ({
    id, featureId: fid, ruleRefs: [], match: { label: [`^${label}$`], roles: [], within: [] },
    action: "activate", sideEffect: "ui-only", requires: [], provides: [], ...over,
  });
  // 一条真链：连会话 → 填量 → 下单。外加一个无关的开关，用来看它会不会插进链中间。
  const targets = [
    spec("T-FILL", "Size", { action: "fill", sideEffect: "none", value: "0.01", provides: ["size"] }),
    spec("T-NOISE", "Reduce Only"),
    spec("T-SESSION", "Connect", { sideEffect: "state-change", provides: ["session"] }),
    spec("T-SEND", "Place Order", { sideEffect: "state-change", requires: ["size", "session"] }),
  ];
  const controls = ["Size", "Reduce Only", "Connect", "Place Order"].map((l) =>
    ctl({ display: l === "Size" ? "input[text]: Size" : `button[button]: ${l}`, label: l, fillable: l === "Size" }));
  const walk = () => {
    const charter = packWith(targets);
    // 沙箱：允许点会改状态的东西，否则 Connect / Place Order 一律不点，看不到顺序。
    const sandbox = { ...charter, actionsPolicy: { ...charter.actionsPolicy, allowStateChange: true, forbidLabels: [] } };
    const t = new CharterTracker(sandbox as never);
    const order: string[] = [];
    for (let i = 0; i < 8; i++) {
      const pick = t.next("/", controls);
      if (!pick) break;
      t.markAttempted(pick.target.stableId);
      order.push(pick.spec.id);
      t.record({ targetId: pick.target.stableId, targetSpecId: pick.spec.id, featureId: pick.spec.featureId,
        status: "attempted", stateBefore: "/", stateAfter: `/~${i}`, controlsAfter: [], evidenceRefs: [], round: i,
        effect: { controlsAdded: [], controlsRemoved: [], stateChanged: ["x"], textAdded: [] } } as never);
    }
    return order;
  };

  it("填量不会跑在会话前面——消费它的人还缺别的前提时，供给方往后放", () => {
    const order = walk();
    expect(order.indexOf("T-SESSION")).toBeLessThan(order.indexOf("T-FILL"));
  });

  it("填完量紧接着就下单，中间不插无关的开关", () => {
    const order = walk();
    expect(order[order.indexOf("T-FILL") + 1]).toBe("T-SEND");
    expect(order).toContain("T-NOISE");
  });

  it("每个目标仍然都走到了——链优先不是把别的丢掉", () => {
    expect(new Set(walk())).toEqual(new Set(["T-FILL", "T-NOISE", "T-SESSION", "T-SEND"]));
  });
});

/**
 * 链要**整条**能跑完才开始走，不能只看下一跳（docs/v3/history/24 §24.7）。
 *
 * 「选市价 → 填量 → 下单」：只看下一跳的话，「选市价」第 2 轮就合格了（填量在它之后确实能走），
 * 于是市价被早早点掉，等真正下单时面板早被后面的遍历改成别的了。
 */
describe("charter：三步链的起点也要等", () => {
  const fid = (load().features as { id: string }[])[0]!.id;
  const spec = (id: string, label: string, over: Record<string, unknown> = {}) => ({
    id, featureId: fid, ruleRefs: [], match: { label: [`^${label}$`], roles: [], within: [] },
    action: "activate", sideEffect: "ui-only", requires: [], provides: [], ...over,
  });
  const targets = [
    spec("T-TYPE", "Market", { provides: ["type"] }),
    spec("T-FILL", "Size", { action: "fill", sideEffect: "none", value: "0.01", requires: ["type"], provides: ["size"] }),
    spec("T-NOISE", "Reduce Only"),
    spec("T-SESSION", "Connect", { sideEffect: "state-change", provides: ["session"] }),
    spec("T-SEND", "Place Order", { sideEffect: "state-change", requires: ["size", "session"] }),
  ];
  const controls = ["Market", "Size", "Reduce Only", "Connect", "Place Order"].map((l) =>
    ctl({ display: l === "Size" ? "input[text]: Size" : `button[button]: ${l}`, label: l, fillable: l === "Size" }));

  it("市价 → 填量 → 下单三步连着走，会话先建好", () => {
    const raw = load();
    raw.targets = targets;
    raw.externalCapabilities = [];
    const v = validateRulePack(raw);
    if (!v.ok) throw new Error(JSON.stringify(v.errors.slice(0, 2)));
    const charter = charterFromRulePack(v.pack, v.hash, { entryUrl: "https://x.test/", maxScreens: 8 });
    const t = new CharterTracker({ ...charter, actionsPolicy: { ...charter.actionsPolicy, allowStateChange: true, forbidLabels: [] } } as never);
    const order: string[] = [];
    for (let i = 0; i < 10; i++) {
      const pick = t.next("/", controls);
      if (!pick) break;
      t.markAttempted(pick.target.stableId);
      order.push(pick.spec.id);
      t.record({ targetId: pick.target.stableId, targetSpecId: pick.spec.id, featureId: pick.spec.featureId,
        status: "attempted", stateBefore: "/", stateAfter: `/~${i}`, controlsAfter: [], evidenceRefs: [], round: i,
        effect: { controlsAdded: [], controlsRemoved: [], stateChanged: ["x"], textAdded: [] } } as never);
    }
    expect(order.slice(-3)).toEqual(["T-TYPE", "T-FILL", "T-SEND"]);
    expect(order).toContain("T-NOISE");
  });
});

/**
 * 下一跳还没出现在屏幕上时，供给方也要等（docs/v3/history/24 §24.7）。
 *
 * 实测：会话刚建起来时 `Place Order` 还没出现（要等「建立连接」走完），
 * 「填数量」在能力上已经合格就先填了，紧接着那两下连接把面板重渲染，值被冲掉——
 * 回执里 `Est: 0%`，产品拒单。能力齐了不等于现在就能走完。
 */
it("下一跳不在这一屏上 → 供给方先不走，等它出现", () => {
  const fid = (load().features as { id: string }[])[0]!.id;
  const mk = (id: string, label: string, over: Record<string, unknown> = {}) => ({
    id, featureId: fid, ruleRefs: [], match: { label: [`^${label}$`], roles: [], within: [] },
    action: "activate", sideEffect: "ui-only", requires: [], provides: [], ...over,
  });
  const raw = load();
  raw.targets = [
    mk("T-FILL", "Size", { action: "fill", sideEffect: "none", value: "0.01", provides: ["size"] }),
    mk("T-NOISE", "Reduce Only"),
    mk("T-SEND", "Place Order", { sideEffect: "state-change", requires: ["size"] }),
  ];
  raw.externalCapabilities = [];
  const v = validateRulePack(raw);
  if (!v.ok) throw new Error(JSON.stringify(v.errors.slice(0, 2)));
  const charter = charterFromRulePack(v.pack, v.hash, { entryUrl: "https://x.test/", maxScreens: 8 });
  const t = new CharterTracker({ ...charter, actionsPolicy: { ...charter.actionsPolicy, allowStateChange: true, forbidLabels: [] } } as never);
  const size = ctl({ display: "input[text]: Size", label: "Size", fillable: true });
  const noise = ctl({ display: "button[button]: Reduce Only", label: "Reduce Only" });
  const send = ctl({ display: "button[button]: Place Order", label: "Place Order" });

  // 这一屏上还没有 Place Order：该挑的是那个开关，不是填值。
  expect(t.next("/", [size, noise])?.spec.id).toBe("T-NOISE");
  // Place Order 出现之后，填值才轮到它，下一步就是提交。
  expect(t.next("/", [size, noise, send])?.spec.id).toBe("T-FILL");
});

/**
 * 链进行中，链外的目标要等（docs/v3/history/24 §24.8）。
 *
 * 实测：链是「限价 → Mid 取价 → 填量 → 下单」，`Mid` 要等点完限价才出现；
 * 那一轮接不上，遍历顺手点了两下 TIF，第二下点中 **IOC**。
 * 限价单以 IOC 发出去，在 Mid 价上撮不上，产品回
 * `Order could not match against any resting orders`。链外的每一次点击都在改这条链的上下文。
 */
it("链的下一步还没出现时，这一轮什么都不点，也不让链外的目标插进来", () => {
  const fid = (load().features as { id: string }[])[0]!.id;
  const mk = (id: string, label: string, over: Record<string, unknown> = {}) => ({
    id, featureId: fid, ruleRefs: [], match: { label: [`^${label}$`], roles: [], within: [] },
    action: "activate", sideEffect: "ui-only", requires: [], provides: [], ...over,
  });
  const raw = load();
  raw.targets = [
    mk("T-LIMIT", "Limit", { provides: ["limit"] }),
    mk("T-MID", "Mid", { requires: ["limit"], provides: ["price"] }),
    mk("T-TIF", "GTC"),
    mk("T-SEND", "Place Order", { sideEffect: "state-change", requires: ["price"] }),
  ];
  raw.externalCapabilities = [];
  const v = validateRulePack(raw);
  if (!v.ok) throw new Error(JSON.stringify(v.errors.slice(0, 2)));
  const charter = charterFromRulePack(v.pack, v.hash, { entryUrl: "https://x.test/", maxScreens: 8 });
  const t = new CharterTracker({ ...charter, actionsPolicy: { ...charter.actionsPolicy, allowStateChange: true, forbidLabels: [] } } as never);
  const c = (l: string) => ctl({ display: `button[button]: ${l}`, label: l });
  const before = [c("Limit"), c("GTC"), c("Place Order")];      // Mid 还没出现
  const after = [...before, c("Mid")];                           // 点完限价它才出现

  // Mid 在前面的轮次里见过（限价模式下出现过），只是此刻被切走了——这正是真实情况。
  t.noteState("/", "/", after, 0);
  const first = t.next("/", before)!;
  expect(first.spec.id).toBe("T-LIMIT");
  t.markAttempted(first.target.stableId);
  t.record({ targetId: first.target.stableId, targetSpecId: "T-LIMIT", featureId: fid, status: "attempted",
    stateBefore: "/", stateAfter: "/~1", controlsAfter: [], evidenceRefs: [], round: 1,
    effect: { controlsAdded: ["button[button]: Mid"], controlsRemoved: [], stateChanged: ["x"], textAdded: [] } } as never);

  // Mid 还没出现的那一轮：不点 TIF，什么都不点。
  expect(t.next("/", before)).toBeUndefined();
  // 它出现之后，链接着走。
  expect(t.next("/", after)?.spec.id).toBe("T-MID");
});

/**
 * 角色与生命周期是**包里的领域事实**，不是模型的发挥空间（docs/v3/history/24 §26）。
 *
 * 2026-09-12 实测：一次运行 26 条故事，`role` 全是同一个词；故事上根本没有优先级字段。
 * 角色不同、看同一块屏幕想要的东西就不同；优先级要有据可依，那个「据」就是主链。
 */
describe("规则包：角色与生命周期", () => {
  const withExtra = (extra: Record<string, unknown>) => {
    const raw = load();
    Object.assign(raw, extra);
    return validateRulePack(raw);
  };
  const feature = (load().features as { id: string }[])[0]!.id;
  const source = (load().sources as { id: string }[])[0]!.id;

  it("生命周期的 order 撞号 → 拒收：主链的先后必须是确定的", () => {
    const v = withExtra({ lifecycle: [
      { id: "lc.a", name: "A", order: 0, featureIds: [feature], sourceRefs: [source] },
      { id: "lc.b", name: "B", order: 0, featureIds: [], sourceRefs: [] },
    ] });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.map((e) => e.code)).toContain("lifecycle_order_collision");
  });

  it("阶段挂在不存在的功能上 → 拒收", () => {
    const v = withExtra({ lifecycle: [{ id: "lc.a", name: "A", order: 0, featureIds: ["nope"], sourceRefs: [] }] });
    expect(v.ok).toBe(false);
  });

  it("角色与阶段进产品模型：下游只拿得到模型，拿不到规则包", () => {
    const v = withExtra({
      roles: [{ id: "r.one", name: "第一次上手的人", goal: "把一次完整流程走通", sourceRefs: [source] }],
      lifecycle: [{ id: "lc.b", name: "B", order: 1, featureIds: [] }, { id: "lc.a", name: "A", order: 0, featureIds: [feature] }],
    });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const model = buildProductModel({ pack: v.pack, report: emptyReport() });
    expect(model.roles.map((r) => r.id)).toEqual(["r.one"]);
    // 按 order 排好再交出去：下游不该自己去猜哪一段在前面。
    expect(model.lifecycle.map((l) => l.id)).toEqual(["lc.a", "lc.b"]);
  });
});

/** 一份什么都没探到的回执：这几条测的是规则包这一侧，不需要观察。 */
function emptyReport() {
  return {
    schemaVersion: "exploration-report.v1", charterId: "c", entryUrl: "https://x.test/",
    rulePack: { id: "p", version: "1", hash: "h" }, stateAbstraction: "route",
    states: [], targets: [], plannedTargets: [], observations: [], frontier: [],
    coverage: {}, budget: {}, completion: {}, stopReason: "exhausted",
  } as never;
}

/**
 * 2026-09-16：迁移时把版本号写成 `2026-09-13.3+domain-data`，存得下，真拿去建 charter 时才炸——
 * 探索节点开始 4 毫秒就失败，错误是一条 `path:["id"]` 的正则错，看不出跟版本号有关。
 * 版本号会被拼进 charter 的 id，所以字符集要在存的时候就对齐。
 */
it("版本号带 + 存不进去：它要拼进 charter 的 id", async () => {
  const { validateRulePack } = await import("../src/domain/rules.js");
  const base = JSON.parse(readFileSync(resolve(import.meta.dirname, "./fixtures/perp-lab-rules.json"), "utf8")) as Record<string, unknown>;
  const bad = validateRulePack({ ...base, version: "2026-09-13.3+domain-data" });
  expect(bad.ok).toBe(false);
  expect(JSON.stringify(bad.ok ? [] : bad.errors)).toMatch(/version/);
  expect(validateRulePack({ ...base, version: "2026-09-16.1-testnet" }).ok).toBe(true);
});
