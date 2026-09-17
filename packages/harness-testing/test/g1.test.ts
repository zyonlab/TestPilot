import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  EventBus,
  FakeModel,
  MemoryEventStore,
  MemoryOutputStore,
  runGraph,
  scoreCoverage,
  type Envelope,
  type GoldChecklist,
} from "@testpilot/harness-core";
import { g1 } from "../src/casegen/graph.js";
import { runGate } from "../src/casegen/gate.js";
import type { CaseBundle, GatedBundle } from "../src/casegen/types.js";

const FIXTURES = fileURLToPath(new URL("../../../fixtures/mock-spec/", import.meta.url));
const SPEC = readFileSync(`${FIXTURES}acme-portal.md`, "utf8");
const GOLD = JSON.parse(readFileSync(`${FIXTURES}gold-checklist.json`, "utf8")) as GoldChecklist;

/**
 * G1 end to end on a fake model. No endpoint, no browser, no minutes — which is the whole
 * point: the TDD loop for stage one has to be seconds, or it stops being run.
 */
function fakeModel() {
  return new FakeModel((req) => {
    // 用户文档现在只是材料：先被整理成那份标准规格，下游才开始工作。
    if (req.label === "spec.compose")
      return JSON.stringify({
        title: "Acme Portal 登录模块",
        summary: "登录与错误提示。",
        rules: [
          { id: "R-1", text: "有效凭证登录后显示个人面板", evidence: "Your dashboard is ready." },
          { id: "R-2", text: "凭证错误时停留在登录页并提示", evidence: "Invalid username or password" },
        ],
        unknowns: ["注册与找回密码的流程材料里没有描述"],
      });
    if (req.label === "plan.stories")
      return JSON.stringify({
        stories: [
          { id: "US-01", title: "使用有效凭证登录", acceptance: ["登录成功后显示个人面板"] },
          { id: "US-02", title: "凭证错误时被拒绝", acceptance: ["显示 Invalid username or password"] },
        ],
      });
    if (req.label === "design.cases:US-01")
      return [
        "```json",
        JSON.stringify({
          cases: [
            {
              title: "使用有效凭证成功登录",
              designMethod: "equivalence",
              precondition: ["已打开登录页"],
              steps: ["输入 ${env.USERNAME}", "输入 ${secret.PASSWORD}", "点击 Sign in"],
              expected: "页面显示 Welcome, ${env.USERNAME} 与 Your dashboard is ready.",
              tier: 1,
              key: "login|valid|dashboard-shown", covers: [], sourceRefs: [], postSteps: [],
            },
          ],
        }),
        "```",
      ].join("\n");
    if (req.label === "design.cases:US-02")
      return JSON.stringify({
        cases: [
          {
            title: "密码错误登录被拒绝",
            designMethod: "negative",
            precondition: [],
            steps: ["输入 ${env.USERNAME}", "输入错误密码 wrong-pass", "点击 Sign in"],
            expected: "显示 Invalid username or password，停留在登录页",
            tier: 1,
            key: "login|wrong-password|error-shown", covers: [], sourceRefs: [], postSteps: [],
          },
          {
            title: "空用户名登录被拒绝",
            designMethod: "boundary",
            precondition: [],
            steps: ["用户名留空", "输入 ${secret.PASSWORD}", "点击 Sign in"],
            expected: "显示 Invalid username or password",
            tier: 1,
            key: "login|empty-username|error-shown", covers: [], sourceRefs: [], postSteps: [],
          },
        ],
      });
    return "{}";
  });
}

function harness(model = fakeModel()) {
  const events: Envelope[] = [];
  const bus = new EventBus(new MemoryEventStore(), { coalesceMs: 0 });
  bus.subscribe((e) => events.push(e));
  const { registry, def } = g1(model, { spec: { text: SPEC }, specText: SPEC });
  return { bus, events, registry, def, store: new MemoryOutputStore(), model };
}

