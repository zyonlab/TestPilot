import { describe, expect, it } from "vitest";
import { buildLayers, expandPlan, flowKey, slugIdent } from "../src/exportLayers.js";
import { buildExportFiles } from "../src/export.js";
import type { Project, TestCase } from "../src/db.js";

/**
 * 三层抽取：actions / flows / cases。
 *
 * 评审报告里 F-07 的最后两条：「三层目录还没真正生成」「复用 1 个片段覆盖 3 条，
 * 复用率 3/38」。这里钉住的是抽取的**判据**，不是它抽出了什么名字——
 * 名字会随内容变，判据不该变。
 */

const kase = (id: string, steps: string[], over: Partial<TestCase> = {}): TestCase =>
  ({
    id,
    projectId: "p1",
    title: id,
    priority: "P1",
    priorityReason: "",
    runStatus: "notRun",
    hasCode: true,
    type: "functional",
    postSteps: [],
    quarantined: false,
    createdAt: "",
    steps: steps.map((text, i) => ({ order: i + 1, text })),
    ...over,
  }) as TestCase;

describe("三层抽取的判据", () => {
  it("只有一个调用方的不抽——那比内联更糟，多跳一次却什么也没省", () => {
    const l = buildLayers([kase("c1", ["打开首页", "点登录"]), kase("c2", ["查兽医"])]);
    expect(l.flows).toHaveLength(0);
    expect(l.actions).toHaveLength(0);
  });

  it("两条用例共享的前置抽成 flow", () => {
    const l = buildLayers([
      kase("c1", ["打开首页", "点 FIND OWNERS", "查看表格"]),
      kase("c2", ["打开首页", "点 FIND OWNERS", "点第一行"]),
    ]);
    expect(l.flows).toHaveLength(1);
    expect(l.flows[0]!.steps).toEqual(["打开首页", "点 FIND OWNERS"]);
    expect(l.flows[0]!.usedBy.sort()).toEqual(["c1", "c2"]);
  });

  it("前缀之外重复的单步抽成 action", () => {
    const l = buildLayers([
      kase("c1", ["打开首页", "点 A", "截图"]),
      kase("c2", ["打开首页", "点 B", "截图"]),
    ]);
    // 「打开首页」是共享前缀但只有一步，归不到 flow（flow 至少两步）
    expect(l.flows).toHaveLength(0);
    const names = l.actions.map((a) => a.text).sort();
    expect(names).toEqual(["截图", "打开首页"]);
  });

  it("一条用例只归属一个 flow——否则同一段前置会被抽成两个互相嵌套的函数", () => {
    const l = buildLayers([
      kase("c1", ["A", "B", "C", "D"]),
      kase("c2", ["A", "B", "C", "E"]),
      kase("c3", ["A", "B", "X"]),
    ]);
    const owners = l.flows.flatMap((f) => f.usedBy);
    expect(new Set(owners).size).toBe(owners.length);
  });

  /** 这一条是这层抽取的底线：它只改组织，不改语义。 */
  it("展开之后必须和原来的步骤序列逐字相同", () => {
    const cases = [
      kase("c1", ["打开首页", "点 FIND OWNERS", "在 lastName 填 X", "提交"]),
      kase("c2", ["打开首页", "点 FIND OWNERS", "点第一行"]),
      kase("c3", ["打开兽医页", "提交"]),
    ];
    const l = buildLayers(cases);
    for (const c of cases)
      expect(expandPlan(l.plan.get(c.id)!, l), `${c.id} 展开后变了`).toEqual(
        c.steps.map((s) => s.text),
      );
  });

  it("名字由内容决定——同一批用例导两次，得到逐字节相同的工程", () => {
    const cases = [kase("c1", ["打开首页", "点 A"]), kase("c2", ["打开首页", "点 B"])];
    expect(JSON.stringify(buildLayers(cases).actions)).toBe(
      JSON.stringify(buildLayers(cases).actions),
    );
    expect(slugIdent("点击「FIND OWNERS」链接")).toBe(slugIdent("点击「FIND OWNERS」链接"));
  });
});

