import { it, expect } from "vitest";
import { runGate } from "../src/casegen/gate.js";
import type { CaseBundle, TextCase } from "../src/casegen/types.js";

/**
 * 2026-09-11 第二轮实测（docs/v3/23）暴露的两条门禁缺陷。
 *
 * 一、负例比例只数 `designMethod`，把 v2 拆出去的 `scenarioType` 漏掉了；
 * 二、没有 flows 时任何 `covers` 一律记 warn，于是「带完整状态证据」和「凭空编一条边」
 *     拿同一个分数——两条臂都被打到 0，门禁失去区分能力。
 */
const base = (over: Partial<TextCase>): TextCase => ({
  id: "TC-1", storyId: "US-1", title: "t", designMethod: "state-transition",
  precondition: [], steps: ["点击提交按钮"], postSteps: [], expected: "出现某条字面量",
  tier: 3, key: "k", covers: [], sourceRefs: [], ...over,
} as TextCase);

const bundle = (cases: TextCase[]): CaseBundle => ({
  stories: [{ id: "US-1", title: "s", acceptance: ["前置 / 触发 / 结果"], role: "r", benefit: "b" }],
  cases, flows: [],
} as unknown as CaseBundle);

it("negative 场景计入负例比例，即使设计方法不是 negative", () => {
  const cases = Array.from({ length: 10 }, (_, i) =>
    base({ id: `TC-${i}`, key: `k${i}`, designMethod: "equivalence",
      ...(i < 4 ? { scenarioType: "negative" as const } : {}) }));
  const r = runGate(bundle(cases), { minNegativeRatio: 0.3 });
  expect(r.stats.negativeRatio).toBe(0.4);
  expect(r.findings.some((f) => f.rule === "negative-ratio")).toBe(false);
});

it("同一条用例既是 negative 场景又用 boundary 方法，只算一次", () => {
  const cases = Array.from({ length: 4 }, (_, i) =>
    base({ id: `TC-${i}`, key: `k${i}`, designMethod: i === 0 ? "boundary" : "equivalence",
      ...(i === 0 ? { scenarioType: "negative" as const } : {}) }));
  expect(runGate(bundle(cases), { minNegativeRatio: 0.3 }).stats.negativeRatio).toBe(0.25);
});

it("covers 与自己的 transitionIds 对得上时记 info，对不上时仍记 warn", () => {
  const evidenced = base({
    id: "TC-OK", key: "ok", covers: ["a->b"],
    design: { technique: "state-transition", stateModelRef: "product-model:x", from: "a", event: "点一下", to: "b", transitionIds: ["a->b"] },
  });
  const bare = base({ id: "TC-BARE", key: "bare", covers: ["c->d"] });
  const r = runGate(bundle([evidenced, bare]), {});
  const by = Object.fromEntries(r.findings.filter((f) => f.rule === "covers-unverifiable").map((f) => [f.caseId, f.severity]));
  expect(by["TC-OK"]).toBe("info");
  expect(by["TC-BARE"]).toBe("warn");
  // 只有 warn 才进扣分口径。
  expect(r.scoreBasis?.flagged).toContain("TC-BARE");
  expect(r.scoreBasis?.flagged).not.toContain("TC-OK");
});

it("covers 只覆盖了 transitionIds 的一部分不算自证——多出来的那条查不到出处", () => {
  const partial = base({
    id: "TC-PART", key: "part", covers: ["a->b", "b->c"],
    design: { technique: "state-transition", stateModelRef: "product-model:x", from: "a", event: "点一下", to: "b", transitionIds: ["a->b"] },
  });
  const r = runGate(bundle([partial]), {});
  expect(r.findings.find((f) => f.rule === "covers-unverifiable")!.severity).toBe("warn");
});

it("断言级判据也算数：顶层没有 oracle 但每条断言都有，不该被记 tier-unbacked", () => {
  const c = base({
    id: "TC-ASSERT", key: "assert", tier: 1,
    assertions: [{ id: "A1", statement: "页面出现该字面量", ruleRefs: [], oracle: { kind: "text", value: "Spread" } }],
  });
  const r = runGate(bundle([c]), {});
  expect(r.findings.some((f) => f.rule === "tier-unbacked")).toBe(false);
  expect(r.stats.tiersBacked["1"]).toBe(1);
});