describe("G1: specification → text cases", () => {
  it("runs the whole pipeline and produces gated cases", async () => {
    const h = harness();
    const r = await runGraph(h.def, { registry: h.registry, bus: h.bus, store: h.store });

    expect(r.status).toBe("done");
    const out = r.outputs.gate as GatedBundle;
    expect(out.stories.map((s) => s.id)).toEqual(["US-01", "US-02"]);
    expect(out.cases).toHaveLength(3);
    // Every case is traceable and carries its design method and verdict hardness.
    expect(out.cases.every((c) => c.storyId && c.designMethod && c.tier)).toBe(true);
    expect(out.gate.stats).toMatchObject({ cases: 3, orphans: 0, duplicates: 0 });
  });

  it("charges each model call to the node that made it", async () => {
    const h = harness();
    const r = await runGraph(h.def, { registry: h.registry, bus: h.bus, store: h.store });
    const byNode = Object.fromEntries(r.nodes.map((n) => [n.nodeId, n.spend.calls]));
    // docs 只是读文件，不花模型；spec 是整理那一次；design 每条故事一次。
    expect(byNode).toMatchObject({ docs: 0, spec: 1, stories: 1, design: 2, gate: 0 });
    expect(r.spend.calls).toBe(4);
  });

  it("survives one story returning garbage instead of losing the batch", async () => {
    const model = new FakeModel((req) => {
      if (req.label === "spec.compose")
        return JSON.stringify({
          title: "t",
          summary: "s",
          rules: [{ id: "R-1", text: "登录成功显示面板", evidence: "Your dashboard is ready." }],
          unknowns: [], flows: [],
        });
      if (req.label === "plan.stories")
        return JSON.stringify({
          stories: [
            { id: "US-01", title: "ok", acceptance: [] },
            { id: "US-02", title: "broken", acceptance: [] },
          ],
        });
      if (req.label === "design.cases:US-02") return "I think the answer is that we should…";
      return JSON.stringify({
        cases: [
          {
            title: "有效凭证登录",
            designMethod: "equivalence",
            steps: ["点击 Sign in"],
            expected: "显示 Your dashboard is ready.",
            tier: 1,
            key: "login|valid|dashboard", covers: [], sourceRefs: [], postSteps: [],
          },
        ],
      });
    });
    const h = harness(model);
    const r = await runGraph(h.def, { registry: h.registry, bus: h.bus, store: h.store });
    expect(r.status).toBe("done");
    expect((r.outputs.gate as GatedBundle).cases).toHaveLength(1);
    // …and it says so, rather than quietly producing less.
    expect(h.events.some((e) => String((e.payload as { text?: string }).text ?? "").includes("US-02"))).toBe(true);
  });

  it("fails loudly when nothing usable came back at all", async () => {
    const h = harness(new FakeModel("no json here"));
    const r = await runGraph(h.def, { registry: h.registry, bus: h.bus, store: h.store });
    expect(r.status).toBe("failed");
    // 第一个吃模型的节点现在是整理那一步：材料进不去标准形状，后面一步都不该走。
    expect(r.error?.node).toBe("spec");
    expect(r.error?.message).toMatch(/no JSON object/);
  });

  it("re-runs just the gate from stored cases — changing a threshold must not re-ask the model", async () => {
    const h = harness();
    const first = await runGraph(h.def, { registry: h.registry, bus: h.bus, store: h.store });
    const callsBefore = h.model.calls.length;

    const strict = { ...h.def, nodes: h.def.nodes.map((n) => (n.id === "gate" ? { ...n, params: { minNegativeRatio: 0.9 } } : n)) };
    const again = await runGraph(strict, {
      registry: h.registry,
      bus: h.bus,
      store: h.store,
      wfRunId: first.wfRunId,
      mode: { kind: "only", node: "gate" },
    });

    expect(h.model.calls.length).toBe(callsBefore); // the model was not touched
    const gate = (again.outputs.gate as GatedBundle).gate;
    expect(gate.findings.some((f) => f.rule === "negative-ratio")).toBe(true);
  });

  it("scores the produced suite against the gold checklist", async () => {
    const h = harness();
    const r = await runGraph(h.def, { registry: h.registry, bus: h.bus, store: h.store });
    const bundle = r.outputs.gate as GatedBundle;
    const cov = scoreCoverage(GOLD, bundle.cases);
    // Three cases cannot cover twelve gold items — the number's job is to say so.
    expect(cov.coverage).toBeGreaterThan(0);
    expect(cov.coverage).toBeLessThan(0.6);
    expect(cov.misses.length).toBeGreaterThan(3);
  });
});

