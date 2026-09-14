import {
  CASES_SCHEMA,
  CASES_STABLE,
  CASES_STABLE_PLAIN,
  COMPOSE_SCHEMA,
  STORIES_SCHEMA,
} from "../src/casegen/prompts.js";
import { SpecDocSchema, StorySchema, TextCaseSchema } from "../src/casegen/types.js";
import { checkDesignEvidence } from "../src/casegen/designEvidence.js";
import { validateCases } from "../src/casegen/validate.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { FakeModel } from "@testpilot/harness-core";
import { composeSpecNode, designCasesNode, parseJson, planStoriesNode, sourceExploreNode } from "../src/casegen/nodes.js";

/**
 * A model reply that stops mid-array is indistinguishable from a badly formatted one once
 * it reaches JSON.parse. The server tells us which happened; these keep that answer from
 * being thrown away, because the two have opposite fixes.
 */


describe("a reply that ran out of room", () => {
  it("blames the budget rather than the model's formatting", () => {
    const truncated = '{"stories":[{"id":"US-01","title":"a","acceptance":["x"]},{"id":"US-02"';
    expect(() =>
      parseJson(truncated, z.object({ stories: z.array(z.unknown()) }), "plan.stories", {
        truncated: true,
        maxTokens: 1200,
      }),
    ).toThrow(/cut off at maxTokens \(1200\).*budget problem/s);
  });

  it("stays quiet about the budget when the reply was simply malformed", () => {
    expect(() => parseJson("{oops}", z.object({ a: z.string() }), "plan.stories")).toThrow(
      /not valid JSON —/,
    );
  });
});

describe("a specification that is several documents", () => {
  const twoDocs = [
    "===== docs/a.md =====\n业务：US-01 新建项目",
    "===== docs/b.md =====\n界面：进程页列出各进程状态",
  ].join("\n\n");

  const runStories = async (reply: unknown, origin: string) => {
    const logs: Array<Record<string, unknown>> = [];
    const node = planStoriesNode({ model: new FakeModel(() => JSON.stringify(reply)) });
    const out = await node.run(
      { text: twoDocs, origin, title: "", rules: [], unknowns: [], flows: [], modules: [], screens: [] },
      { maxStories: 12 },
      {
        nodeId: "stories",
        ablated: new Set(),
        spend: () => {},
        emit: (kind: string, payload: Record<string, unknown>) => logs.push({ kind, ...payload }),
      } as never,
    );
    return { out, logs };
  };

  it("names the document a story came from", async () => {
    const { out } = await runStories(
      { stories: [{ id: "US-01", title: "新建项目", acceptance: [], source: "docs/a.md" }] },
      "docs/a.md",
    );
    expect(out.stories[0].source).toBe("docs/a.md");
  });

  it("says out loud when a document produced no story at all", async () => {
    const { logs } = await runStories(
      {
        stories: [
          { id: "US-01", title: "新建项目", acceptance: [], source: "docs/a.md" },
          { id: "US-02", title: "配置环境", acceptance: [], source: "docs/a.md" },
        ],
      },
      "docs/a.md, docs/b.md",
    );
    const said = logs.find((l) => String(l.text ?? "").includes("没有故事出自"));
    expect(said?.text).toContain("docs/b.md");
    expect(said?.text).not.toContain("docs/a.md");
  });

  it("stays quiet when every document contributed", async () => {
    const { logs } = await runStories(
      {
        stories: [
          { id: "US-01", title: "新建项目", acceptance: [], source: "docs/a.md" },
          { id: "US-02", title: "进程页", acceptance: [], source: "docs/b.md" },
        ],
      },
      "docs/a.md, docs/b.md",
    );
    expect(logs.some((l) => String(l.text ?? "").includes("没有故事出自"))).toBe(false);
  });

  it("stays quiet for a single document, where the question does not arise", async () => {
    const { logs } = await runStories(
      { stories: [{ id: "US-01", title: "新建项目", acceptance: [] }] },
      "docs/a.md",
    );
    expect(logs.some((l) => String(l.text ?? "").includes("没有故事出自"))).toBe(false);
  });
});

describe("when the stories do not say where they came from", () => {
  it("says the attribution is missing rather than accusing every document", async () => {
    const logs: Array<Record<string, unknown>> = [];
    const node = planStoriesNode({
      model: new FakeModel(() => JSON.stringify({ stories: [{ id: "US-01", title: "a", acceptance: [] }] })),
    });
    await node.run(
      { text: "x", origin: "docs/a.md, docs/b.md", title: "", rules: [], unknowns: [], flows: [], modules: [], screens: [] },
      { maxStories: 12 },
      {
        nodeId: "stories",
        ablated: new Set(),
        spend: () => {},
        emit: (kind: string, payload: Record<string, unknown>) => logs.push({ kind, ...payload }),
      } as never,
    );
    const said = String(logs.find((l) => String(l.text ?? "").includes("文档"))?.text ?? "");
    expect(said).toContain("无法判断每份材料是否都被覆盖到");
  });
});

describe("the case budget", () => {
  it("reaches the model, and still trims a reply that ignores it", async () => {
    // `maxCasesPerStory` used to be a slice and nothing else: raising it changed how many
    // cases were kept and not how many were designed, so the two settings produced the
    // same batch and comparing them measured run-to-run noise.
    const model = new FakeModel(() =>
      JSON.stringify({
        cases: Array.from({ length: 6 }, (_, i) => ({
          title: `case ${i}`,
          designMethod: "equivalence",
          steps: ["a"],
          expected: "显示 X",
          tier: 1,
          key: `k${i}`,
        })),
      }),
    );
    const node = designCasesNode({ model });
    const out = await node.run(
      { origin: "t", derivedFrom: "document" as const, flows: [], modules: [], stories: [{ id: "US-01", title: "s", acceptance: ["a"] }] },
      { contextTokens: 2000, perStoryMaxTokens: 2000, maxCasesPerStory: 4, specText: "spec", oracleGuidance: "default" as const },
      {
        nodeId: "design",
        ablated: new Set(),
        spend: () => {},
        emit: () => {},
        signal: new AbortController().signal,
      } as never,
    );
    expect(model.calls[0]!.variable).toContain("CASE BUDGET: at most 4 cases");
    // The stable half must stay identical between runs, or the prefix cache never hits.
    expect(model.calls[0]!.stable).not.toContain("CASE BUDGET: at most 4");
    expect(out.cases).toHaveLength(4);
  });
});

