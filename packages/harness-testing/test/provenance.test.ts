import { describe, expect, it } from "vitest";
import { FakeModel } from "@testpilot/harness-core";
import { caseGenNodes, type ProductObserver } from "../src/casegen/index.js";

/**
 * 规格是怎么来的，必须一路传到用例上。
 *
 * 这不是元数据洁癖。一条对着**人写的规格**写的用例挂了，可能意味着「产品错了」；
 * 一条对着**观察出来的规格**写的用例挂了，只能意味着「产品变了」——观察不可能反驳被观察者。
 * 把这个印记丢在半路上，一套完全建立在观察之上的绿色套件，就会被读成「产品是对的」。
 */

const ctx = () => ({
  nodeId: "n",
  signal: new AbortController().signal,
  spend: () => undefined,
  emit: () => undefined,
  /** 什么都没关掉：这些测试量的是印记有没有传下去，不是消融。 */
  ablated: new Set<string>(),
});

const nodes = (model: FakeModel, observer?: ProductObserver) =>
  Object.fromEntries(
    caseGenNodes({ model: model as never, baseDir: process.cwd(), observer }).map((n) => [n.type, n]),
  ) as Record<string, any>;

describe("规格的来源印记", () => {
  it("explore 只产观察记录，标着 exploration —— 整理成规格不是它的事", async () => {
    const observer: ProductObserver = {
      observe: async () => ({ notes: "登录页：用户名、密码、登录按钮", url: "http://localhost:5301/testlogin" }),
    };
    const n = nodes(new FakeModel(() => "不该被调用"), observer);
    const out = await n["source.explore"].run(undefined, { deep: true }, ctx());
    expect(out.derivedFrom).toBe("exploration");
    expect(out.origin).toContain("http://localhost:5301/testlogin");
    // 原话，不是模型改写过的东西：改写发生在 spec.compose，且那一步要求逐句有出处。
    expect(out.text).toBe("登录页：用户名、密码、登录按钮");
  });

  it("没有观察能力时说清楚，而不是悄悄产出一份空规格", async () => {
    const n = nodes(new FakeModel(() => ""));
    await expect(n["source.explore"].run(undefined, { deep: false, maxTokens: 800 }, ctx())).rejects.toThrow(
      /no way to reach the product/,
    );
  });

  it("整理不出任何规则时报错——一份空规格会让下游产出凭空捏造的故事", async () => {
    const n = nodes(new FakeModel(() => JSON.stringify({ rules: [], unknowns: [] })));
    await expect(
      n["spec.compose"].run({ text: "材料", origin: "docs/a.md" }, { maxTokens: 900, maxRules: 60 }, ctx()),
    ).rejects.toThrow(/no rules/);
  });

  it("三种来源整理成同一个形状，印记原样保留", async () => {
    const reply = JSON.stringify({
      title: "被测产品",
      summary: "一句话",
      rules: [{ id: "R-1", text: "登录后显示面板", evidence: "Your dashboard is ready." }],
      unknowns: ["注册流程材料里没有"],
    });
    const n = nodes(new FakeModel(() => reply));
    for (const from of ["document", "exploration"] as const) {
      const out = await n["spec.compose"].run(
        { text: "材料", origin: "o", derivedFrom: from },
        { maxTokens: 900, maxRules: 60 },
        ctx(),
      );
      expect(out.derivedFrom).toBe(from);
      expect(out.rules[0].id).toBe("R-1");
      // 出处是材料里的原话：一条引不出原话的规则，和模型顺手编的一句在下游分不清。
      expect(out.rules[0].evidence).toContain("dashboard");
      expect(out.unknowns).toHaveLength(1);
      expect(out.text).toContain("## 没有答案的地方");
    }
  });

  it("印记穿过 plan.stories 传下去", async () => {
    const n = nodes(new FakeModel(() => JSON.stringify({ stories: [{ id: "S-1", title: "登录", acceptance: ["能登录"] }] })));
    const out = await n["plan.stories"].run(
      { text: "spec", origin: "explored http://x", derivedFrom: "exploration" },
      { maxStories: 5 },
      ctx(),
    );
    expect(out.derivedFrom).toBe("exploration");
  });

  it("印记穿过 design.cases 传到用例批次上", async () => {
    const n = nodes(
      new FakeModel(() =>
        JSON.stringify({
          cases: [
            {
              key: "login-ok", covers: [],
              title: "能登录",
              designMethod: "equivalence",
              steps: ["输入", "点击"],
              expected: "显示「欢迎」",
              tier: 1,
            },
          ],
        }),
      ),
    );
    const out = await n["design.cases"].run(
      { origin: "explored http://x", derivedFrom: "exploration", stories: [{ id: "S-1", title: "登录", acceptance: ["能登录"] }] },
      { lang: "zh", maxCasesPerStory: 2 },
      ctx(),
    );
    expect(out.derivedFrom).toBe("exploration");
    expect(out.cases.length).toBeGreaterThan(0);
  });

  it("人写的文档不带印记时读作 document——这个字段是后加的，旧材料本来就没有", async () => {
    const n = nodes(new FakeModel(() => JSON.stringify({ stories: [{ id: "S-1", title: "t", acceptance: [] }] })));
    const out = await n["plan.stories"].run({ text: "spec", origin: "docs/a.md" }, { maxStories: 3 }, ctx());
    expect(out.derivedFrom ?? "document").toBe("document");
  });
});