describe("gate ①", () => {
  const bundle = (cases: CaseBundle["cases"]): CaseBundle => ({ origin: "x", flows: [], stories: [{ id: "US-01", title: "story", acceptance: [] }],
    cases,
  });
  const base = {
    id: "c1",
    storyId: "US-01",
    title: "case",
    designMethod: "equivalence" as const,
    precondition: [],
    steps: ["点击 Sign in"],
    expected: "显示 Your dashboard is ready.",
    // A tier-1 case now has to carry the check a program would run. Without it the gate
    // says so, which is the whole point of the rule.
    oracle: { kind: "text" as const, value: "Your dashboard is ready." },
    tier: 1 as const,
    key: "login|valid|dashboard", covers: [], sourceRefs: [], postSteps: [],
  };

  it("marks an assertion that promises nothing checkable", () => {
    const g = runGate(bundle([{ ...base, expected: "页面显示正常" }]));
    expect(g.findings.some((f) => f.rule === "oracle-vague" && f.severity === "warn")).toBe(true);
  });

  it("marks a case that cannot be traced to a story", () => {
    const g = runGate(bundle([{ ...base, storyId: "US-99" }]));
    expect(g.stats.orphans).toBe(1);
  });

  it("marks two cases that cover the same thing in different words", () => {
    const g = runGate(bundle([base, { ...base, id: "c2", title: "另一个说法" }]));
    expect(g.stats.duplicates).toBe(1);
  });

  it("calls out a suite that is all happy path", () => {
    const g = runGate(bundle([base, { ...base, id: "c2", key: "login|valid2|dashboard", covers: [] }]));
    expect(g.findings.some((f) => f.rule === "negative-ratio")).toBe(true);
    expect(g.stats.negativeRatio).toBe(0);
  });

  /**
   * 方法标签是模型自己填的，此前没有任何一条规则去校验它。实测的后果：
   * 「主人列表页包含 Pets 列标题」被标成 boundary——检查一个列标题存不存在，
   * 跟边界值分析没有关系。一条错标会让评审者连带怀疑其余每一条。
   */
  it("挑出标成边界值、内容里却找不到任何边界痕迹的用例", () => {
    const g = runGate(
      bundle([
        {
          ...base,
          designMethod: "boundary" as never,
          title: "主人列表页包含 Pets 列标题",
          steps: ["查看表格最右侧列标题"],
          expected: "最右侧列标题为 Pets",
        },
      ]),
    );
    const f = g.findings.find((x) => x.rule === "method-mismatch");
    expect(f?.args?.method).toBe("boundary");
    expect(f?.field).toBe("designMethod");
    // 只提醒，不拦：判断一条用例用的是哪种方法，最终要人来看。
    expect(f?.severity).toBe("info");
  });

  it("真的在验边界的用例不报——一个经常误报的门禁会被关掉，然后它什么也保护不了", () => {
    const g = runGate(
      bundle([
        {
          ...base,
          designMethod: "boundary" as never,
          title: "电话字段留空提交",
          steps: ["telephone 留空", "点击「Add Owner」"],
          expected: "telephone 字段显示「must not be empty」",
        },
      ]),
    );
    expect(g.findings.some((x) => x.rule === "method-mismatch")).toBe(false);
  });

  it("每条 finding 都带 args 与 field，界面才译得出、才点得动", () => {
    const g = runGate(bundle([{ ...base, expected: "页面显示正常" }]));
    const f = g.findings.find((x) => x.rule === "oracle-vague")!;
    // 领域层只产 rule + args，不拼给人看的句子——拼死的句子过了河没有 key，没法译。
    expect(f.args?.expected).toContain("正常");
    expect(f.field).toBe("expected");
  });

  /**
   * 这条规则的下游是一次真事故：一批「新增主人」的用例反复跑，PetClinic 的冻结基线
   * 从 10 个 owner 涨到 13 个。冻结基线校验是事后拦住它的；门禁是源头。
   */
  it("挑出会写数据、却不收拾自己的用例", () => {
    const g = runGate(
      bundle([
        {
          ...base,
          title: "新增主人成功后出现在列表里",
          steps: ["在 firstName 填入 John", "在 lastName 填入 Doe", "点击「Add Owner」提交按钮"],
          expected: "主人列表里出现 John Doe",
          postSteps: [],
        },
      ]),
    );
    expect(g.findings.some((x) => x.rule === "no-cleanup")).toBe(true);
  });

  it("查询不算写——第二版栽在这上面，四条误报全是「填姓氏 + 提交 Find Owner」", () => {
    const g = runGate(
      bundle([
        {
          ...base,
          title: "填入查不到的姓氏提交后显示未找到提示",
          steps: ["在 lastName 输入框填入 zzzznotaproduct", "点击「Find Owner」提交按钮"],
          expected: "页面显示「has not been found」",
          postSteps: [],
        },
      ]),
    );
    expect(g.findings.some((x) => x.rule === "no-cleanup")).toBe(false);
  });

  it("被产品拒绝的写入不算——它什么也没留下", () => {
    const g = runGate(
      bundle([
        {
          ...base,
          title: "新增主人页电话填入字母触发数值校验",
          steps: ["在 telephone 填入 abcdefghij", "点击「Add Owner」提交按钮"],
          expected: "telephone 字段旁显示「numeric value out of bounds」",
          postSteps: [],
        },
      ]),
    );
    expect(g.findings.some((x) => x.rule === "no-cleanup")).toBe(false);
  });

  /**
   * 词表最初没有「登录」，于是 2026-08-30 的 case-cleanup 评测里，B 臂 36 条用例
   * 一条清理都没有、其中一大半是登录用例，这条规则**一条都没抓到**。
   * 登录不写数据，但它留下会话——下一条用例面对的是一个已登录的产品，而它自己不知道。
   */
  it("登录也算改状态——它留下会话，下一条用例面对的产品就不一样了", () => {
    const g = runGate(
      bundle([
        {
          ...base,
          title: "有效凭证登录后显示个人面板",
          steps: ["在用户名输入框填入 ${env.USERNAME}", "在密码框填入 ${secret.PASSWORD}", "点击登录"],
          expected: "页面显示「Welcome」",
          postSteps: [],
        },
      ]),
    );
    expect(g.findings.some((x) => x.rule === "no-cleanup")).toBe(true);
  });

  /**
   * 但在自己步骤里就还原了的不能报——「登录后点 Log out」这条跑完什么也没留下，
   * 而它恰恰是唯一真的在测清理路径的那几条。加宽词表之后这类误报过 3 条。
   */
  it("自己在步骤里登出的不报——报它们最伤人，那是唯一在测清理路径的用例", () => {
    const g = runGate(
      bundle([
        {
          ...base,
          title: "有效登录后点击 Log out 不再显示个人面板",
          steps: ["填入凭证并点击登录", "点击 `Log out` 按钮"],
          expected: "页面不再显示「Welcome」",
          postSteps: [],
        },
      ]),
    );
    expect(g.findings.some((x) => x.rule === "no-cleanup")).toBe(false);
  });

  it("给了清理步骤就不报", () => {
    const g = runGate(
      bundle([
        {
          ...base,
          title: "新增主人成功后出现在列表里",
          steps: ["在 lastName 填入 Doe", "点击「Add Owner」提交按钮"],
          expected: "主人列表里出现 John Doe",
          postSteps: ["删除刚新增的主人 John Doe"],
        },
      ]),
    );
    expect(g.findings.some((x) => x.rule === "no-cleanup")).toBe(false);
  });

  it("marks a credential written into a step instead of a placeholder", () => {
    const g = runGate(bundle([{ ...base, steps: ["输入 password: s3cr3t-pass"] }]));
    expect(g.findings.some((f) => f.rule === "secret")).toBe(true);
  });

  it("reports the tier mix, because 66 judge cases and 66 assert cases are different products", () => {
    const g = runGate(
      bundle([base, { ...base, id: "c2", tier: 3, key: "k2", expected: "界面看起来像话" }]),
    );
    expect(g.stats.tiers).toEqual({ "1": 1, "3": 1 });
  });

  it("notices a story nobody wrote a case for", () => {
    const b = bundle([base]);
    b.stories.push({ id: "US-02", title: "forgotten", acceptance: [] });
    expect(runGate(b).findings.some((f) => f.rule === "story-uncovered")).toBe(true);
  });

  it("scores a clean batch high and a messy one low, and never refuses either", () => {
    const clean = runGate(
      bundle([
        base,
        { ...base, id: "c2", designMethod: "negative", key: "login|wrong|error", expected: "显示 Invalid username or password" },
      ]),
    );
    const messy = runGate(bundle([{ ...base, expected: "一切正常", storyId: "US-42", oracle: undefined }]));
    expect(clean.score).toBeGreaterThan(messy.score);
    expect(messy.score).toBeLessThan(0.5);
  });

  it("calls out a tier the case cannot deliver, and reports both distributions", () => {
    // The label used to be unfalsifiable: every case could claim tier 1 and still be
    // settled by a model looking at a screenshot.
    const claimed = runGate(bundle([{ ...base, oracle: undefined }]));
    expect(claimed.findings.some((f) => f.rule === "tier-unbacked" && f.severity === "warn")).toBe(true);
    expect(claimed.stats.tiers).toEqual({ "1": 1 });
    expect(claimed.stats.tiersBacked).toEqual({ "3": 1 });

    const backed = runGate(bundle([base]));
    expect(backed.findings.some((f) => f.rule === "tier-unbacked")).toBe(false);
    expect(backed.stats.tiersBacked).toEqual({ "1": 1 });

    // An oracle that is really a relation cannot be sold as tier 1 either.
    const overclaimed = runGate(
      bundle([{ ...base, oracle: { kind: "delta" as const, value: "重启次数", direction: "increased" as const } }]),
    );
    expect(overclaimed.findings.some((f) => f.rule === "tier-unbacked" && f.message.includes("tier 2"))).toBe(true);
  });
});