it("顶层与断言都没有判据才是 tier-unbacked", () => {
  const c = base({ id: "TC-NONE", key: "none", tier: 2, assertions: [{ id: "A1", statement: "某件事成立", ruleRefs: [] }] });
  const r = runGate(bundle([c]), {});
  expect(r.findings.some((f) => f.rule === "tier-unbacked")).toBe(true);
  expect(r.stats.tiersBacked["3"]).toBe(1);
});

/**
 * 判决必须在屏幕上（docs/v3/24 §18）。这个产品产出的是端到端 UI 测试：
 * 接口说下单成功而屏幕上没有那一行，用例会通过，而产品其实是坏的。
 */
it("判据去问被测产品自己的接口：门禁点名；改成看屏幕就不点名", () => {
  const story = { id: "US-1", title: "下单", acceptance: ["下单后仓位出现"] };
  const base: TextCase = { id: "TC-1", key: "k1", storyId: "US-1", title: "下一单", priority: "P1",
    designMethod: "state-transition", tier: 1, steps: ["填数量", "提交"], expected: "仓位表出现该市场的一行" } as never;
  const api = runGate({ stories: [story], cases: [{ ...base, oracle: { kind: "api",
    url: "https://api.example.test/info", method: "POST", path: "assetPositions.0.position.szi",
    op: "eq", value: "0.01" } }] } as unknown as CaseBundle);
  expect(api.findings.map((f) => f.rule)).toContain("oracle-offsite");
  const ui = runGate({ stories: [story], cases: [{ ...base, oracle: { kind: "count",
    value: "BTC-USDC", op: "eq", n: 1 } }] } as unknown as CaseBundle);
  expect(ui.findings.map((f) => f.rule)).not.toContain("oracle-offsite");
});

/**
 * 2026-09-13 exec-1f7d2cdd：81 条里 14 条把一句前置状态确认写进了 `steps`。
 * 执行侧把每个 step 交给 `aiAction`，它只规划动作，于是抛 `Failed to plan actions`，
 * 一条措辞问题被记成产品缺陷。前置状态属于 `precondition`，事后判断属于 `assertions`。
 */
it("steps 里写的是状态而不是动作时会被点名", () => {
  const r = runGate(bundle([base({
    steps: ["打开 https://example.test/trade/ETH", "确认右侧区域显示订单簿（Order Book 标签处于激活态）", "点击 Trades 标签"],
  })]));
  const f = r.findings.filter((x) => x.rule === "step-not-an-action");
  expect(f).toHaveLength(1);
  expect(f[0]!.message).toContain("确认右侧区域显示订单簿");
});

it("真动作不会被误伤——「确认下单」是点按钮，不是看屏幕", () => {
  const r = runGate(bundle([base({
    steps: ["在 Size 输入框填入 0.01", "点击 Buy / Long", "确认下单"],
  })]));
  expect(r.findings.some((x) => x.rule === "step-not-an-action")).toBe(false);
});

/**
 * 第二种形状：纯观察。2026-09-13 逐条看 `trade-panel.order-entry` 时发现——
 * 「查看面板方向按钮区域」连一个状态词都没有，两段全中的规则漏了它，
 * 而它同样不是动作：「看一眼某个区域」在浏览器里没有对应操作。
 */
it("「查看 X 区域」也是非动作，尽管它一个状态词都没有", () => {
  const r = runGate(bundle([base({ steps: ["打开 https://example.test/trade/ETH", "查看面板方向按钮区域"] })]));
  expect(r.findings.filter((x) => x.rule === "step-not-an-action")).toHaveLength(1);
});

it("动作动词不会被控件名字咬住——「点击 Show more」里的「查看更多」不算观察", () => {
  const r = runGate(bundle([base({ steps: ["查看更多——点击 Show more 展开", "在 Size 输入框填入 0.01"] })]));
  expect(r.findings.some((x) => x.rule === "step-not-an-action")).toBe(false);
});

/**
 * 2026-09-13 量出的闭合链，门禁这一端管的是最后一环：**编号对上了，动作却没做**。
 * S-08「输入超出 szDecimals 小数位的数量」「切换计价单位」两条动作型准则当时一条用例都没认领，
 * 而 TC-016/017 认领它时把 When 改成了「查看」。
 */
