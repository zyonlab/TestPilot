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
      { text: twoDocs, origin, title: "", rules: [], unknowns: [], flows: [] },
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
      { text: "x", origin: "docs/a.md, docs/b.md", title: "", rules: [], unknowns: [], flows: [] },
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
      { origin: "t", derivedFrom: "document" as const, flows: [], stories: [{ id: "US-01", title: "s", acceptance: ["a"] }] },
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
        { origin: "t", derivedFrom: "document" as const, flows: [], stories: [{ id: "US-01", title: "s", acceptance: ["a"] }] },
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
    await designCasesNode({ model }).run(
      bundle as never,
      { specText: "另一份规格", contextTokens: 8000, perStoryMaxTokens: 6000, maxCasesPerStory: 8, oracleGuidance: "default" } as never,
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
      states: [
        { id: "/", route: "/", title: "登录", controls: [] },
        { id: "/home", route: "/home", title: "首页", controls: [] },
      ],
      transitions: [
        { from: "/", to: "/home", action: { kind: "login" as const, target: "登录表单", selector: "" }, ok: true },
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