describe("context budget", () => {
  it("trims the specification rather than letting the request grow without bound, and says so", async () => {
    const huge = `${SPEC}\n${"补充说明。".repeat(4000)}`;
    const model = fakeModel();
    const events: Envelope[] = [];
    const bus = new EventBus(new MemoryEventStore(), { coalesceMs: 0 });
    bus.subscribe((e) => events.push(e));
    const { registry, def } = g1(model, { spec: { text: huge }, specText: huge });
    const tight = {
      ...def,
      nodes: def.nodes.map((n) => (n.id === "design" ? { ...n, params: { specText: huge, contextTokens: 1500 } } : n)),
    };

    await runGraph(tight, { registry, bus, store: new MemoryOutputStore() });

    const call = model.calls.find((c) => c.label?.startsWith("design.cases"))!;
    expect(call.variable.length).toBeLessThan(huge.length);
    // 「说所以然」现在长这样：规格按故事检索装入，装不下的段有名字有数目，
    // 提示词里是一句 `[retrieval] … did not fit` 而不是从前的 "trimmed to fit the context budget"。
    expect(call.variable).toContain("[retrieval]");
    expect(call.variable).toMatch(/did not fit|none fit/);
    // The story itself is never trimmed — that is the part the call is about.
    expect(call.variable).toContain("US-01");
    // 日志里同样报的是「未载入几段」，而不是「trimmed」。
    expect(
      events.some((e) => /未载入 [1-9]\d* 段/.test(String((e.payload as { text?: string }).text ?? ""))),
    ).toBe(true);
  });
});