describe("the stricter oracle guidance", () => {
  it("is a parameter, so the critic's standing proposal can be compared instead of believed", async () => {
    const run = async (oracleGuidance: "default" | "strict") => {
      const model = new FakeModel(() =>
        JSON.stringify({
          cases: [{ title: "a", designMethod: "equivalence", steps: ["s"], expected: "显示 X", tier: 1, key: "k", covers: [] }],
        }),
      );
      const node = designCasesNode({ model });
      await node.run(
        { origin: "t", derivedFrom: "document" as const, flows: [], modules: [], stories: [{ id: "US-01", title: "s", acceptance: ["a"] }] },
        { contextTokens: 2000, perStoryMaxTokens: 2000, maxCasesPerStory: 4, specText: "spec", oracleGuidance },
        { nodeId: "design", ablated: new Set(), spend: () => {}, emit: () => {}, signal: new AbortController().signal } as never,
      );
      return model.calls[0]!;
    };
    const plain = await run("default");
    const strict = await run("strict");
    expect(plain.stable).not.toContain("WHAT COUNTS AS AN OBSERVABLE PHENOMENON");
    expect(strict.stable).toContain("WHAT COUNTS AS AN OBSERVABLE PHENOMENON");
    // Still in the stable half: a run's prefix is constant, which is what the cache needs.
    expect(strict.variable).not.toContain("WHAT COUNTS AS AN OBSERVABLE PHENOMENON");
  });
});

/**
 * 规格有没有真的到达写用例的那个节点。
 *
 * 这一组存在的理由是一个跑了 21 次都没人发现的洞：`design.cases` 的规格靠图上一个
 * `specText` 参数传，而**建图时只有规格的路径、没有内容**，所以那个参数一直是空串。
 * 全部历史运行里，写每一条用例的那次调用都只看得见故事的标题与验收标准。
 *
 * 没被发现是因为没有任何一处检查过「规格进没进提示词」——产出看起来完全正常，
 * 只是系统性地薄。所以这里断言的不是「有这个字段」，而是**那段文字出现在请求里**。
 */
describe("the specification reaching the node that writes the cases", () => {
  const SPEC = "AC-02.1 密码不正确时显示「Epic sadface: 用户名与密码不匹配」";
  const bundle = {
    origin: "docs/a.md",
    specText: SPEC,
    stories: [{ id: "US-02", title: "凭证错误时被拒绝", acceptance: ["AC-02.1 …"] }],
  };
  const reply = JSON.stringify({
    cases: [
      {
        title: "密码错误被拒绝",
        designMethod: "negative",
        steps: ["输入错误密码", "点击登录"],
        expected: "显示「Epic sadface: 用户名与密码不匹配」",
        tier: 1,
        oracle: { kind: "text", value: "Epic sadface" },
        key: "login|wrong-password|error", covers: [],
      },
    ],
  });
  const ctx = { nodeId: "design", ablated: new Set(), spend: () => {}, emit: () => {}, signal: new AbortController().signal };

  it("carries it down from the stories bundle, not from a graph parameter", async () => {
    const model = new FakeModel(() => reply);
    await designCasesNode({ model }).run(bundle as never, { contextTokens: 8000, perStoryMaxTokens: 6000, maxCasesPerStory: 8, oracleGuidance: "default" } as never, ctx as never);
    expect(model.calls[0].variable).toContain(SPEC);
  });

  it("still lets a non-empty parameter override what came down the graph", async () => {
    const model = new FakeModel(() => reply);
    // 规格现在是**按故事检索**进提示词的（BM25，`../src/retrieve`），不再整段照抄。
    // 所以覆盖用的那份规格得跟故事共享几个词，否则它零命中、根本进不了请求——
    // 那测的就成了检索而不是覆盖。这里让它带上故事标题与验收编号。
    await designCasesNode({ model }).run(
      bundle as never,
      { specText: "另一份规格：US-02 凭证错误时被拒绝 — AC-02.1 显示「Oops」", contextTokens: 8000, perStoryMaxTokens: 6000, maxCasesPerStory: 8, oracleGuidance: "default" } as never,
      ctx as never,
    );
    expect(model.calls[0].variable).toContain("另一份规格");
    expect(model.calls[0].variable).not.toContain(SPEC);
  });

  it("ignores an EMPTY parameter instead of letting it wipe the specification", async () => {
    // 这正是那个洞：图里存着一个空 specText，它每次都「覆盖」成了没有规格。
    const model = new FakeModel(() => reply);
    await designCasesNode({ model }).run(
      bundle as never,
      { specText: "", contextTokens: 8000, perStoryMaxTokens: 6000, maxCasesPerStory: 8, oracleGuidance: "default" } as never,
      ctx as never,
    );
    expect(model.calls[0].variable).toContain(SPEC);
  });

  it("says out loud when it is designing against no specification at all", async () => {
    const logs: string[] = [];
    const model = new FakeModel(() => reply);
    await designCasesNode({ model }).run(
      { ...bundle, specText: undefined } as never,
      { contextTokens: 8000, perStoryMaxTokens: 6000, maxCasesPerStory: 8, oracleGuidance: "default" } as never,
      { ...ctx, emit: (_k: string, p: Record<string, unknown>) => logs.push(String(p.text ?? "")) } as never,
    );
    expect(logs.some((l) => l.includes("没有规格"))).toBe(true);
  });
});

