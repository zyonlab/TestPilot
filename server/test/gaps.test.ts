import { describe, expect, it } from "vitest";
import { computeGaps } from "../src/gaps.js";

/**
 * 缺口的意义全在那条分界上：**没测到**（能补一条用例）和**没看到**（得重跑探索）
 * 对人来说是两个完全不同的下一步。混着报，人只得到一个焦虑的数字。
 */
const graph = {
  states: [
    { id: "/owners/find", route: "/owners/find" },
    { id: "/owners", route: "/owners" },
    { id: "/vets", route: "/vets" },
  ],
  transitions: [
    { from: "/owners/find", to: "/owners", ok: true, walked: true, action: { kind: "click", target: "Find Owner" } },
    { from: "/owners", to: "/vets", ok: true, walked: true, action: { kind: "goto", target: "/vets" } },
    { from: "/owners", to: "/owners", ok: true, walked: true, action: { kind: "click", target: "刷新" } },
    { from: "/vets", to: "/owners/find", ok: true, walked: false, action: { kind: "goto", target: "/owners/find" } },
    { from: "/vets", ok: false, walked: true, note: "超时", action: { kind: "click", target: "导出" } },
  ],
};
const spec = {
  modules: [
    { id: "owners", name: "查找并管理主人", flowIds: ["F-1"], routes: ["/owners/find", "/owners"] },
    { id: "vets", name: "浏览兽医", flowIds: ["F-2"], routes: ["/vets"] },
  ],
  flows: [{ id: "F-1", name: "查主人" }, { id: "F-2", name: "看兽医" }],
  unknowns: ["材料没说清删除主人会怎样"],
};

describe("缺口", () => {
  it("走过但没人验的转移算「没测到」", () => {
    const g = computeGaps({ graph, spec, cases: [], stories: [] });
    const t = g.filter((x) => x.kind === "transition");
    expect(t).toHaveLength(2); // 自环不算
    expect(t.every((x) => x.reach === "missed")).toBe(true);
  });

  it("用例声称覆盖了，就不再是缺口", () => {
    const g = computeGaps({ graph, spec, cases: [{ id: "c1", covers: ["/owners/find->/owners"] }], stories: [] });
    expect(g.filter((x) => x.kind === "transition")).toHaveLength(1);
  });

  it("自环不算「一条没验的路」——它没把人带到别处", () => {
    const g = computeGaps({ graph, spec, cases: [], stories: [] });
    expect(g.some((x) => x.detail?.includes("刷新"))).toBe(false);
  });


  it("走不通的路也算「没看到」，并带上原因", () => {
    const g = computeGaps({ graph, spec, cases: [], stories: [] });
    const b = g.find((x) => x.kind === "blocked");
    expect(b?.reach).toBe("unseen");
    expect(b?.detail).toContain("超时");
  });

  it("缺口要落到故事图同一列上，人才不用在两套坐标间换算", () => {
    const g = computeGaps({ graph, spec, cases: [], stories: [] });
    expect(g.find((x) => x.kind === "transition" && x.detail?.includes("Find Owner"))?.activity).toBe(
      "查找并管理主人",
    );
  });

  it("没有故事的流程要报出来", () => {
    const g = computeGaps({ graph, spec, cases: [], stories: [{ id: "S-1", flowId: "F-1", activity: "查找并管理主人" }] });
    const f = g.filter((x) => x.kind === "flow");
    expect(f).toHaveLength(1);
    expect(f[0]!.detail).toContain("F-2");
  });

  it("一条故事都没有的模块要单独报——空白最容易被忽略", () => {
    const g = computeGaps({ graph, spec, cases: [], stories: [{ id: "S-1", flowId: "F-1", activity: "查找并管理主人" }] });
    expect(g.filter((x) => x.kind === "module").map((x) => x.activity)).toEqual(["浏览兽医"]);
  });

  it("规格自己承认没答案的地方不属于任何模块——那正是它的性质", () => {
    const g = computeGaps({ graph, spec, cases: [], stories: [] });
    const u = g.find((x) => x.kind === "unknown");
    expect(u?.activity).toBeUndefined();
    expect(u?.reach).toBe("unseen");
  });

  it("同路由的不同状态归到同一列", () => {
    const g = computeGaps({
      graph: {
        states: [{ id: "/owners~1", route: "/owners" }],
        transitions: [{ from: "/owners~1", to: "/vets", ok: true, walked: true, action: { kind: "goto", target: "/vets" } }],
      },
      spec,
      cases: [],
      stories: [],
    });
    expect(g.find((x) => x.kind === "transition")?.activity).toBe("查找并管理主人");
  });
});

describe("去重", () => {
  it("同一条转移不会报两次——看不动的清单等于没有清单", () => {
    const t = { from: "/a", to: "/b", ok: true, walked: true, action: { kind: "click", target: "去" } };
    const g = computeGaps({
      graph: { states: [{ id: "/a", route: "/a" }, { id: "/b", route: "/b" }], transitions: [t, { ...t }] },
      spec: {},
      cases: [],
      stories: [],
    });
    expect(g.filter((x) => x.kind === "transition")).toHaveLength(1);
  });
});

