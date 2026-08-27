import { describe, expect, it } from "vitest";
import {
  EventBus,
  FakeModel,
  MemoryEventStore,
  MemoryOutputStore,
  NodeRegistry,
  runGraph,
  type Envelope,
  type GraphDef,
} from "@testpilot/harness-core";
import { codeGenNodes, type CaseExecutor } from "../src/codegen/nodes.js";
import { assertionWeakened, classifyRepair, shouldContinue, tally } from "../src/codegen/repair.js";
import { duplicateRuns, expandActions, extractFragments, parseCode, parseParams } from "../src/codegen/parse.js";
import { runCodeGate } from "../src/codegen/gate.js";
import { ActionSchema, type CodeBundle, type CodeCase, type ExecOutcome, type GatedCodeBundle } from "../src/codegen/types.js";
import type { GatedBundle } from "../src/casegen/types.js";

const textCase = (id: string, title: string, steps: string[], expected: string) => ({
  id,
  storyId: "US-01",
  title,
  designMethod: "equivalence" as const,
  precondition: [],
  steps,
  expected,
  tier: 1 as const,
  key: `${id}|params|assert`,
});

const gatedBundle = (): GatedBundle => ({
  origin: "test",
  stories: [{ id: "US-01", title: "登录", acceptance: [] }],
  cases: [
    textCase("c1", "有效凭证登录", ["输入 ${env.USERNAME}", "输入 ${secret.PASSWORD}", "点击 Sign in"], "显示 Your dashboard is ready."),
    textCase("c2", "退出登录", ["输入 ${env.USERNAME}", "输入 ${secret.PASSWORD}", "点击 Sign in", "点击 Log out"], "显示登录表单"),
  ],
  gate: { score: 1, findings: [], stats: { cases: 2, tiers: { "1": 2 }, tiersBacked: {}, methods: {}, negativeRatio: 0.5, orphans: 0, duplicates: 0 } },
});

const codeFor = (caseId: string): string => {
  if (caseId === "c1")
    return [
      "await agent.aiInput('${env.USERNAME}', 'the username field');",
      "await agent.aiInput('${secret.PASSWORD}', 'the password field');",
      "await agent.aiAction('click the Sign in button');",
      "await agent.aiAssert('the page shows \"Your dashboard is ready.\"');",
    ].join("\n");
  return [
    "await agent.aiInput('${env.USERNAME}', 'the username field');",
    "await agent.aiInput('${secret.PASSWORD}', 'the password field');",
    "await agent.aiAction('click the Sign in button');",
    "await agent.aiAction('click the Log out button');",
    "await agent.aiAssert('the login form is visible again');",
  ].join("\n");
};

function harness(model: FakeModel, executor?: CaseExecutor) {
  const events: Envelope[] = [];
  const bus = new EventBus(new MemoryEventStore(), { coalesceMs: 0 });
  bus.subscribe((e) => events.push(e));
  const registry = new NodeRegistry();
  for (const n of codeGenNodes({ model, executor })) registry.register(n);
  const def: GraphDef = {
    id: "g2",
    version: 1,
    nodes: [
      { id: "codegen", type: "codegen.case" },
      { id: "gate", type: "gate.code" },
      { id: "repair", type: "repair.loop", params: { maxRounds: 2 } },
    ],
    edges: [
      { from: "codegen", to: "gate" },
      { from: "gate", to: "repair" },
    ],
  };
  return { bus, events, registry, def, store: new MemoryOutputStore() };
}

const passing: CaseExecutor = { run: async ({ caseId }) => ({ caseId, status: "passed", ms: 1 }) };

