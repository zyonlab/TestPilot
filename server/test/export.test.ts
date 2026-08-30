import { describe, expect, it } from "vitest";
import { buildExportFiles } from "../src/export.js";
import type { Project, TestCase } from "../src/db.js";

/**
 * 导出的工程是这条流水线的最后一格，也是唯一一格离开平台之后还要自己跑得起来的。
 *
 * 这里钉住的两件事都是实测撞到的：导出会把机器判据打回 `aiAssert`，
 * 以及中文标题的用例会写进同一个文件互相覆盖。
 */

const project = {
  id: "p1",
  name: "Swag Labs",
  targetUrl: "https://www.saucedemo.com",
  targetPlatform: "web",
  createdAt: "",
} as Project;

const base = {
  projectId: "p1",
  priority: "P0" as const,
  priorityReason: "",
  runStatus: "idle" as const,
  hasCode: true,
  type: "negative" as const,
  postSteps: [],
  quarantined: false,
  createdAt: "",
};
const kase = (over: Partial<TestCase>): TestCase =>
  ({ ...base, id: "c1", title: "t", steps: [{ order: 1, text: "点击 Login" }], ...over }) as TestCase;

describe("what the exported suite uses as its verdict", () => {
  it("settles a tier-1 case with a program, not with a model looking at a screenshot", () => {
    const files = buildExportFiles(project, [
      kase({ title: "密码错误被拒绝", expected: "显示 Epic sadface", tier: 1, oracle: { kind: "text", value: "Epic sadface" } }),
    ]);
    const spec = files["tests/_/p0-密码错误被拒绝.spec.ts"];
    expect(spec).toContain('checkOracle(page, {"kind":"text","value":"Epic sadface"})');
    // 判据是程序判的，就不该再让模型看一眼屏幕——那正是 tier 一路被打回原形的方式。
    expect(spec).not.toContain("aiAssert");
    // 断言原文留下来，人还要读它。
    expect(spec).toContain("显示 Epic sadface");
    expect(files["tests/oracle.ts"]).toContain("export async function checkOracle");
  });

  it("takes the before-snapshot a relation needs", () => {
    const files = buildExportFiles(project, [
      kase({ title: "角标减少", tier: 2, oracle: { kind: "delta", value: "购物车", direction: "decreased", by: 1 } }),
    ]);
    const spec = files["tests/_/p0-角标减少.spec.ts"];
    // 前置快照必须在动作之前读，否则量到的是同一个状态。
    expect(spec.indexOf("const before = await bodyText(page)")).toBeLessThan(spec.indexOf("await aiAction("));
    expect(spec).toContain(", before)");
  });

  it("still falls back to the judge when nothing else can decide it", () => {
    const files = buildExportFiles(project, [kase({ title: "只有模型能判", expected: "页面观感正常", tier: 3 })]);
    const spec = files["tests/_/p0-只有模型能判.spec.ts"];
    expect(spec).toContain('aiAssert("页面观感正常")');
    expect(spec).not.toContain("checkOracle");
  });
});

describe("one file per case", () => {
  it("keeps CJK in the filename instead of collapsing every Chinese title onto one file", () => {
    // 剥掉 CJK 之后每条标题都塌成空串、退回 "case"：一批中文用例导出之后只剩最后一条，
    // 而且一声不响。这个平台产出的用例标题**就是**中文的。
    const files = buildExportFiles(project, [
      kase({ id: "c1", title: "密码错误被拒绝" }),
      kase({ id: "c2", title: "用户名为空" }),
      kase({ id: "c3", title: "被锁定的账号" }),
    ]);
    expect(Object.keys(files).filter((f) => f.startsWith("tests/_/p0-"))).toHaveLength(3);
  });

  it("disambiguates with the case id when two titles still collide", () => {
    const files = buildExportFiles(project, [
      kase({ id: "c1", title: "登录" }),
      kase({ id: "c2", title: "登录！" }),
    ]);
    const specs = Object.keys(files).filter((f) => f.startsWith("tests/_/p0-"));
    expect(specs).toHaveLength(2);
    expect(specs.some((f) => f.includes("c2"))).toBe(true);
  });
});

/**
 * 按模块建目录。
 *
 * 此前全部平铺在 `tests/` 下，前缀是优先级——而优先级此前恒为 P1（设计节点从不产出），
 * 于是两千条用例就是两千个 `p1-*.spec.ts` 挤在一个目录里。
 */
describe("导出的目录按模块分", () => {
  it("有模块的进模块目录，没有的进 tests/_，谁也不假装有归属", () => {
    const files = buildExportFiles(project, [
      kase({ id: "c1", title: "登录成功", activity: "账号与登录" }),
      kase({ id: "c2", title: "查主人", activity: "查找宠物主人" }),
      kase({ id: "c3", title: "说不出属于哪儿" }),
    ]);
    const specs = Object.keys(files).filter((f) => f.endsWith(".spec.ts"));
    expect(specs).toContain("tests/账号与登录/p0-登录成功.spec.ts");
    expect(specs).toContain("tests/查找宠物主人/p0-查主人.spec.ts");
    expect(specs).toContain("tests/_/p0-说不出属于哪儿.spec.ts");
  });

  it("多一层目录，导入路径要跟着走——否则导出的工程一条都跑不起来", () => {
    const files = buildExportFiles(project, [
      kase({ title: "登录成功", activity: "账号与登录", tier: 1, oracle: { kind: "text", value: "ok" } }),
    ]);
    const spec = files["tests/账号与登录/p0-登录成功.spec.ts"]!;
    expect(spec).toContain('from "../ai"');
    expect(spec).toContain('from "../oracle"');
  });
});