describe("给人看的字里不能有内部记号", () => {
  it("状态 id 的 ~1 消歧后缀不出现在缺口文案里", () => {
    const g = computeGaps({
      graph: {
        states: [{ id: "/edit~1", route: "/edit" }, { id: "/done", route: "/done" }],
        transitions: [{ from: "/edit~1", to: "/done", ok: true, walked: true, action: { kind: "click", target: "保存" } }],
      },
      spec: {},
      cases: [],
      stories: [],
    });
    expect(g[0]!.detail).not.toContain("~");
    expect(g[0]!.detail).toContain("/edit");
  });

  it("没名字的流程摊开它的路径——只写 F-8 等于没写", () => {
    const g = computeGaps({
      graph: {},
      spec: { flows: [{ id: "F-8", name: "(未命名)", steps: ["走到 /owners", "点「编辑」"] }] },
      cases: [],
      stories: [],
    });
    expect(g.find((x) => x.kind === "flow")?.detail).toBe("走到 /owners → 点「编辑」");
  });
});

describe("活下来的变异体：第三类缺口「验不住」", () => {
  const g2 = {
    states: [
      { id: "/vets", route: "/vets", controls: ["a: Veterinarians -> /vets", "a: Home -> /"] },
      { id: "/owners", route: "/owners", controls: ["a: Find Owner -> /owners/find"] },
    ],
    transitions: [],
  };
  const spec2 = {
    modules: [
      { id: "vets", name: "浏览兽医", flowIds: [], routes: ["/vets"] },
      { id: "owners", name: "管理主人", flowIds: [], routes: ["/owners"] },
    ],
  };

  it("它的处置和另外两类都不同——不是补用例，也不是重跑探索，是改断言", () => {
    const g = computeGaps({
      graph: g2, spec: spec2, cases: [], stories: [],
      survivors: [{ what: "把「Veterinarians」改成「Veterinarian」——没有任何用例因此失败", from: "图上采到的控件文案", target: "Veterinarians" }],
    });
    const m = g.find((x) => x.kind === "mutant");
    expect(m?.reach).toBe("blind");
  });

  it("按它改的那段文字出现在哪，落到对应的那一列", () => {
    const g = computeGaps({
      graph: g2, spec: spec2, cases: [], stories: [],
      survivors: [{ what: "改了兽医导航", from: "图", target: "Veterinarians" }],
    });
    expect(g.find((x) => x.kind === "mutant")?.activity).toBe("浏览兽医");
  });

  it("落不到任何一列时不归类——宁可不归类，也不要让人去查一块没问题的功能", () => {
    const g = computeGaps({
      graph: g2, spec: spec2, cases: [], stories: [],
      survivors: [{ what: "改了某处", from: "图", target: "这段文字哪儿都没有" }],
    });
    expect(g.find((x) => x.kind === "mutant")?.activity).toBeUndefined();
  });

  it("没跑变异测试时不产生这类缺口", () => {
    expect(computeGaps({ graph: g2, spec: spec2, cases: [], stories: [] }).some((x) => x.kind === "mutant")).toBe(false);
  });
});

describe("变异缺口的身份是「哪个缺陷」，不是「哪来的」", () => {
  const two = [
    { what: "把指向「/owners/new」的链接改指到别处——没有任何用例因此失败", from: "图上走过的一条转移" },
    { what: "把指向「/owners/1」的链接改指到别处——没有任何用例因此失败", from: "图上走过的一条转移" },
  ];

  it("来源相同的两条盲区不该被合并成一条", () => {
    // 实测掉过一条：去重键用了 detail（= from），而 from 是许多变异体共有的。
    const g = computeGaps({ survivors: two }).filter((x) => x.kind === "mutant");
    expect(g).toHaveLength(2);
  });

  it("同一条盲区报两次仍然只算一条", () => {
    const g = computeGaps({ survivors: [two[0]!, { ...two[0]! }] }).filter((x) => x.kind === "mutant");
    expect(g).toHaveLength(1);
  });
});

describe("缺口要能在地图上定位", () => {
  const graph = {
    entry: "/",
    states: [
      { id: "/", controls: ["a: FIND OWNERS -> /owners/find", "a: 深处 -> /deep"] },
      { id: "/owners/find", controls: [] },
    ],
    transitions: [
      { from: "/", to: "/owners/find", walked: true, ok: true, action: { kind: "goto", target: "http://x/owners/find" } },
    ],
    unvisited: ["/deep"],
  };

  it("走过没验的转移，锚在那条边上", () => {
    const g = computeGaps({ graph }).find((x) => x.kind === "transition");
    expect(g?.anchor).toEqual({ kind: "edge", from: "/", to: "/owners/find" });
  });

  it("没进去的入口锚在**看见它的那一屏**上——它自己还不是图上的节点", () => {
    const g = computeGaps({ graph }).find((x) => x.kind === "link");
    expect(g?.anchor).toEqual({ kind: "state", id: "/" });
  });

  it("锚不到就不给锚点——宁可不可点，也不要点了跳到不相干的地方", () => {
    const g = computeGaps({ graph: { ...graph, states: [], unvisited: ["/nowhere"] } }).find(
      (x) => x.kind === "link",
    );
    expect(g?.anchor).toBeUndefined();
  });

  it("跳转目标只留路径：同一条边在图上和在清单里必须读起来一样", () => {
    const g = computeGaps({ graph }).find((x) => x.kind === "transition");
    expect(g?.detail).toContain("走到 /owners/find");
    expect(g?.detail).not.toContain("http://");
  });
});