describe("parsing generated code", () => {
  it("reads the allowed calls back as actions", () => {
    const { actions, unsupported } = parseCode(codeFor("c1"));
    expect(actions.map((a) => a.kind)).toEqual(["input", "input", "action", "assert"]);
    expect(actions[0]).toMatchObject({ text: "${env.USERNAME}", field: "the username field" });
    expect(unsupported).toEqual([]);
  });

  it("reports anything outside the allowed surface instead of dropping it silently", () => {
    const { unsupported } = parseCode("await agent.aiQuery('give me the flows');\nawait page.click('#login');");
    expect(unsupported.join(" ")).toMatch(/aiQuery/);
  });

  it("collects the parameters a case reads", () => {
    expect(parseParams(codeFor("c1"))).toEqual(["env.USERNAME", "secret.PASSWORD"]);
  });

  it("lifts a shared prologue into a fragment instead of leaving it copied", () => {
    const cases: CodeCase[] = [
      { caseId: "c1", title: "a", code: "", actions: parseCode(codeFor("c1")).actions, uses: [], params: [] },
      { caseId: "c2", title: "b", code: "", actions: parseCode(codeFor("c2")).actions, uses: [], params: [] },
    ];
    const { cases: folded, fragments } = extractFragments(cases);
    expect(fragments).toHaveLength(1);
    expect(fragments[0].usedBy.sort()).toEqual(["c1", "c2"]);
    expect(fragments[0].actions.length).toBeGreaterThanOrEqual(2);
    expect(folded[0].uses).toEqual([fragments[0].name]);
    // …and running a case still executes the whole thing.
    expect(expandActions(folded[0], fragments).map((a) => a.text)).toEqual(
      parseCode(codeFor("c1")).actions.map((a) => a.text),
    );
  });

  it("never lifts an assertion into shared setup", () => {
    const actions = parseCode("await agent.aiAssert('x');\nawait agent.aiAction('y');").actions;
    const cases: CodeCase[] = [
      { caseId: "c1", title: "a", code: "", actions, uses: [], params: [] },
      { caseId: "c2", title: "b", code: "", actions: [...actions, { kind: "action", text: "z" }], uses: [], params: [] },
    ];
    expect(extractFragments(cases).fragments).toHaveLength(0);
  });

  it("counts duplicated runs that survived extraction", () => {
    const a = { kind: "action" as const, text: "click x" };
    const b = { kind: "action" as const, text: "click y" };
    const cases: CodeCase[] = [
      { caseId: "c1", title: "", code: "", actions: [a, b], uses: [], params: [] },
      { caseId: "c2", title: "", code: "", actions: [a, b], uses: [], params: [] },
    ];
    expect(duplicateRuns(cases)).toBe(1);
  });
});

describe("empty values", () => {
  it("accepts an empty input — leaving a field blank is a test, not a mistake", () => {
    const { actions, unsupported } = parseCode(
      "await agent.aiInput('', 'the username field');\nawait agent.aiAssert('shows \"Invalid username or password\"');",
    );
    expect(actions[0]).toMatchObject({ kind: "input", text: "", field: "the username field" });
    expect(unsupported).toEqual([]);
    expect(ActionSchema.safeParse(actions[0]).success).toBe(true);
  });

  it("still rejects an empty action or assertion", () => {
    expect(ActionSchema.safeParse({ kind: "action", text: "" }).success).toBe(false);
    expect(ActionSchema.safeParse({ kind: "assert", text: "  " }).success).toBe(false);
  });
});

