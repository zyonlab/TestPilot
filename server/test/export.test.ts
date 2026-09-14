import { describe, expect, it } from "vitest";
import { buildExportFiles } from "../src/export.js";
import type { Project, TestCase } from "../src/db.js";
import { saveDataset } from "../src/datasets.js";

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
    const spec = files["tests/_/密码错误被拒绝.spec.ts"];
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
    const spec = files["tests/_/角标减少.spec.ts"];
    // 前置快照必须在动作之前读，否则量到的是同一个状态。
    expect(spec.indexOf("const before = await bodyText(page)")).toBeLessThan(spec.indexOf("await aiAction("));
    expect(spec).toContain(", before)");
  });

  it("still falls back to the judge when nothing else can decide it", () => {
    const files = buildExportFiles(project, [kase({ title: "只有模型能判", expected: "页面观感正常", tier: 3 })]);
    const spec = files["tests/_/只有模型能判.spec.ts"];
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
    expect(Object.keys(files).filter((f) => f.startsWith("tests/_/"))).toHaveLength(3);
  });

  it("disambiguates with the case id when two titles still collide", () => {
    const files = buildExportFiles(project, [
      kase({ id: "c1", title: "登录" }),
      kase({ id: "c2", title: "登录！" }),
    ]);
    const specs = Object.keys(files).filter((f) => f.startsWith("tests/_/"));
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
    expect(specs).toContain("tests/账号与登录/登录成功.spec.ts");
    expect(specs).toContain("tests/查找宠物主人/查主人.spec.ts");
    expect(specs).toContain("tests/_/说不出属于哪儿.spec.ts");
  });

  it("多一层目录，导入路径要跟着走——否则导出的工程一条都跑不起来", () => {
    const files = buildExportFiles(project, [
      kase({ title: "登录成功", activity: "账号与登录", tier: 1, oracle: { kind: "text", value: "ok" } }),
    ]);
    const spec = files["tests/账号与登录/登录成功.spec.ts"]!;
    expect(spec).toContain('from "../ai"');
    expect(spec).toContain('from "../oracle"');
  });
});

describe("绑了数据集的用例导出成什么", () => {
  const ds = {
    id: "ds1",
    projectId: "p1",
    name: "新增主人",
    columns: ["firstName", "telephone"],
    rows: [
      { firstName: "John", telephone: "6085551023" },
      { firstName: "Jane", telephone: "6085559999" },
    ],
    uniqueCols: ["telephone"],
    createdAt: "",
  };
  const dd = kase({
    id: "cd",
    title: "新增主人成功后出现在列表里",
    dataKey: "新增主人",
    steps: [
      { order: 1, text: "在 firstName 填入 ${row.firstName}" },
      { order: 2, text: "在 telephone 填入 ${row.telephone}" },
    ],
    expected: "主人列表里出现 ${row.firstName}",
  } as Partial<TestCase>);

  /**
   * 这条钉的是一个真犯过的 bug：第一版拿正则去改写**已经生成好的代码**，
   * 而 `lit()` 早就把步骤包进了 JSON 双引号，于是导出的是
   * `aiAction("在 firstName 填入 ${r.firstName}")`——双引号不插值，
   * 那串字会被原样输进表单，没有任何一层会报错。
   */
  it("占位符要变成真的取值，不能原样留在字符串里", () => {
    saveDataset({ projectId: "p1", name: ds.name, rows: ds.rows, uniqueCols: ds.uniqueCols });
    const files = buildExportFiles(project, [dd]);
    const spec = files["tests/_/新增主人成功后出现在列表里.spec.ts"]!;
    expect(spec).toContain('aiAction("在 firstName 填入 " + r["firstName"])');
    expect(spec).toContain('aiAssert("主人列表里出现 " + r["firstName"])');
    // 反过来：整个文件里不许再出现「占位符被当成字面量」的形态。
    expect(spec).not.toMatch(/"[^"\n]*\$\{(row|r)\./);
    // 数据随工程走，不是运行时去平台上取。
    expect(files["tests/data/新增主人.json"]).toContain("6085551023");
  });

  it("一行一个 test，且标了唯一的列才加后缀", () => {
    saveDataset({ projectId: "p1", name: ds.name, rows: ds.rows, uniqueCols: ds.uniqueCols });
    const spec = buildExportFiles(project, [dd])["tests/_/新增主人成功后出现在列表里.spec.ts"]!;
    // 失败时报告要能直接说是第几行。
    expect(spec).toContain("第 ${i + 1} 行");
    expect(spec).toContain('"telephone": uniq(row["telephone"] ?? "")');
    // firstName 没标唯一，就不许被动过——加后缀会改变值。
    expect(spec).not.toContain('"firstName": uniq');
  });

  it("没绑数据集时占位符原样保留：那是 checkBinding 该报的 bug，不是导出该偷偷修的", () => {
    const spec = buildExportFiles(project, [kase({ ...dd, id: "c2", dataKey: undefined } as Partial<TestCase>)])[
      "tests/_/新增主人成功后出现在列表里.spec.ts"
    ]!;
    expect(spec).toContain('aiAction("在 firstName 填入 ${row.firstName}")');
  });
});

/**
 * 2026-09-14 用户的要求：「要兼顾测试工程里的可变不可变……每个用例生成项目中可变的部分」。
 * 这一组钉住那条分界线，以及它在路径与文件头上的落点。
 */