/**
 * 门禁①认出「不是故事的故事」。
 *
 * 实测产出里出现过「页面底部显示社交链接和版权信息」——没有人想要它，它只是一条关于
 * 屏幕的事实，由它衍生的用例做的也只能是「屏幕还是不是原来的样子」。
 * 只标记不拒收：判断一条故事有没有价值最终要人来看，门禁能做的是把该看的挑出来。
 */
describe("gate ① on the stories themselves", () => {
  const kase = {
    id: "c1",
    storyId: "US-01",
    title: "点击 Checkout 进入结账信息页",
    designMethod: "state-transition" as const,
    steps: ["点击 Checkout"],
    expected: "页面显示 Checkout: Your Information",
    tier: 1 as const,
    oracle: { kind: "text" as const, value: "Checkout: Your Information" },
    key: "checkout|cart|step-one", covers: [], sourceRefs: [], postSteps: [],
  };
  const withStories = (stories: unknown[]) =>
    runGate({ origin: "x", flows: [], stories: stories as never, cases: [kase] as never });

  it("说不出谁想要、能得到什么的条目被标出来", () => {
    const r = withStories([{ id: "US-01", title: "页面底部显示社交链接", acceptance: [] }]);
    expect(r.findings.some((f) => f.rule === "story-no-actor")).toBe(true);
  });

  it("有角色有价值的故事不被标", () => {
    const r = withStories([
      { id: "US-01", title: "完成下单", role: "顾客", benefit: "买到东西", acceptance: ["当点击 Checkout 时，进入结账信息页"] },
    ]);
    expect(r.findings.some((f) => f.rule === "story-no-actor")).toBe(false);
  });

  it("验收标准里一条触发都没有，也标出来——那些是描述，不是判据", () => {
    const r = withStories([
      { id: "US-01", title: "结账", role: "顾客", benefit: "下单", acceptance: ["结账页有三个输入框", "页面标题是 Checkout"] },
    ]);
    expect(r.findings.some((f) => f.rule === "acceptance-no-trigger")).toBe(true);
  });

  it("报出有多少故事挂在流程上——故事地图能不能画的前提", () => {
    const r = withStories([
      { id: "US-01", title: "完成下单", role: "顾客", benefit: "买到东西", flowId: "F-1", acceptance: [] },
      { id: "US-02", title: "页脚", acceptance: [] },
    ]);
    expect(r.stats.stories).toBe(2);
    expect(r.stats.storiesAnchored).toBe(1);
  });
});