describe("gate ②", () => {
  const bundleOf = (code: CodeCase[], extra: Partial<CodeBundle> = {}): CodeBundle => ({
    origin: "t",
    cases: [],
    fragments: [],
    code,
    failed: [],
    ...extra,
  });
  const mk = (id: string, source: string): CodeCase => ({
    caseId: id,
    title: id,
    code: source,
    actions: parseCode(source).actions,
    uses: [],
    params: parseParams(source),
  });

  it("blocks a case that asserts nothing — that is a visit, not a test", () => {
    const g = runCodeGate(bundleOf([mk("c1", "await agent.aiAction('click Sign in');")]));
    expect(g.findings.some((f) => f.rule === "no-assertion" && f.severity === "block")).toBe(true);
    expect(g.score).toBe(0);
  });

  it("blocks a credential written into the source", () => {
    const g = runCodeGate(
      bundleOf([mk("c1", "await agent.aiInput('password: s3cr3t-pass', 'pw');\nawait agent.aiAssert('ok is shown');")]),
    );
    expect(g.findings.some((f) => f.rule === "inline-secret" && f.severity === "block")).toBe(true);
  });

  // 五种设计方法都要能传进来：这个 helper 原先只收三种，而下面那条真实误报用例的方法
  // 恰恰是 state-transition——类型检查一直是红的，只是测试跑得过所以没人看。
  const textCaseFor = (
    id: string,
    designMethod: "equivalence" | "negative" | "boundary" | "state-transition" | "decision-table",
  ) => ({
    id,
    storyId: "US-01",
    title: id,
    designMethod,
    precondition: [],
    steps: ["step"],
    expected: "something concrete is shown",
    tier: 1 as const,
    key: id,
  });

  it("blocks an invented credential — it fails in a way that blames the product", () => {
    const g = runCodeGate(
      bundleOf(
        [
          mk(
            "c1",
            "await agent.aiInput('testuser', '登录表单的用户名输入框');\nawait agent.aiAssert('页面显示个人面板');",
          ),
        ],
        { cases: [textCaseFor("c1", "equivalence")] },
      ),
    );
    expect(g.findings.some((f) => f.rule === "invented-credential" && f.severity === "block")).toBe(true);
  });

  it("trusts the assertion over the label: a case demanding a refusal may use a bad literal", () => {
    // The generator labels plenty of refusal cases "equivalence"; the assertion is the
    // better evidence of what the case is actually about.
    const g = runCodeGate(
      bundleOf(
        [
          mk(
            "c1",
            "await agent.aiInput('WrongPass123', '密码输入框');\nawait agent.aiAssert('显示 Invalid username or password');",
          ),
        ],
        {
          cases: [
            {
              ...textCaseFor("c1", "equivalence"),
              expected: "页面停留在登录页，且显示错误文案 Invalid username or password",
            },
          ],
        },
      ),
    );
    expect(g.findings.some((f) => f.rule === "invented-credential")).toBe(false);
  });

  it("lets a negative case type a wrong password — that literal IS the test", () => {
    const g = runCodeGate(
      bundleOf(
        [
          mk(
            "c1",
            "await agent.aiInput('WrongPass123', '密码输入框');\nawait agent.aiAssert('显示 Invalid username or password');",
          ),
        ],
        { cases: [textCaseFor("c1", "negative")] },
      ),
    );
    expect(g.findings.some((f) => f.rule === "invented-credential")).toBe(false);
  });

  /**
   * 真实误报（走一遍 2 / wf-mt2xy9j6）：「登录失败后页面URL保持不变」被拦下了。
   *
   * 它的 `designMethod` 是 state-transition，断言写的是**后果**（URL 未跳转）而不是拒绝
   * 本身，于是只看 `expected` 的证据检查漏了它。而给出的建议还是错的：换成 `${env.*}`
   * 会让这次登录成功，可这条用例要的正是它失败。证据落在标题上。
   */
  it("标题也算证据：断言只写了后果的负例不该被拦", () => {
    const g = runCodeGate(
      bundleOf(
        [
          mk(
            "c1",
            "await agent.aiInput('test_user', 'username input field');\nawait agent.aiAssert('The current page URL has not changed');",
          ),
        ],
        {
          cases: [
            {
              ...textCaseFor("c1", "state-transition"),
              title: "登录失败后页面URL保持不变",
              expected: "页面 URL 保持为 http://localhost:5301/testlogin，未发生跳转",
            },
          ],
        },
      ),
    );
    expect(g.findings.some((f) => f.rule === "invented-credential")).toBe(false);
  });

  it("步骤不算证据：用写死凭证本身来豁免写死凭证是循环论证", () => {
    const g = runCodeGate(
      bundleOf(
        [
          mk(
            "c1",
            "await agent.aiInput('testuser', '用户名输入框');\nawait agent.aiAssert('页面显示个人面板');",
          ),
        ],
        {
          cases: [
            {
              ...textCaseFor("c1", "equivalence"),
              title: "使用凭证登录",
              steps: ["输入错误的用户名 testuser", "点击登录"],
              expected: "页面显示个人面板",
            },
          ],
        },
      ),
    );
    expect(g.findings.some((f) => f.rule === "invented-credential" && f.severity === "block")).toBe(true);
  });

  it("does not mistake an empty credential field for an invented one", () => {
    const g = runCodeGate(
      bundleOf([mk("c1", "await agent.aiInput('', '用户名输入框');\nawait agent.aiAssert('显示错误文案');")]),
    );
    expect(g.findings.some((f) => f.rule === "invented-credential")).toBe(false);
  });

  it("accepts a placeholder in a credential field", () => {
    const g = runCodeGate(
      bundleOf([mk("c1", "await agent.aiInput('${env.USERNAME}', '用户名输入框');\nawait agent.aiAssert('显示面板');")]),
    );
    expect(g.findings.some((f) => f.rule === "invented-credential")).toBe(false);
  });

  it("warns about sleeping on a timer instead of on a condition", () => {
    const g = runCodeGate(
      bundleOf([mk("c1", "await sleep(3000);\nawait agent.aiAction('click');\nawait agent.aiAssert('done is shown');")]),
    );
    expect(g.findings.some((f) => f.rule === "raw-sleep" && f.severity === "warn")).toBe(true);
  });

  it("blocks a call outside the allowed surface", () => {
    const g = runCodeGate(bundleOf([mk("c1", "await page.click('#go');\nawait agent.aiAssert('done is shown');")]));
    expect(g.findings.some((f) => f.rule === "unsupported-call")).toBe(true);
  });

  it("counts reuse and parameterisation as first-class stats", () => {
    const c1 = mk("c1", codeFor("c1"));
    const g = runCodeGate(
      bundleOf([c1], { fragments: [{ name: "login", actions: c1.actions.slice(0, 2), usedBy: ["c1", "c2"] }] }),
    );
    expect(g.stats.reuseRatio).toBeGreaterThan(0);
    expect(g.stats.parameterized).toBe(1);
  });

  it("counts a case that could not be generated at all against the batch", () => {
    const g = runCodeGate(bundleOf([], { failed: [{ caseId: "c9", message: "no usable calls" }] }));
    expect(g.score).toBe(0);
    expect(g.findings[0]).toMatchObject({ rule: "codegen-failed", severity: "block" });
  });
});