/**
 * 图不该假装自己接好了线。
 *
 * 按路径给规格时，图里存下一个空的 `specText` 看起来像「已接线」——那个空串正是这个洞
 * 藏了这么久的原因。没有内容就不该有这个键。
 */
describe("the graph definition", () => {
  it("omits specText entirely when the specification was given as a path", async () => {
    const { g1Graph } = await import("../src/casegen/graph.js");
    const design = g1Graph({ spec: { path: "fixtures/mock-spec/acme-portal.md" } }).nodes.find((n) => n.id === "design");
    expect(design?.params).not.toHaveProperty("specText");
  });

  it("keeps it when the specification was given inline", async () => {
    const { g1Graph } = await import("../src/casegen/graph.js");
    const design = g1Graph({ spec: { text: "规格全文" } }).nodes.find((n) => n.id === "design");
    expect((design?.params as { specText?: string })?.specText).toBe("规格全文");
  });
});

/**
 * 探索走到几屏，以及它有没有说出自己走到哪为止。
 *
 * 这一层此前恒等于两屏（入口页 + 往前一屏）。对任何一个登录页之后还有几屏的产品，
 * 材料里都缺着大半，而**缺的部分在下游完全看不出来**：规格照样整理得出来、用例照样
 * 生成得出来，只是系统性地少了那几屏对应的一切，最后表现为一个没有解释的覆盖率数字。
 *
 * 循环本身要有浏览器和模型才跑得起来，所以这里钉住的是接线与自陈：参数有没有传下去、
 * 走到几屏有没有报出来、只采到一屏时有没有明说。
 */
describe("how far the exploration got", () => {
  const observerSpy = () => {
    const seen: Array<Record<string, unknown>> = [];
    return {
      seen,
      observer: {
        observe: async (input: Record<string, unknown>) => {
          seen.push(input);
          return { notes: "===== 入口页 =====\nURL: http://x", url: "http://x", screens: 4, stoppedBecause: "连续 2 轮没有发现新界面" };
        },
      },
    };
  };
  const ctx = (events: Array<Record<string, unknown>>) => ({
    nodeId: "explore",
    ablated: new Set(),
    spend: () => {},
    emit: (kind: string, payload: Record<string, unknown>) => events.push({ kind, ...payload }),
    signal: new AbortController().signal,
  });

  it("passes the exploration budget down to whoever has the browser", async () => {
    const { seen, observer } = observerSpy();
    const node = sourceExploreNode({ model: new FakeModel(() => "{}"), observer } as never);
    await node.run(undefined, { deep: true, maxScreens: 8, dryRounds: 3, maxTokens: 2400 } as never, ctx([]) as never);
    expect(seen[0]).toMatchObject({ deep: true, maxScreens: 8, dryRounds: 3 });
  });

  it("reports how many screens it reached and why it stopped", async () => {
    const events: Array<Record<string, unknown>> = [];
    const { observer } = observerSpy();
    const node = sourceExploreNode({ model: new FakeModel(() => "{}"), observer } as never);
    await node.run(undefined, { deep: true, maxScreens: 6, dryRounds: 2, maxTokens: 2400 } as never, ctx(events) as never);
    const out = events.find((e) => e.kind === "wf.node.output");
    // 一屏和六屏产出的规格看起来一样规整，差别只在它没写的那部分——所以屏数必须报出来。
    expect(out).toMatchObject({ screens: 4, stoppedBecause: "连续 2 轮没有发现新界面" });
  });

  it("says so out loud when it only ever saw the entry screen", async () => {
    const events: Array<Record<string, unknown>> = [];
    const observer = {
      observe: async () => ({ notes: "===== 入口页 =====", url: "http://x", screens: 1, stoppedBecause: "连续 2 轮没有发现新界面" }),
    };
    const node = sourceExploreNode({ model: new FakeModel(() => "{}"), observer } as never);
    await node.run(undefined, { deep: true, maxScreens: 6, dryRounds: 2, maxTokens: 2400 } as never, ctx(events) as never);
    expect(events.some((e) => String(e.text ?? "").includes("只覆盖入口页"))).toBe(true);
  });
});

/**
 * 规格的海拔，以及一条硬契约：**路径是事实，名字是判断**。
 *
 * 让模型从屏幕描述里「推断」流程，它会推断出一些看起来合理、实际走不通的流程，而且没人
 * 能查。所以喂给它的是算出来的路径，它只补名字与目的——那才是图上看不出来的东西。
 * 它多说的流程一律丢弃。
 */