describe("可变与不可变", () => {
  it("路径只由不会变的东西组成：优先级改了，文件不该改名", () => {
    const p0 = buildExportFiles(project, [kase({ title: "看订单簿", storyId: "S-MB-01", priority: "P0" })]);
    const p1 = buildExportFiles(project, [kase({ title: "看订单簿", storyId: "S-MB-01", priority: "P1" })]);
    const specOf = (f: Record<string, string>) => Object.keys(f).filter((k) => k.endsWith(".spec.ts"));
    expect(specOf(p0)).toEqual(["tests/s-mb-01/看订单簿.spec.ts"]);
    // 同一条用例、同一个路径；变的只是文件里的 tag。
    expect(specOf(p1)).toEqual(specOf(p0));
    expect(p0[specOf(p0)[0]!]).toContain("@P0");
    expect(p1[specOf(p1)[0]!]).toContain("@P1");
  });

  it("没有 activity 就按用户故事分目录——242 条全塌在 tests/_ 的原因就是只看 activity", () => {
    const files = buildExportFiles(project, [
      kase({ id: "a", title: "甲", storyId: "S-01" }),
      kase({ id: "b", title: "乙", storyId: "S-02" }),
      kase({ id: "c", title: "丙" }),
    ]);
    const specs = Object.keys(files).filter((k) => k.endsWith(".spec.ts"));
    expect(specs.sort()).toEqual(["tests/_/丙.spec.ts", "tests/s-01/甲.spec.ts", "tests/s-02/乙.spec.ts"]);
  });

  it("每个文件都说清自己归谁：生成物会被覆盖，脚手架不会", () => {
    const files = buildExportFiles(project, [kase({ title: "看订单簿", storyId: "S-MB-01" })]);
    expect(files["tests/s-mb-01/看订单簿.spec.ts"]).toMatch(/^\/\/ 由 TestPilot 生成/);
    expect(files["playwright.config.ts"]).toMatch(/^\/\/ TestPilot 脚手架/);
    expect(files["tests/ai.ts"]).toMatch(/^\/\/ TestPilot 脚手架/);
    // 机器可读的那份划分，将来「导出到已有目录」要用它，不该再靠路径猜。
    const manifest = JSON.parse(files["testpilot-manifest.json"]!) as { ownership: Record<string, string[]> };
    expect(manifest.ownership.generated).toContain("tests/s-mb-01/看订单簿.spec.ts");
    expect(manifest.ownership.scaffold).toContain("playwright.config.ts");
    expect(manifest.ownership.generated).not.toContain("playwright.config.ts");
  });

  it("追溯线进 tag，人和 --grep 都用得上", () => {
    const files = buildExportFiles(project, [kase({ title: "看订单簿", storyId: "S-MB-01", tier: 1, requirementId: "REQ-9" })]);
    expect(files["tests/s-mb-01/看订单簿.spec.ts"]).toContain("[@P0 @negative @story:S-MB-01 @tier1 @req:REQ-9]");
  });

  /**
   * `@story:` 只到故事一层，而一条故事有两三条准则——红了还是得回平台猜是哪一条。
   * 2026-09-14 起 `acRefs` 是稳定编号，一路带到导出为止。
   */
  it("兑现了哪几条验收准则，也要能 --grep 到", () => {
    const files = buildExportFiles(project, [
      kase({ title: "看订单簿", storyId: "S-MB-01", acRefs: ["S-MB-01/AC-1", "S-MB-01/AC-2"] }),
    ]);
    const spec = files["tests/s-mb-01/看订单簿.spec.ts"]!;
    expect(spec).toContain("@ac:S-MB-01/AC-1 @ac:S-MB-01/AC-2");
  });

  it("没有 acRefs 的老用例安全降级——不写空标签", () => {
    const spec = buildExportFiles(project, [kase({ title: "看订单簿", storyId: "S-MB-01" })])["tests/s-mb-01/看订单簿.spec.ts"]!;
    expect(spec).not.toContain("@ac:");
  });
});

describe("入口导航不交给视觉模型", () => {
  const nav = (text: string, ...rest: string[]) =>
    kase({ title: "甲", storyId: "S-01", steps: [text, ...rest].map((t, i) => ({ order: i + 1, text: t })) });

  it("首步的裸导航提成 page.goto，并从步骤里去掉", () => {
    const files = buildExportFiles(project, [nav("打开 https://www.saucedemo.com/inventory.html", "点击 Add to cart")]);
    const spec = files["tests/s-01/甲.spec.ts"]!;
    expect(spec).toContain('page.goto(process.env.BASE_URL || "https://www.saucedemo.com/inventory.html")');
    expect(spec).not.toContain('aiAction("打开 https');
    expect(spec).toContain('aiAction("点击 Add to cart")');
  });

  it("「并等待页面加载完成」是泛化等待，丢掉——page.goto 本来就等", () => {
    const spec = buildExportFiles(project, [nav("打开 https://www.saucedemo.com/ 并等待页面加载完成", "点击 Login")])["tests/s-01/甲.spec.ts"]!;
    expect(spec).not.toContain("等待");
  });

  it("「并等待订单簿视图加载」是真条件，留成一步，语义一个字不变", () => {
    const spec = buildExportFiles(project, [nav("打开 https://www.saucedemo.com/ 并等待订单簿视图加载", "点击 Login")])["tests/s-01/甲.spec.ts"]!;
    expect(spec).toContain('aiAction("等待订单簿视图加载")');
    expect(spec).not.toContain('aiAction("打开');
  });

  it("「打开设置面板」不是导航，不动它", () => {
    const spec = buildExportFiles(project, [nav("打开设置面板", "点击 Login")])["tests/s-01/甲.spec.ts"]!;
    expect(spec).toContain('aiAction("打开设置面板")');
  });
});