describe("repair honesty", () => {
  const withAssert = (text: string): CodeCase => ({
    caseId: "c1",
    title: "c1",
    code: "",
    actions: [
      { kind: "action", text: "click Sign in" },
      { kind: "assert", text },
    ],
    uses: [],
    params: [],
  });

  it("spots an assertion that lost the literal it used to check", () => {
    expect(
      assertionWeakened(withAssert('the page shows "Your dashboard is ready."').actions, withAssert("the page changed").actions),
    ).toBe(true);
  });

  it("spots an assertion that disappeared", () => {
    const after: CodeCase = { ...withAssert("x"), actions: [{ kind: "action", text: "click Sign in" }] };
    expect(classifyRepair(withAssert('shows "ready"'), after)).toContain("assertion-semantics");
  });

  it("spots a case that was removed entirely", () => {
    expect(classifyRepair(withAssert("x"), undefined)).toEqual(["case-removed"]);
  });

  it("calls a reworded action what it is, and does not cry weakening", () => {
    const before = withAssert('shows "Your dashboard is ready."');
    const after: CodeCase = {
      ...before,
      actions: [
        { kind: "action", text: "click the blue Sign in button" },
        { kind: "assert", text: 'shows "Your dashboard is ready."' },
      ],
    };
    expect(classifyRepair(before, after)).toEqual(["selector-wording"]);
  });

  it("publishes a strict rate that discounts the greens bought by weakening", () => {
    const outcomes: ExecOutcome[] = [
      { caseId: "c1", status: "passed", ms: 1 },
      { caseId: "c2", status: "passed", ms: 1 },
      { caseId: "c3", status: "failed", ms: 1 },
    ];
    expect(tally(outcomes, ["c2"])).toMatchObject({ loosePassRate: 0.667, strictPassRate: 0.333, degraded: ["c2"] });
  });

  it("stops on the round limit, on no progress, and on an environmental failure", () => {
    expect(shouldContinue({ round: 2, maxRounds: 2, roundsWithoutProgress: 0, maxWithoutProgress: 2 }).go).toBe(false);
    expect(shouldContinue({ round: 0, maxRounds: 5, roundsWithoutProgress: 2, maxWithoutProgress: 2 }).go).toBe(false);
    expect(
      shouldContinue({ round: 0, maxRounds: 5, roundsWithoutProgress: 0, maxWithoutProgress: 2, lastFailKind: "infra" }),
    ).toMatchObject({ go: false, because: expect.stringContaining("environmental") });
    expect(shouldContinue({ round: 0, maxRounds: 5, roundsWithoutProgress: 0, maxWithoutProgress: 2 }).go).toBe(true);
  });
});