describe("the specification's altitudes", () => {
  const material = {
    text: "===== 入口页 =====\nURL: /\n登录按钮",
    origin: "explored http://x",
    derivedFrom: "exploration" as const,
    graph: {
      abstraction: "route+controls",
      entry: "/",
      stoppedBecause: "",
  unvisited: [],
      states: [
        { id: "/", route: "/", title: "登录", controls: [] },
        { id: "/home", route: "/home", title: "首页", controls: [] },
      ],
      transitions: [
        { from: "/", to: "/home", action: { kind: "login" as const, target: "登录表单", selector: "" }, ok: true, walked: true },
      ],
    },
  };
  const ctx = () => {
    const events: Array<Record<string, unknown>> = [];
    return {
      events,
      ctx: {
        nodeId: "spec",
        ablated: new Set(),
        spend: () => {},
        emit: (kind: string, p: Record<string, unknown>) => events.push({ kind, ...p }),
        signal: new AbortController().signal,
      },
    };
  };
  const reply = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      title: "T",
      summary: "S",
      rules: [{ id: "R-1", text: "登录页有登录按钮", evidence: "登录按钮", altitude: "screen", about: "/" }],
      unknowns: ["没试过错误密码"],
      ...extra,
    });

  it("模型给名字，路径仍然来自图", async () => {
    const { ctx: c } = ctx();
    const node = composeSpecNode({ model: new FakeModel(() => reply({ flows: [{ id: "F-1", name: "登录进入首页", purpose: "让用户开始使用" }] })) });
    const out = await node.run(material as never, { maxTokens: 3000, maxRules: 60 } as never, c as never);
    expect(out.flows).toHaveLength(1);
    expect(out.flows[0].name).toBe("登录进入首页");
    // 步骤是算出来的，不是模型写的
    expect(out.flows[0].steps).toEqual(["登录"]);
  });

  it("**模型自己加的流程被丢掉**，并且说出来", async () => {
    const { events, ctx: c } = ctx();
    const node = composeSpecNode({
      model: new FakeModel(() =>
        reply({ flows: [{ id: "F-1", name: "登录" }, { id: "F-9", name: "退款流程", purpose: "凭空来的" }] }),
      ),
    });
    const out = await node.run(material as never, { maxTokens: 3000, maxRules: 60 } as never, c as never);
    expect(out.flows.map((f) => f.id)).toEqual(["F-1"]);
    expect(events.some((e) => String(e.text ?? "").includes("模型自己加的"))).toBe(true);
  });

  it("没命名的路径也留着——一条没有名字的流程仍然是一条流程", async () => {
    const { ctx: c } = ctx();
    const node = composeSpecNode({ model: new FakeModel(() => reply({ flows: [] })) });
    const out = await node.run(material as never, { maxTokens: 3000, maxRules: 60 } as never, c as never);
    expect(out.flows).toHaveLength(1);
    expect(out.flows[0].name).toBe("");
  });

  it("全是屏幕层规则时，说出来", async () => {
    // 一份只有 screen 规则的规格是屏幕清单，不是规格——由它推出的用例只能检查
    // 「屏幕还是不是原来的样子」，而这件事从产出上看不出来。
    const { events, ctx: c } = ctx();
    const node = composeSpecNode({ model: new FakeModel(() => reply({ flows: [] })) });
    await node.run(material as never, { maxTokens: 3000, maxRules: 60 } as never, c as never);
    expect(events.some((e) => String(e.text ?? "").includes("全部是屏幕层规则"))).toBe(true);
  });
});

/**
 * 故事要立得起来：有人、有价值、挂在骨架上。
 *
 * 故事地图（Patton）的横轴是**用户活动按叙事顺序**。横轴必须来自数据——扁平数组画不出
 * 地图，界面只能硬凑一个分类，而硬凑出来的横轴不是骨架。
 *
 * 实测里出现过 `US-10 页面底部显示社交链接和版权信息` 这种条目：没有人想要它，它只是
 * 一条关于屏幕的事实。有了 flow 归属，这类条目至少能被认出来。
 */
describe("stories that stand up", () => {
  const spec = {
    text: "规格全文",
    title: "T",
    origin: "explored http://x",
    derivedFrom: "exploration" as const,
    rules: [],
    unknowns: [],
    flows: [
      { id: "F-1", name: "从登录到结账信息页", purpose: "让用户下单", steps: ["登录", "点购物车", "点 Checkout"], endsAt: "/checkout-step-one.html" },
    ],
  };
  const ctx = () => ({
    nodeId: "stories",
    ablated: new Set(),
    spend: () => {},
    emit: () => {},
    signal: new AbortController().signal,
  });

  const run = async (stories: unknown[]) => {
    const node = planStoriesNode({ model: new FakeModel(() => JSON.stringify({ stories })) });
    return node.run(spec as never, { maxStories: 12 } as never, ctx() as never);
  };

  it("角色与价值跟着故事走下去", async () => {
    const out = await run([
      { id: "US-01", title: "完成下单", role: "顾客", benefit: "买到想要的东西", flowId: "F-1", activity: "从登录到结账信息页", acceptance: ["Given 购物车有一件商品 / When 点击 Checkout / Then 进入结账信息页"] },
    ]);
    expect(out.stories[0].role).toBe("顾客");
    expect(out.stories[0].benefit).toBe("买到想要的东西");
  });

  it("挂在流程上的故事带着骨架位置", async () => {
    const out = await run([{ id: "US-01", title: "完成下单", flowId: "F-1", activity: "从登录到结账信息页", acceptance: [] }]);
    // 这两个字段就是故事地图的横轴，缺了它界面只能硬凑分类。
    expect(out.stories[0].flowId).toBe("F-1");
    expect(out.stories[0].activity).toBe("从登录到结账信息页");
  });

  it("没有流程可挂的条目仍然收下，但它是空的——这正是要能看出来的那一类", async () => {
    const out = await run([{ id: "US-09", title: "页面底部显示社交链接", acceptance: [] }]);
    expect(out.stories[0].flowId).toBeUndefined();
    expect(out.stories[0].activity).toBeUndefined();
  });

  it("规格仍然随故事一起下行（S1 那条修复没被这次改动破坏）", async () => {
    const out = await run([{ id: "US-01", title: "完成下单", acceptance: [] }]);
    expect(out.specText).toBe("规格全文");
  });
});

/**
 * 回复里不止一个 JSON 对象。
 *
 * 原来的做法是「第一个 `{` 到最后一个 `}`」，它假设回复里恰好一个对象。换一个模型之后
 * 这个假设就不成立了：实测收到过 `{…}\n{…}`，切出来那段报「Unexpected non-whitespace
 * character after JSON」——读起来像模型返回的格式坏了，其实是**我们切错了**。
 */