describe("导出的工程结构", () => {
  const project = { id: "p1", name: "X", targetUrl: "http://x.invalid", targetPlatform: "web", createdAt: "" } as Project;

  it("产出 actions/ 与 flows/ 两层，spec 只 import 自己真的用到的", () => {
    const files = buildExportFiles(project, [
      kase("c1", ["打开首页", "点 FIND OWNERS", "查看表格"], { title: "看表格", activity: "主人" }),
      kase("c2", ["打开首页", "点 FIND OWNERS", "点第一行"], { title: "点一行", activity: "主人" }),
    ]);
    expect(Object.keys(files)).toContain("tests/flows/index.ts");
    const spec = files["tests/主人/看表格.spec.ts"]!;
    expect(spec).toMatch(/from "\.\.\/flows"/);
    // 没用到 actions 就不该 import 它
    expect(spec).not.toMatch(/from "\.\.\/actions"/);
    // 前置变成一次调用，而不是两行原文
    expect(spec).not.toContain("点 FIND OWNERS");
  });

  it("只有一条用例时不抽层——抽什么都是负担", () => {
    const files = buildExportFiles(project, [kase("c1", ["打开首页", "点 A"], { title: "单条" })]);
    expect(Object.keys(files)).not.toContain("tests/flows/index.ts");
    expect(Object.keys(files)).not.toContain("tests/actions/index.ts");
    expect(files["tests/_/单条.spec.ts"]).toContain("打开首页");
  });
});

/**
 * 数据驱动的导出。
 *
 * 判据只有两条，都关乎「失败的时候看得懂吗」和「离开平台还跑得起来吗」：
 * 一行一个 test（报告直接说是第几行），数据随工程走（不回平台取）。
 */
describe("数据驱动的导出", () => {
  const project = { id: "p1", name: "X", targetUrl: "http://x.invalid", targetPlatform: "web", createdAt: "" } as Project;

  it("没绑数据集就是普通的一个 test", () => {
    const files = buildExportFiles(project, [kase("c1", ["点 A"], { title: "普通" })]);
    const spec = files["tests/_/普通.spec.ts"]!;
    expect(spec).not.toContain("for (const");
    expect(Object.keys(files).some((f) => f.startsWith("tests/data/"))).toBe(false);
  });
});

/**
 * 2026-09-14：抽取门槛（至少两条用例用它）让**成员资格随用例增删而变**——
 * 加一条用例，某步骤从 1 个调用方变 2 个，突然被抽走，原本内联它的 spec 跟着改；
 * 删一条则名字消失，所有 import 它的 spec 一起改。后者是破坏性的。
 * 记忆让这一层单调：名字只增不减。
 */
describe("抽取层的记忆", () => {
  const c = (id: string, ...steps: string[]) => kase(id, steps);

  it("没有记忆时，只剩一个调用方的步骤会失去名字", () => {
    const two = buildLayers([c("a", "点击 X", "看 A"), c("b", "点击 X", "看 B")]);
    expect(two.actions.map((x) => x.text)).toContain("点击 X");
    const one = buildLayers([c("a", "点击 X", "看 A")]);
    expect(one.actions.map((x) => x.text)).not.toContain("点击 X");
  });

  it("记忆里有的，一个调用方也保留名字——增量导出不该搅动已有的 spec", () => {
    const kept = buildLayers([c("a", "点击 X", "看 A")], { actions: new Set(["点击 X"]), flows: new Set() });
    expect(kept.actions.map((x) => x.text)).toContain("点击 X");
    // 名字仍然由内容决定，两次抽出来是同一个。
    expect(kept.actions.find((x) => x.text === "点击 X")!.name)
      .toBe(buildLayers([c("a", "点击 X", "看 A"), c("b", "点击 X", "看 B")]).actions.find((x) => x.text === "点击 X")!.name);
  });

  it("共享前置同理，而且展开之后仍然逐字等于原步骤", () => {
    const steps = ["打开首页", "登录"];
    const layers = buildLayers([c("a", ...steps, "看 A")], { actions: new Set(), flows: new Set([flowKey(steps)]) });
    expect(layers.flows).toHaveLength(1);
    expect(expandPlan(layers.plan.get("a")!, layers)).toEqual([...steps, "看 A"]);
  });
})