/**
 * 用例说不说得出自己走了哪条转移。
 *
 * 说不出的那些多半没在验证一次变化，而是在描述一屏——「页面显示 X」。这个比例是结构
 * 覆盖率能不能算的前提，也是「这批用例有多少在测行为」的粗略读数。
 */
describe("gate ① on what a case exercises", () => {
  const mk = (over: Record<string, unknown>) => ({
    id: "c1",
    storyId: "US-01",
    title: "t",
    designMethod: "equivalence" as const,
    precondition: [],
    steps: ["点击"],
    expected: "页面显示 X",
    tier: 1 as const,
    oracle: { kind: "text" as const, value: "X" },
    key: "a|b|c",
    covers: [],
    sourceRefs: [],
    postSteps: [],
    ...over,
  });
  const gate = (cases: unknown[]) =>
    runGate({ origin: "x", flows: [], stories: [{ id: "US-01", title: "s", acceptance: [] }] as never, cases: cases as never });

  it("报出有几条说得出转移", () => {
    const r = gate([mk({ covers: ["/->/inv"] }), mk({ id: "c2" })]);
    expect(r.stats.casesCovering).toBe(1);
  });

  it("声称是状态转移用例却说不出走了哪条转移，标一笔", () => {
    const r = gate([mk({ designMethod: "state-transition" })]);
    expect(r.findings.some((f) => f.rule === "no-transition")).toBe(true);
  });

  it("等价类用例说不出转移是正常的，不标", () => {
    // 「登录页显示六个账号」本来就不改变任何东西。
    const r = gate([mk({ designMethod: "equivalence" })]);
    expect(r.findings.some((f) => f.rule === "no-transition")).toBe(false);
  });
});