describe("pulling JSON out of a reply that has more than one", () => {
  const shape = z.object({ stories: z.array(z.object({ id: z.string() })).min(1) });

  it("两个对象时取合形状的那一个", () => {
    const reply = '{"note":"thinking out loud"}\n{"stories":[{"id":"US-01"}]}';
    expect(parseJson(reply, shape, "plan.stories").stories[0].id).toBe("US-01");
  });

  it("前面有一段带花括号的解释也不受影响", () => {
    const reply = 'Here is the shape { id, title } I will use:\n{"stories":[{"id":"US-02"}]}';
    expect(parseJson(reply, shape, "plan.stories").stories[0].id).toBe("US-02");
  });

  it("字符串里的花括号不参与配平", () => {
    // 不认字符串，一段带 `}` 的文案会把计数弄乱，切出来的东西解析失败，
    // 报的却是「模型返回的 JSON 不合法」。
    const reply = '{"stories":[{"id":"US-03"}],"note":"用 } 结尾的说明"}';
    expect(parseJson(reply, shape, "plan.stories").stories[0].id).toBe("US-03");
  });

  it("一个都不合形状时，报的是形状不对而不是格式不对", () => {
    expect(() => parseJson('{"a":1}\n{"b":2}', shape, "plan.stories")).toThrow(/expected shape/);
  });

  it("被腰斩的那一个仍然报预算问题", () => {
    // 没闭合的对象也留着当候选，交给上面那句报「这是预算问题，不是格式问题」。
    expect(() =>
      parseJson('{"stories":[{"id":"US-01"', shape, "plan.stories", { truncated: true, maxTokens: 2080 }),
    ).toThrow(/cut off at maxTokens \(2080\).*budget problem/s);
  });
});

/**
 * 模型返回裸数组。
 *
 * TokenHarbor 上 guided decoding 只是**建议**不是强制——实测同一个 schema 要求对象，
 * 回来的是 `[{...},{...}]`。这不是格式坏了，是约束没生效；而它在日志里长得和
 * 「模型返回的 JSON 不合法」一模一样。
 */
describe("a reply that came back as a bare array", () => {
  const shape = z.object({ stories: z.array(z.object({ id: z.string() })).min(1) });

  it("套回它该在的那个键下面", () => {
    expect(parseJson('[{"id":"US-01"},{"id":"US-02"}]', shape, "plan.stories").stories).toHaveLength(2);
  });

  it("对象形式仍然优先——它才是要求的那种", () => {
    const both = '[{"id":"WRONG"}]\n{"stories":[{"id":"US-09"}]}';
    expect(parseJson(both, shape, "plan.stories").stories[0].id).toBe("US-09");
  });

  it("schema 里有不止一个数组字段时不猜", () => {
    // 该套哪个键说不准，套错了会产出一份看起来正常、其实张冠李戴的产物。
    const two = z.object({ a: z.array(z.string()), b: z.array(z.string()) });
    expect(() => parseJson('["x"]', two, "n")).toThrow();
  });
});

describe("故事图的骨架必须比躯干粗", () => {
  const flows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `F-${i + 1}`, name: `流程${i + 1}`, purpose: "", steps: [], transitions: [], endsAt: "/x",
    }));
  const spec = (n: number, mods: Array<{ id: string; name: string; flowIds: string[] }>) => ({
    text: "x", title: "", origin: "explore", rules: [], unknowns: [],
    flows: flows(n), modules: mods.map((m) => ({ ...m, routes: [] })), screens: [],
  });
  const reply = (n: number) => ({
    stories: Array.from({ length: n }, (_, i) => ({
      // 模型给每条故事编了一个独有的活动——这正是要被覆盖掉的东西
      id: `S-0${i + 1}`, title: `故事${i + 1}`, flowId: `F-${i + 1}`,
      activity: `活动${i + 1}`, acceptance: ["Given a / When b / Then c"],
    })),
  });
  const run = async (n: number, mods: Array<{ id: string; name: string; flowIds: string[] }>) => {
    const logs: Array<Record<string, unknown>> = [];
    const node = planStoriesNode({ model: new FakeModel(() => JSON.stringify(reply(n))) });
    const out = await node.run(spec(n, mods), { maxStories: 12 }, {
      nodeId: "stories",
      ablated: new Set(),
      spend: () => {},
      emit: (kind: string, payload: Record<string, unknown>) => logs.push({ kind, ...payload }),
      signal: new AbortController().signal,
    } as never);
    return { out, logs };
  };

  it("活动按模块回填，模型自己编的那个不算数", async () => {
    const { out } = await run(4, [
      { id: "owners", name: "查找与管理主人", flowIds: ["F-1", "F-2", "F-3"] },
      { id: "vets", name: "查看兽医", flowIds: ["F-4"] },
    ]);
    expect(out.stories.map((s) => s.activity)).toEqual([
      "查找与管理主人", "查找与管理主人", "查找与管理主人", "查看兽医",
    ]);
  });

  it("每条故事各自一个活动时报出来——那不是图，是横过来的列表", async () => {
    const { logs } = await run(5, [
      { id: "a", name: "甲", flowIds: ["F-1"] }, { id: "b", name: "乙", flowIds: ["F-2"] },
      { id: "c", name: "丙", flowIds: ["F-3"] }, { id: "d", name: "丁", flowIds: ["F-4"] },
      { id: "e", name: "戊", flowIds: ["F-5"] },
    ]);
    expect(logs.some((l) => String(l.text ?? "").includes("横过来的列表"))).toBe(true);
  });

  it("骨架真的更粗时不报警", async () => {
    const { logs } = await run(5, [{ id: "a", name: "甲", flowIds: ["F-1", "F-2", "F-3", "F-4", "F-5"] }]);
    expect(logs.some((l) => String(l.text ?? "").includes("横过来的列表"))).toBe(false);
  });
});