it("要求用户动手的验收准则没人认领时点名", () => {
  const b = bundle([base({ acRefs: ["US-1/AC-2"], steps: ["打开 https://example.test/", "点击计价单位切换"] } as never)]);
  (b.stories as never as Array<{ acceptance: string[] }>)[0]!.acceptance = [
    "Given 面板打开 / When 用户点击 Limit / Then 出现 Price 输入框",
    "Given 面板打开 / When 用户切换计价单位 / Then 数量按新单位换算",
  ];
  const f = runGate(b).findings.filter((x) => x.rule === "acceptance-uncovered");
  // AC-2 有人认领且真的做了动作；AC-1（点击 Limit）没人认领。
  expect(f).toHaveLength(1);
  expect(f[0]!.message).toContain("US-1/AC-1");
});

it("认领了，但步骤里只有导航和看——等于没做", () => {
  const b = bundle([base({ acRefs: ["US-1/AC-1"], steps: ["打开 https://example.test/", "查看面板"] } as never)]);
  (b.stories as never as Array<{ acceptance: string[] }>)[0]!.acceptance = [
    "Given 面板打开 / When 用户点击 Limit / Then 出现 Price 输入框",
  ];
  const f = runGate(b).findings.filter((x) => x.rule === "acceptance-uncovered");
  expect(f).toHaveLength(1);
  expect(f[0]!.message).toContain("只有导航和查看");
});

it("真的点了，就不点名", () => {
  const b = bundle([base({ acRefs: ["US-1/AC-1"], steps: ["打开 https://example.test/", "点击 Limit 标签"] } as never)]);
  (b.stories as never as Array<{ acceptance: string[] }>)[0]!.acceptance = [
    "Given 面板打开 / When 用户点击 Limit / Then 出现 Price 输入框",
  ];
  expect(runGate(b).findings.some((x) => x.rule === "acceptance-uncovered")).toBe(false);
});

it("除了导航什么都不做的用例要被数出来——它测的是「这一页还在」", () => {
  const only = runGate(bundle([base({ steps: ["打开 https://example.test/", "查看页头读数区"] })])).findings;
  expect(only.filter((x) => x.rule === "case-without-action")).toHaveLength(1);
  const acts = runGate(bundle([base({ steps: ["打开 https://example.test/", "点击 Limit 标签"] })])).findings;
  expect(acts.some((x) => x.rule === "case-without-action")).toBe(false);
});

/**
 * 2026-09-14 用户提的结构：「长的用户故事会覆盖短的用户故事，这样步数会增加，
 * 同时不重要的用户故事可以减少」。被覆盖的故事没有自己的用例是**设计**，不是漏洞——
 * 门禁如果照旧按 storyId 找用例，长故事刚把短用例合并掉，它就会反过来报一堆缺陷。
 */
it("被覆盖的故事没有自己的用例，不算 story-uncovered", () => {
  const b = bundle([base({ storyId: "US-1", acRefs: ["US-2/AC-1"], steps: ["打开 https://example.test/", "点击 Limit 标签"] } as never)]);
  const ss = b.stories as never as Array<Record<string, unknown>>;
  ss[0]!.subsumes = ["US-2"];
  ss.push({ id: "US-2", title: "看到价格读数", role: "r", benefit: "b", acceptance: ["Given 页面打开 / When 用户点击 Limit / Then 出现 Price"] });
  const f = runGate(b).findings;
  expect(f.some((x) => x.rule === "story-uncovered")).toBe(false);
  // 而它的准则由覆盖方的用例了结，也不该报没人认领。
  expect(f.some((x) => x.rule === "acceptance-uncovered")).toBe(false);
});

it("覆盖了却没人真去做那个动作，仍然点名", () => {
  const b = bundle([base({ storyId: "US-1", acRefs: ["US-2/AC-1"], steps: ["打开 https://example.test/", "查看面板"] } as never)]);
  const ss = b.stories as never as Array<Record<string, unknown>>;
  ss[0]!.subsumes = ["US-2"];
  ss.push({ id: "US-2", title: "看到价格读数", role: "r", benefit: "b", acceptance: ["Given 页面打开 / When 用户点击 Limit / Then 出现 Price"] });
  expect(runGate(b).findings.some((x) => x.rule === "acceptance-uncovered")).toBe(true);
});