describe("G2 end to end", () => {
  it("generates, gates, executes and reports", async () => {
    const model = new FakeModel((req) => codeFor(req.label?.split(":")[1] ?? "c1"));
    const h = harness(model, passing);
    const r = await runGraph(h.def, { registry: h.registry, bus: h.bus, store: h.store, input: gatedBundle() });

    expect(r.status).toBe("done");
    const out = r.outputs.repair as GatedCodeBundle & { repair: { loosePassRate: number; strictPassRate: number } };
    expect(out.code).toHaveLength(2);
    expect(out.fragments).toHaveLength(1); // the shared login was lifted out
    expect(out.gate.stats.withoutAssertion).toBe(0);
    expect(out.repair.loosePassRate).toBe(1);
    expect(out.repair.strictPassRate).toBe(1);
  });

  it("repairs a failing case, and reports the repair as honest when the assertion survives", async () => {
    let attempt = 0;
    const executor: CaseExecutor = {
      run: async ({ caseId }) => {
        if (caseId === "c1" && attempt++ === 0)
          return { caseId, status: "failed", failKind: "locate", message: "cannot find the Sign in button", ms: 1 };
        return { caseId, status: "passed", ms: 1 };
      },
    };
    const model = new FakeModel((req) => {
      if (req.label?.startsWith("repair:"))
        return [
          "await agent.aiInput('${env.USERNAME}', 'the username field');",
          "await agent.aiInput('${secret.PASSWORD}', 'the password field');",
          "await agent.aiAction('click the primary Sign in button at the bottom of the form');",
          "await agent.aiAssert('the page shows \"Your dashboard is ready.\"');",
        ].join("\n");
      return codeFor(req.label?.split(":")[1] ?? "c1");
    });
    const h = harness(model, executor);
    const r = await runGraph(h.def, { registry: h.registry, bus: h.bus, store: h.store, input: gatedBundle() });
    const out = r.outputs.repair as GatedCodeBundle & {
      repair: { rounds: Array<{ changes: string[] }>; loosePassRate: number; strictPassRate: number; degraded: string[] };
    };

    expect(out.repair.rounds).toHaveLength(1);
    expect(out.repair.rounds[0].changes).toContain("selector-wording");
    expect(out.repair.degraded).toEqual([]);
    expect(out.repair.strictPassRate).toBe(out.repair.loosePassRate);
  });

  it("counts a green bought by weakening the assertion as degraded", async () => {
    let attempt = 0;
    const executor: CaseExecutor = {
      run: async ({ caseId }) => {
        if (caseId === "c1" && attempt++ === 0)
          return { caseId, status: "failed", failKind: "assert", message: "assertion failed", ms: 1 };
        return { caseId, status: "passed", ms: 1 };
      },
    };
    const model = new FakeModel((req) => {
      if (req.label?.startsWith("repair:"))
        // the shortest path to green: assert almost nothing
        return [
          "await agent.aiAction('click the Sign in button');",
          "await agent.aiAssert('the page changed');",
        ].join("\n");
      return codeFor(req.label?.split(":")[1] ?? "c1");
    });
    const h = harness(model, executor);
    const r = await runGraph(h.def, { registry: h.registry, bus: h.bus, store: h.store, input: gatedBundle() });
    const out = r.outputs.repair as { repair: { degraded: string[]; loosePassRate: number; strictPassRate: number } };

    expect(out.repair.degraded).toEqual(["c1"]);
    // Both cases pass, but only one of them honestly — and the report says so.
    expect(out.repair.loosePassRate).toBe(1);
    expect(out.repair.strictPassRate).toBe(0.5);
  });

  it("does not retry an environmental failure, and says why it stopped", async () => {
    const executor: CaseExecutor = {
      run: async ({ caseId }) => ({
        caseId,
        status: "failed",
        failKind: "infra",
        failCode: "EXEC_ENV",
        message: "net::ERR_CONNECTION_REFUSED",
        ms: 1,
      }),
    };
    const model = new FakeModel((req) => codeFor(req.label?.split(":")[1] ?? "c1"));
    const h = harness(model, executor);
    const r = await runGraph(h.def, { registry: h.registry, bus: h.bus, store: h.store, input: gatedBundle() });
    const out = r.outputs.repair as { repair: { rounds: unknown[]; stoppedBecause: Record<string, string> } };

    expect(out.repair.rounds).toHaveLength(0); // the model was never asked to fix the network
    expect(Object.values(out.repair.stoppedBecause)[0]).toMatch(/environmental/);
  });

  it("accepts 'this is a product defect' as an answer instead of forcing a fix", async () => {
    const executor: CaseExecutor = {
      run: async ({ caseId }) => ({ caseId, status: "failed", failKind: "assert", message: "no error shown", ms: 1 }),
    };
    const model = new FakeModel((req) =>
      req.label?.startsWith("repair:")
        ? '{"verdict":"product-defect","reason":"the product never shows the error the spec promises"}'
        : codeFor(req.label?.split(":")[1] ?? "c1"),
    );
    const h = harness(model, executor);
    const r = await runGraph(h.def, { registry: h.registry, bus: h.bus, store: h.store, input: gatedBundle() });
    const out = r.outputs.repair as { repair: { stoppedBecause: Record<string, string>; degraded: string[] } };

    expect(Object.values(out.repair.stoppedBecause)[0]).toMatch(/product defect/);
    expect(out.repair.degraded).toEqual([]); // refusing to weaken is not degradation
  });

  it("never executes a case the gate blocked", async () => {
    const seen: string[] = [];
    const executor: CaseExecutor = {
      run: async ({ caseId }) => {
        seen.push(caseId);
        return { caseId, status: "passed", ms: 1 };
      },
    };
    // c2's code asserts nothing → blocked by gate ②
    const model = new FakeModel((req) =>
      req.label === "codegen:c2" ? "await agent.aiAction('click Log out');" : codeFor("c1"),
    );
    const h = harness(model, executor);
    await runGraph(h.def, { registry: h.registry, bus: h.bus, store: h.store, input: gatedBundle() });
    expect(seen).toEqual(["c1"]);
  });
});