describe("挂不到流程的故事，活动名也要归一到模块", () => {
  it("模型抄了模块 id 的，换成模块名——同一个模块不该裂成两列", async () => {
    const logs: Array<Record<string, unknown>> = [];
    const node = planStoriesNode({
      model: new FakeModel(() =>
        JSON.stringify({
          stories: [
            { id: "S-01", title: "甲", flowId: "F-1", activity: "随便写的", acceptance: ["Given a / When b / Then c"] },
            // 没有 flowId，活动名是模块 id —— 实测里模型抄的正是规格正文里的粗体 id
            { id: "S-02", title: "乙", activity: "search", acceptance: ["Given a / When b / Then c"] },
            { id: "S-03", title: "丙", activity: "SEARCH", acceptance: ["Given a / When b / Then c"] },
          ],
        }),
      ),
    });
    const out = await node.run(
      {
        text: "x", title: "", origin: "explore", rules: [], unknowns: [],
        flows: [{ id: "F-1", name: "f", purpose: "", steps: [], transitions: [], endsAt: "/x" }],
        modules: [{ id: "search", name: "搜索与浏览商品", flowIds: ["F-1"], routes: [] }],
        screens: [],
      },
      { maxStories: 12 },
      {
        nodeId: "stories", ablated: new Set(), spend: () => {},
        emit: (kind: string, payload: Record<string, unknown>) => logs.push({ kind, ...payload }),
        signal: new AbortController().signal,
      } as never,
    );
    expect(out.stories.map((s) => s.activity)).toEqual([
      "搜索与浏览商品", "搜索与浏览商品", "搜索与浏览商品",
    ]);
  });
});

describe("活动名只能是已知模块——一个瞎编的列头比没有列头更糟", () => {
  it("模型把整段规格正文抄进 activity 时，置空而不是让它变成列头", async () => {
    const logs: Array<Record<string, unknown>> = [];
    const blob = "## 模块\n- **owners** 管理主人　（/owners）\n  > 包含流程：F-1\n".repeat(30);
    const node = planStoriesNode({
      model: new FakeModel(() =>
        JSON.stringify({
          stories: [
            { id: "S-01", title: "甲", activity: blob, acceptance: ["Given a / When b / Then c"] },
            { id: "S-02", title: "乙", activity: "管理主人", acceptance: ["Given a / When b / Then c"] },
          ],
        }),
      ),
    });
    const out = await node.run(
      {
        text: "x", title: "", origin: "explore", rules: [], unknowns: [], flows: [],
        modules: [{ id: "owners", name: "管理主人", flowIds: [], routes: [] }], screens: [],
      },
      { maxStories: 12 },
      {
        nodeId: "stories", ablated: new Set(), spend: () => {},
        emit: (kind: string, payload: Record<string, unknown>) => logs.push({ kind, ...payload }),
        signal: new AbortController().signal,
      } as never,
    );
    expect(out.stories[0]!.activity).toBeUndefined();
    expect(out.stories[1]!.activity).toBe("管理主人");
  });
});

describe("消融臂必须只差一件事", () => {
  it("PLAIN 与现状只差点名方法那几行——别的一个字不动", () => {
    const a = CASES_STABLE.split("\n");
    const b = new Set(CASES_STABLE_PLAIN.split("\n"));
    const only = a.filter((l) => !b.has(l));
    // 六行：一句总述 + 五种方法各一行。多一行就说明砍到了别的东西。
    expect(only).toHaveLength(6);
    expect(only[0]).toContain("Apply test design methods explicitly");
    for (const m of ["equivalence", "boundary", "state-transition", "decision-table", "negative"])
      expect(only.some((l) => l.includes(`"${m}"`))).toBe(true);
  });

  it("判据规范必须留在消融臂里——第一版把它一起砍了，结果那次消融回答不了它问的问题", () => {
    expect(CASES_STABLE_PLAIN).toContain("you MUST also give `oracle`");
    expect(CASES_STABLE_PLAIN).toContain('"kind":"noText"');
    expect(CASES_STABLE_PLAIN).toContain("all happy path is a bad suite");
    expect(CASES_STABLE_PLAIN).toContain("CASE BUDGET");
  });
});

/**
 * **约束解码的 schema 必须和 zod 说同一件事。**
 *
 * 这个坑踩过三次，每次形状一模一样：字段加进了提示词、加进了 zod，独独漏了
 * `CASES_SCHEMA` / `COMPOSE_SCHEMA`。约束解码只允许模型产出 schema 里有的键，
 * 于是模型**一个都产不出来**——而产出看起来完全正常：字段有值（是默认值）、
 * 结构完整、门禁满分。
 *
 * 前两次是 `covers` 和 `modules`，都靠注释提醒下一个人。第三次（`priority` /
 * `postSteps`）我在 `screens` 旁边亲手写下「两处必须同时改」之后，在下一个字段上
 * 又犯了一遍，代价是一次跑完的配对评测两臂产出完全相同——它测的是两组一样的数。
 *
 * 注释拦不住这件事，所以改成测试拦。
 */
