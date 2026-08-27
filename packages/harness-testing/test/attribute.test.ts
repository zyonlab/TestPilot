import { describe, expect, it } from "vitest";
import { FakeModel } from "@testpilot/harness-core";
import { composeSpecNode, planStoriesNode } from "../src/casegen/nodes.js";
import { locate, overlaps, splitDocuments } from "../src/casegen/attribute.js";

/**
 * 出处必须是查出来的，不能是被问出来的。
 *
 * 「这条故事来自哪份文档」此前是模型自己填的一个字段，而下游没人核对：它可以缺、可以错、
 * 也可以指向一份这次运行根本没读过的文件，三种情况在界面上长得一模一样。于是覆盖率的
 * 依据来自被考核的那一方。这组测试守的是：能定位就定位，定位不到就说定位不到，
 * 声称永远不许冒充事实。
 */

const ctx = (logs: Array<Record<string, unknown>>) =>
  ({
    nodeId: "n",
    ablated: new Set(),
    spend: () => {},
    emit: (kind: string, payload: Record<string, unknown>) => logs.push({ kind, ...payload }),
  }) as never;

const MATERIAL = [
  "===== docs/a.md =====\n登录失败时页面顶部显示「用户名或密码不正确」。",
  "===== docs/b.md =====\n进程页按名称列出每个进程，状态取值为 alive / idle / crashed。",
].join("\n\n");

describe("定位一句原话", () => {
  const docs = splitDocuments(MATERIAL, "docs/a.md, docs/b.md");

  it("按横幅把材料拆回一份份文档", () => {
    expect(docs.map((d) => d.path)).toEqual(["docs/a.md", "docs/b.md"]);
  });

  it("没有横幅时整份算一个文档，名字取 origin——出处是知道的", () => {
    expect(splitDocuments("只有一份", "docs/only.md")[0]).toEqual({
      path: "docs/only.md",
      text: "只有一份",
    });
  });

  it("原话查得到就报出它在哪份", () => {
    expect(locate("用户名或密码不正确", docs)).toBe("docs/a.md");
    expect(locate("状态取值为 alive / idle / crashed", docs)).toBe("docs/b.md");
  });

  it("转述过的句子定位不到——这正是要的，因为它不是原话", () => {
    expect(locate("登录出错会给出提示信息", docs)).toBeUndefined();
  });

  it("太短的片段不定位，否则命中的只是文档长度", () => {
    expect(locate("状态", docs)).toBeUndefined();
  });

  it("连续空白折叠成一个，所以换行和缩进不算差异", () => {
    expect(overlaps("状态取值为   alive / idle / crashed", "状态取值为 alive / idle / crashed")).toBe(true);
    expect(locate("进程页按名称列出每个进程，\n状态取值为 alive / idle / crashed", docs)).toBeUndefined();
  });

  it("标点算差异——界面文案的断言正活在这种细节上", () => {
    expect(locate('显示"用户名或密码不正确"', docs)).toBeUndefined();
  });
});

describe("整理规格时给每条规则定位出处", () => {
  const compose = (rules: Array<{ id: string; text: string; evidence: string }>) => {
    const logs: Array<Record<string, unknown>> = [];
    const node = composeSpecNode({
      model: new FakeModel(() => JSON.stringify({ title: "t", summary: "s", rules, unknowns: ["u"] })),
    });
    return node
      .run({ text: MATERIAL, origin: "docs/a.md, docs/b.md" }, { maxTokens: 3000, maxRules: 60 }, ctx(logs))
      .then((out) => ({ out, logs }));
  };

  it("原话查得到的规则带上它出自哪份", async () => {
    const { out } = await compose([
      { id: "R-01", text: "登录失败要提示", evidence: "登录失败时页面顶部显示「用户名或密码不正确」。" },
    ]);
    expect(out.rules[0].source).toBe("docs/a.md");
  });

  it("给了原话但材料里查不到，单独报一笔——那比没给出处更值得看", async () => {
    const { out, logs } = await compose([
      { id: "R-01", text: "登录失败要提示", evidence: "系统会给出友好的错误提示" },
    ]);
    expect(out.rules[0].source).toBeUndefined();
    expect(logs.some((l) => String(l.text ?? "").includes("定位不到"))).toBe(true);
  });

  it("没给出处和给了假出处不是一回事，两笔分开报", async () => {
    const { logs } = await compose([
      { id: "R-01", text: "a", evidence: "" },
      { id: "R-02", text: "b", evidence: "材料里没有这句话" },
    ]);
    expect(logs.some((l) => String(l.text ?? "").includes("没有材料原话作为出处"))).toBe(true);
    expect(logs.some((l) => String(l.text ?? "").includes("定位不到"))).toBe(true);
  });
});

describe("故事的出处", () => {
  const RULES = [
    {
      id: "R-01",
      text: "登录失败时提示「用户名或密码不正确」",
      evidence: "登录失败时页面顶部显示「用户名或密码不正确」。",
      source: "docs/a.md",
    },
  ];

  const run = async (stories: unknown[], rules = RULES) => {
    const logs: Array<Record<string, unknown>> = [];
    const node = planStoriesNode({ model: new FakeModel(() => JSON.stringify({ stories })) });
    const out = await node.run(
      { text: "x", origin: "docs/a.md, docs/b.md", title: "", rules, unknowns: [], flows: [] },
      { maxStories: 12 },
      ctx(logs),
    );
    return { out, logs };
  };

  it("验收标准对上一条有出处的规则时，出处是定位出来的", async () => {
    const { out } = await run([
      {
        id: "US-01",
        title: "登录失败",
        acceptance: ["登录失败时页面顶部显示「用户名或密码不正确」。"],
      },
    ]);
    expect(out.stories[0].source).toBe("docs/a.md");
    expect(out.stories[0].sourceBy).toBe("located");
  });

  it("定位出来的出处压过模型的说法——查得出的事实不让位给声称", async () => {
    const { out } = await run([
      {
        id: "US-01",
        title: "登录失败",
        acceptance: ["登录失败时页面顶部显示「用户名或密码不正确」。"],
        source: "docs/b.md",
      },
    ]);
    expect(out.stories[0].source).toBe("docs/a.md");
    expect(out.stories[0].sourceBy).toBe("located");
  });

  it("定位不到时用模型的说法，但标明它只是声称", async () => {
    const { out, logs } = await run([
      { id: "US-01", title: "进程页", acceptance: ["能看到进程"], source: "docs/b.md" },
    ]);
    expect(out.stories[0].source).toBe("docs/b.md");
    expect(out.stories[0].sourceBy).toBe("claimed");
    expect(logs.some((l) => String(l.text ?? "").includes("模型声称的"))).toBe(true);
  });

  it("指向一份这次没读过的文档的说法直接丢掉——查无此处的文件名比空着更难发现", async () => {
    const { out } = await run([
      { id: "US-01", title: "别处", acceptance: ["随便"], source: "docs/nowhere.md" },
    ]);
    expect(out.stories[0].source).toBeUndefined();
    expect(out.stories[0].sourceBy).toBeUndefined();
  });
});