describe("a case that assumes it is already somewhere", () => {
  it("hands the preconditions to codegen as something to be reached, not as trivia", async () => {
    // Found by running the bootstrap against a live instance: a case whose precondition was
    // "已进入 Agent 对话界面" generated code that typed into the chat box straight away. The
    // run starts at the application's entry point, so it failed with "当前页面上没有找到发送
    // 按钮。这是一个项目列表页面" — a failure that says nothing about the product.
    const model = new FakeModel(() => "await agent.aiAssert('x');");
    const node = codeGenNodes({ model }).find((n) => n.type === "codegen.case")!;
    const bundle = gatedBundle();
    bundle.cases[0] = { ...bundle.cases[0], precondition: ["已进入 Agent 对话界面"] };
    await node.run(bundle as never, { maxTokens: 400 } as never, {
      nodeId: "codegen",
      ablated: new Set(),
      spend: () => {},
      emit: () => {},
      signal: new AbortController().signal,
    } as never);

    const call = model.calls[0]!;
    expect(call.variable).toContain("已进入 Agent 对话界面");
    // The instruction is in the stable half: it is the same for every case in the batch,
    // which is what keeps the prefix cache hitting.
    expect(call.stable).toMatch(/PRECONDITIONS are a state, not a comment/);
    expect(call.stable).toMatch(/emit the actions that get there BEFORE/);
  });
});