/**
 * 用例声称覆盖的转移，规格里得真有。
 *
 * 编出来的引用比说不出更糟：它让结构覆盖率看起来更高，而多出来的那条谁也走不到。
 * 评分那一侧会把它过滤掉（分子只认图上有的），但**过滤掉不等于没发生**——
 * 一条编出来的引用说明这条用例并不知道自己在验证什么。
 */
describe("gate ① on what a case claims to cover", () => {
  const mk = (covers: string[]) => ({
    id: "c1",
    storyId: "US-01",
    title: "t",
    designMethod: "state-transition" as const,
    precondition: [],
    steps: ["点击"],
    expected: "页面显示 X",
    tier: 1 as const,
    oracle: { kind: "text" as const, value: "X" },
    key: "a|b|c",
    covers,
  });
  const bundle = (covers: string[]) => ({
    origin: "x",
    stories: [{ id: "US-01", title: "s", acceptance: [] }] as never,
    flows: [{ id: "F-1", name: "n", purpose: "p", steps: ["登录"], transitions: ["/->/inv"], endsAt: "/inv" }] as never,
    cases: [mk(covers)] as never,
  });

  it("引用规格里有的转移，不标", () => {
    expect(runGate(bundle(["/->/inv"])).findings.some((f) => f.rule === "covers-unknown")).toBe(false);
  });

  it("引用一条规格里没有的转移，标出来", () => {
    const r = runGate(bundle(["/->/nowhere"]));
    expect(r.findings.some((f) => f.rule === "covers-unknown")).toBe(true);
  });

  it("规格里一条流程都没有时不误判——那时无从校验", () => {
    const noFlows = { origin: "x", stories: [{ id: "US-01", title: "s", acceptance: [] }] as never, flows: [] as never, cases: [mk(["/->/x"])] as never };
    expect(runGate(noFlows).findings.some((f) => f.rule === "covers-unknown")).toBe(false);
  });
});

/**
 * `flows` 为空时，`covers` 不能免检（2026-09-11，docs/v3/history/22 §6）。
 *
 * 原来是 `if (known.size)` 才检查——一份没有流程的产物，任何 covers 值都放行。
 * 实测一条真实臂的 27 条用例把状态转移图**人类可读摘要里的一行**当成转移 id 填了进去，
 * 一条都没被点到，门禁还给了满分。
 */
describe("covers 无从核实时要说出来", () => {
  const bundle = (covers: string[], flows: unknown[] = []) => ({
    origin: "t", stories: [{ id: "s1", title: "t", acceptance: [] }], flows,
    cases: [{ id: "c1", storyId: "s1", title: "t", designMethod: "state-transition" as const, tier: 3 as const,
      key: "k", steps: ["点一下"], expected: "页面显示「X」", precondition: [], postSteps: [], sourceRefs: [], covers }],
  });
  it("没有流程可对照 + 填了 covers → covers-unverifiable，且计入分数", () => {
    const r = runGate(bundle(["/a --[点「X」]--> /b"]) as never);
    const f = r.findings.find((x) => x.rule === "covers-unverifiable");
    expect(f).toMatchObject({ severity: "warn", caseId: "c1" });
    expect(r.score).toBe(0);
  });
  it("没有流程且 covers 为空 → 不报这条（只报 no-transition 的 info）", () => {
    const r = runGate(bundle([]) as never);
    expect(r.findings.some((x) => x.rule === "covers-unverifiable")).toBe(false);
    expect(r.score).toBe(1);
  });
  it("有流程时走原来的 covers-unknown，不重复报", () => {
    const flows = [{ id: "f1", name: "f", purpose: "", steps: [], transitions: ["/a->/b"], endsAt: "/b" }];
    const ok = runGate(bundle(["/a->/b"], flows as never) as never);
    expect(ok.findings.some((x) => x.rule.startsWith("covers-"))).toBe(false);
    const bad = runGate(bundle(["/a->/zzz"], flows as never) as never);
    expect(bad.findings.find((x) => x.rule === "covers-unknown")).toBeTruthy();
    expect(bad.findings.some((x) => x.rule === "covers-unverifiable")).toBe(false);
  });
});