describe("给模型的 schema 与给我们的校验必须对齐", () => {
  const modelProduces = (
    (CASES_SCHEMA as { properties: { cases: { items: { properties: Record<string, unknown> } } } })
      .properties.cases.items.properties
  );

  /**
   * 模型不产、由 harness 自己填的字段。
   *
   * 只有这一份名单可以豁免，而且**每一个都要说得出为什么**——一个没有理由的豁免
   * 就是把这条测试关掉。
   */
  const filledByHarness: Record<string, string> = {
    id: "由 harness 从标题生成，模型给的 id 不稳定也不唯一",
    storyId: "这次调用只处理一条故事，id 在调用方手上，问模型等于让它抄一遍",
    /**
     * 这两个是**另一条生成路径**的字段（2026-09-11 单元循环，docs/v3/22）。
     * 它们引用产品模型的 featureId 和规则包的 ruleId——A 臂旧 pipeline 从规格出发，
     * 根本没有产品模型，问它等于让它编 ID。单元循环那条路上由服务端按单元范围校验。
     */
    featureRefs: "只在单元循环路径上有值：A 臂没有产品模型，编不出真实 featureId",
    ruleRefs: "同上：规则 ID 来自规则包，A 臂没有绑定规则包",
    /**
     * v2 设计证据的八个字段（2026-09-11，docs/v3/21 §2 与 §5）。
     *
     * 它们不在 A 臂的约束解码 schema 里，有两条理由，都不是"以后再说"：
     * ① 这些字段引用的是**产品模型与规则包里的 id**（acRefs / conditionRefs / risk.ruleRefs /
     *    design.ruleId / design.stateModelRef）。A 臂从规格出发，手上没有产品模型，
     *    把它们设成 required 等于逼模型编 id——而本仓库已经有过一次教训：
     *    编出来的 `covers` 让结构覆盖率虚高，谁也走不到。
     * ② 这个 schema 里的键必须全部 required（可选键这个模型直接不写，见本文件上面那段）。
     *    八个嵌套结构一律必填，等于要求每条用例都拿得出边界步长、判定行赋值、状态边 id，
     *    而多数用例本来就用不到其中大半——结果只会是形状正确、内容编造。
     *
     * 它们由单元循环那条路径产出：那里规划器拿得到本单元的功能、规则原文与观察，
     * 服务端按单元范围逐字段核对（`designEvidence.ts`）。
     */
    acRefs: "引用故事的验收点 id；A 臂的故事没有稳定验收点 id",
    conditionRefs: "引用测试条件 id；A 臂没有「先条件、后用例」这一层",
    scenarioType: "与 designMethod 的迁移期并存字段，由 v2 路径写；A 臂仍用 designMethod=negative",
    design: "设计证据引用规则包与状态图的 id，A 臂两者都没有，设成必填只会得到编造的证据",
    risk: "risk.ruleRefs 指向规则包；A 臂没有绑定规则包",
    testData: "结构化数据的 source 要能追到规则或标的元数据，A 臂拿不到",
    assertions: "拆开的断言各自带判据；A 臂的返回格式是单个 expected + 单个 oracle",
    readiness: "执行就绪状态取决于 fixture 与账户条件，A 臂不知道这些",
  };

  it("TextCase 的每个字段，要么在 schema 里，要么在豁免名单里", () => {
    const zodKeys = Object.keys(TextCaseSchema.shape);
    const missing = zodKeys.filter((k) => !(k in modelProduces) && !(k in filledByHarness));
    expect(missing, `这些字段 zod 认、schema 不认，模型一个都产不出来：${missing.join(", ")}`).toEqual([]);
  });

  it("schema 里不该有 zod 不认的字段——那是模型白写的 token", () => {
    const zodKeys = new Set(Object.keys(TextCaseSchema.shape));
    const extra = Object.keys(modelProduces).filter((k) => !zodKeys.has(k));
    expect(extra, `schema 允许但 zod 会丢掉：${extra.join(", ")}`).toEqual([]);
  });

  it("优先级与清理步骤确实在里面——这两个是踩出这条测试的那两个", () => {
    expect(modelProduces.priority).toBeDefined();
    expect(modelProduces.postSteps).toBeDefined();
  });

  /**
   * 故事那一步。这里踩的不是「漏了字段」，是「字段在但可选」。
   *
   * 换到 qwen3-8-27b 之后，可选键一律不写：`plan.stories` 每次只回一条故事、
   * 零条验收标准。上一个模型在同样的 schema 下产得出来——所以「可选键会被产出」
   * 从来不是这套代码的保证，只是那个模型的性质。
   *
   * 所以这条测试查的是 required，不只是 properties：提示词**要求**的字段，
   * schema 里必须也要求。
   */
  it("提示词点名要的故事字段，schema 里必须是 required 而不只是可选", () => {
    const req = new Set(
      (STORIES_SCHEMA as unknown as { properties: { stories: { items: { required: readonly string[] } } } })
        .properties.stories.items.required,
    );
    // 这三个都是提示词里明确点名、且下游没有它就干不了活的：
    //   acceptance 是设计用例唯一的对照物；role/benefit 决定这条是不是用户故事。
    for (const k of ["acceptance", "role", "benefit"])
      expect(req.has(k), `${k} 在 schema 里是可选的——这个模型会直接不写`).toBe(true);
  });

  it("故事的字段也要两边对齐", () => {
    const produced = (
      STORIES_SCHEMA as { properties: { stories: { items: { properties: Record<string, unknown> } } } }
    ).properties.stories.items.properties;
    const filledByHarness: Record<string, string> = {
      sourceBy: "出处是定位出来的还是模型自称的，由 harness 拿验收标准回材料里查出来的，不能问模型",
      // 见上面 TextCase 那份名单里的同名两条：产品模型只在单元循环路径上存在。
      featureRefs: "只在单元循环路径上有值：A 臂没有产品模型，编不出真实 featureId",
      ruleRefs: "同上：规则 ID 来自规则包，A 臂没有绑定规则包",
    };
    const missing = Object.keys(StorySchema.shape).filter(
      (k) => !(k in produced) && !(k in filledByHarness),
    );
    expect(missing, `这些字段 zod 认、stories schema 不认：${missing.join(", ")}`).toEqual([]);
  });

  it("规格里下游依赖的三个数组也得是 required——可选就等于不写", () => {
    const req = new Set((COMPOSE_SCHEMA as unknown as { required: readonly string[] }).required);
    // flows/modules/screens 分别是：故事挂流程的线、故事地图的横轴、产品地图上的业务名。
    // 数组为空同样满足 required，所以这不会逼模型编——它只是不允许「装作没这回事」。
    for (const k of ["flows", "modules", "screens"])
      expect(req.has(k), `${k} 在 compose schema 里是可选的——这个模型会直接不写`).toBe(true);
  });

  /** 规格那一步同理。`modules` 在这里漏过一次，`screens` 是最近加的。 */
  it("SpecDoc 的每个字段，要么在 compose schema 里，要么在豁免名单里", () => {
    const produced = (COMPOSE_SCHEMA as { properties: Record<string, unknown> }).properties;
    const assembled: Record<string, string> = {
      text: "规格全文由节点自己拼（要把海拔、流程、模块写进正文），不是模型直接给的一个字段",
      origin: "材料带来的，不是模型的判断",
      derivedFrom: "材料带来的：文档 / 探索 / 代码库——这决定断言能说明什么，更不能让模型自称",
    };
    const missing = Object.keys(SpecDocSchema.shape).filter(
      (k) => !(k in produced) && !(k in assembled),
    );
    expect(missing, `这些字段 zod 认、compose schema 不认：${missing.join(", ")}`).toEqual([]);
  });
});