describe("the oracle a program can settle", () => {
  it("reaches the executor from the text case, and survives a repair rewrite", async () => {
    // The verdict must not live inside the generated code: repair rewrites that code, and
    // an oracle carried in it would be rewritten along with the thing it is checking.
    const seen: Array<{ caseId: string; oracle?: unknown }> = [];
    let attempt = 0;
    const executor: CaseExecutor = {
      run: async ({ caseId, oracle }) => {
        seen.push({ caseId, oracle });
        attempt += 1;
        return attempt === 1
          ? { caseId, status: "failed", failKind: "assert", message: "not yet", ms: 1 }
          : { caseId, status: "passed", ms: 1 };
      },
    };
    const model = new FakeModel(() => "await agent.aiAssert('rewritten');");
    const h = harness(model, executor);
    const bundle = gatedBundle();
    bundle.cases = [
      { ...bundle.cases[0], oracle: { kind: "text", value: "Your dashboard is ready." } },
    ];

    const graph: GraphDef = {
      id: "g2",
      version: 1,
      nodes: [
        { id: "codegen", type: "codegen.case" },
        { id: "codegate", type: "gate.code" },
        { id: "repair", type: "repair.loop", params: { maxRounds: 1, limit: 1 } },
      ],
      edges: [
        { from: "codegen", to: "codegate" },
        { from: "codegate", to: "repair" },
      ],
    };
    const res = await runGraph(graph, {
      registry: h.registry,
      bus: h.bus,
      store: new MemoryOutputStore(),
      input: bundle,
    });

    expect(res.status).toBe("done");
    expect(seen).toHaveLength(2); // first run, then the repaired one
    // Both times the same machine oracle, taken from the text case.
    for (const call of seen) expect(call.oracle).toEqual({ kind: "text", value: "Your dashboard is ready." });
  });

  it("passes nothing when the case has no machine oracle, so the judge stays the fallback", async () => {
    const seen: Array<{ oracle?: unknown }> = [];
    const executor: CaseExecutor = {
      run: async ({ caseId, oracle }) => {
        seen.push({ oracle });
        return { caseId, status: "passed", ms: 1 };
      },
    };
    const h = harness(new FakeModel(() => "await agent.aiAssert('x');"), executor);
    const bundle = gatedBundle();
    bundle.cases = [bundle.cases[0]];
    const graph: GraphDef = {
      id: "g2",
      version: 1,
      nodes: [
        { id: "codegen", type: "codegen.case" },
        { id: "codegate", type: "gate.code" },
        { id: "repair", type: "repair.loop", params: { maxRounds: 0, limit: 1 } },
      ],
      edges: [
        { from: "codegen", to: "codegate" },
        { from: "codegate", to: "repair" },
      ],
    };
    await runGraph(graph, { registry: h.registry, bus: h.bus, store: new MemoryOutputStore(), input: bundle });
    expect(seen[0]?.oracle).toBeUndefined();
  });
});
