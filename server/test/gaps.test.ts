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

  it("看见没走的入口算「没看到」——它要的是重跑探索，不是补用例", () => {
    const g = computeGaps({ graph, spec, cases: [], stories: [] });
    const link = g.find((x) => x.kind === "link");
    expect(link?.reach).toBe("unseen");
    expect(link?.activity).toBe("浏览兽医");
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
  it("同一个入口在五屏上看见，是一个缺口不是五个——看不动的清单等于没有清单", () => {
    const g = computeGaps({
      graph: {
        states: [{ id: "/a", route: "/a" }, { id: "/b", route: "/b" }, { id: "/c", route: "/c" }],
        transitions: [
          { from: "/a", to: "/x", walked: false, action: { kind: "goto", target: "/x" } },
          { from: "/b", to: "/x", walked: false, action: { kind: "goto", target: "/x" } },
          { from: "/c", to: "/x", walked: false, action: { kind: "goto", target: "/x" } },
        ],
      },
      spec: {},
      cases: [],
      stories: [],
    });
    expect(g.filter((x) => x.kind === "link")).toHaveLength(1);
  });
  it("不同入口仍然各算一条", () => {
    const g = computeGaps({
      graph: {
        states: [{ id: "/a", route: "/a" }],
        transitions: [
          { from: "/a", to: "/x", walked: false, action: { kind: "goto", target: "/x" } },
          { from: "/a", to: "/y", walked: false, action: { kind: "goto", target: "/y" } },
        ],
      },
      spec: {},
      cases: [],
      stories: [],
    });
    expect(g.filter((x) => x.kind === "link")).toHaveLength(2);
  });
});