/**
 * v2 设计证据（docs/v3/21 §2 与 §5）。八个字段全是可选的，所以这些检查只在字段出现时触发——
 * 旧归档一条都不会被点到，而这正是要钉住的：「没给证据」与「给了坏证据」是两件事。
 */
describe("设计证据的确定性校验", () => {
  const base = {
    id: "c1", storyId: "s1", title: "t", designMethod: "boundary" as const, tier: 1 as const,
    key: "k", steps: ["做一件事"], expected: "页面显示「X」", precondition: [], postSteps: [],
    sourceRefs: ["docs/x.md#1"], covers: [] as string[],
  };
  const parse = (over: Record<string, unknown>) => TextCaseSchema.parse({ ...base, ...over });

  it("旧用例（一个 v2 字段都没有）照样通过，一条错都不报", () => {
    expect(checkDesignEvidence([parse({})])).toEqual([]);
  });

  it("方法标签和设计证据说的不是同一种方法 → 报出来", () => {
    const c = parse({ design: { technique: "equivalence", inputDimension: "数量", partitionId: "p1", predicate: "> 0", validity: "valid", representative: "0.001" } });
    expect(checkDesignEvidence([c]).map((e) => e.code)).toContain("design_technique_mismatch");
  });

  it("边界取了两侧却没取边界本身 → 报出来（边界值分析的核心就是那一点）", () => {
    const c = parse({ design: { technique: "boundary", ruleId: "R-SIZE", dimension: "数量", unit: "BTC", bound: "0.001", inclusivity: "inclusive",
      points: [{ at: "below", value: "0.0009" }, { at: "above", value: "0.0011" }] } });
    expect(checkDesignEvidence([c]).map((e) => e.code)).toContain("boundary_without_the_bound");
    const ok = parse({ design: { technique: "boundary", ruleId: "R-SIZE", dimension: "数量", unit: "BTC", bound: "0.001", inclusivity: "inclusive",
      points: [{ at: "at", value: "0.001" }] } });
    expect(checkDesignEvidence([ok])).toEqual([]);
  });

  it("判定表：赋值落在自己没列出的条件上，或漏了某个条件 → 都报", () => {
    const c = parse({ designMethod: "decision-table", design: { technique: "decision-table", tableId: "T1",
      conditionIds: ["c-a", "c-b"], rowId: "r1", assignment: { "c-a": "true", "c-x": "false" }, expectedOutcomeRefs: ["AC-1"] } });
    const codes = checkDesignEvidence([c]).map((e) => e.code);
    expect(codes).toContain("decision_row_unknown_condition");
    expect(codes).toContain("decision_row_missing_condition");
  });

  it("状态迁移：设计证据说走了某条边，covers 里却没有 → 报出来", () => {
    const c = parse({ designMethod: "state-transition", covers: ["/a->/b"],
      design: { technique: "state-transition", stateModelRef: "SM1", from: "/a", event: "点 X", to: "/c", transitionIds: ["/a->/c"] } });
    expect(checkDesignEvidence([c]).map((e) => e.code)).toContain("transition_not_in_covers");
  });

  it("断言 id 重复、tier 1/2 却没有任何判据 → 都报", () => {
    const c = parse({ tier: 2, assertions: [{ id: "a1", statement: "x", ruleRefs: [] }, { id: "a1", statement: "y", ruleRefs: [] }] });
    const codes = checkDesignEvidence([c]).map((e) => e.code);
    expect(codes).toContain("duplicate_assertion_id");
    expect(codes).toContain("assertion_without_oracle");
  });

  it("执行不就绪却不说缺什么 → 报出来；说了就放行", () => {
    expect(checkDesignEvidence([parse({ readiness: { design: "candidate", execution: "requires-fixture" } })]).map((e) => e.code))
      .toContain("readiness_without_reason");
    expect(checkDesignEvidence([parse({ readiness: { design: "candidate", execution: "requires-fixture", reason: "缺可控持仓" } })])).toEqual([]);
  });

  it("给了风险理由却没有优先级 → 理由在解释一个不存在的判断", () => {
    expect(checkDesignEvidence([parse({ risk: { impact: "funds-and-exposure", reason: "减仓方向错会扩大敞口", ruleRefs: ["R-1"] } })]).map((e) => e.code))
      .toContain("risk_without_priority");
  });

  it("validateCases 在证据自相矛盾时拒绝写入，并指出是哪一条", () => {
    const bundle = { origin: "t", stories: [{ id: "s1", title: "t", acceptance: [] }], flows: [],
      cases: [{ ...base, design: { technique: "equivalence", inputDimension: "d", partitionId: "p", predicate: "x", validity: "valid", representative: "1" } }] };
    const v = validateCases(bundle);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.gate).toBe("schema");
    expect(v.reason).toContain("design_technique_mismatch");
  });
});
