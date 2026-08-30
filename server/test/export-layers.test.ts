import { describe, expect, it } from "vitest";
import { buildLayers, expandPlan, slugIdent } from "../src/exportLayers.js";
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
    const spec = files["tests/主人/p1-看表格.spec.ts"]!;
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
    expect(files["tests/_/p1-单条.spec.ts"]).toContain("打开首页");
  });
});
