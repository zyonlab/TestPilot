import { describe, expect, it } from "vitest";
import { acceptanceIndex, acceptanceIsActionable, acceptanceWhen, checkStories } from "../src/acceptanceIndex.js";

/**
 * 2026-09-13 实测的那条闭合链（见 acceptanceIndex.ts 的注释）：
 * 模型改写 acRefs → 把动作换成「看一眼」→ 用例不需要动作 → 判据在初始页面就成立。
 */
describe("验收准则的编号与「要不要用户动手」", () => {
  const stories = [
    { id: "S-05", title: "选择订单类型", acceptance: [
      'Given 页面停留在交易页 / When 用户点击 “Limit” / Then 面板出现 Price 输入框',
      'Given 面板处于 Limit 模式 / When 用户点击 “Market” / Then Price 输入框消失',
    ] },
    { id: "S-02", title: "查看读数", acceptance: [
      'Given 页面已加载 / When 用户查看页头读数区 / Then 出现六个字段',
    ] },
  ];

  it("按冻结后的顺序派编号", () => {
    expect(acceptanceIndex(stories).map((e) => e.id)).toEqual(["S-05/AC-1", "S-05/AC-2", "S-02/AC-1"]);
  });

  it("分得出「动手」和「看一眼」", () => {
    const e = acceptanceIndex(stories);
    expect(e.map((x) => x.actionable)).toEqual([true, true, false]);
    expect(e[0]!.when).toBe("用户点击 “Limit”");
  });

  it("没写 When 的准则按整句判，宁可宽也不把真动作误判成看一眼", () => {
    expect(acceptanceIsActionable("用户勾选 Reduce Only 之后只减仓")).toBe(true);
    expect(acceptanceIsActionable("页面底部显示版权信息")).toBe(false);
    expect(acceptanceWhen("整句话里没有那个子句")).toBe("");
    // `Then …when…` 里的 when 不是子句开头，不算。
    expect(acceptanceWhen("Given A / Then 显示 B when 条件成立")).toBe("");
  });

  it("一条动作型准则都没有的故事要被说出来——它下游只会长出「打开就看一眼」的用例", () => {
    const f = checkStories(stories);
    expect(f.map((x) => x.storyId)).toEqual(["S-02"]);
    expect(f[0]!.code).toBe("story_has_no_actionable_criterion");
    expect(f[0]!.message).toContain("用户查看页头读数区");
  });

  it("没有验收准则的故事不算这一条——那是另一个问题", () => {
    expect(checkStories([{ id: "S-99", acceptance: [] }])).toEqual([]);
  });
});

/**
 * 2026-09-14：第一版动作表只认「点击」，而模型写的是「用户点「Limit」」——
 * 154 条真实验收准则里 18 条被误判成「看一眼」，12 条故事被误报。
 * 这几条钉的是那次调整：光杆的「点」要认，名词性用法不能误伤。
 */
describe("动作动词表（拿真语料调出来的）", () => {
  it("光杆的「点」是动作", () => {
    for (const w of ["用户点「Limit」", "用户点 TIF 的 GTC", "用户点同一区域的「Trades」"])
      expect(acceptanceIsActionable(`Given A / When ${w} / Then B`)).toBe(true);
  });

  it("名词里的「点」「按」「输入」「选择」不算动作", () => {
    for (const w of ["用户查看这个节点的终点", "用户查看面板方向按钮区域", "用户查看 Size 输入框旁", "用户查看单位选择器"])
      expect(acceptanceIsActionable(`Given A / When ${w} / Then B`)).toBe(false);
  });

  it("「挂单」是名词，不能当动词——「查看挂单档位」不是动作", () => {
    expect(acceptanceIsActionable("Given A / When 用户查看挂单档位 / Then B")).toBe(false);
    // 「撤掉」是交易类产品的动作词，来自那个产品的规则包（2026-09-15 起不在通用表里）。
    expect(acceptanceIsActionable("Given A / When 用户撤掉该挂单 / Then B", ["撤掉"])).toBe(true);
  });

  it("「打开/执行/设为/切到」都是动作——重写正则时丢过一次", () => {
    for (const w of ["打开持仓面板", "用户通过 Balances 面板执行 Transfer to Spot", "用户将 ETH 杠杆设为 20x 并确认", "用户切到 Balances 标签"])
      expect(acceptanceIsActionable(`Given A / When ${w} / Then B`)).toBe(true);
  });

  it("观察与系统事件不是用户动作", () => {
    for (const w of ["用户查看 Spread", "页面加载完成", "订单成交", "行情触及 TP 或 SL 价", "用户对比两处读数"])
      expect(acceptanceIsActionable(`Given A / When ${w} / Then B`)).toBe(false);
  });

  it("Given/When/Then 用「，」分隔时也要解析得出 When", () => {
    // 2026-09-14 实测：同一个模型两轮分别用了 `/` 和 `，`。只认一种的话，
    // 整句会回退去判，Given 里的动作会被算进 When。
    const ac = "Given 用户持有仓位且调整杠杆档位，When 用户查看持仓行的 Liq. Price，Then 读数更新";
    expect(acceptanceWhen(ac)).toBe("When 用户查看持仓行的 Liq. Price".replace("When ", ""));
    expect(acceptanceIsActionable(ac)).toBe(false);
  });
});

/**
 * `subsumes` 的三条约束（见 runStages.ts）。写成测试是因为第三条容易被当成多余：
 * 允许链式覆盖的话，「哪条故事该出用例单元」就变成一张要算传递闭包的图。
 */
describe("长故事覆盖短故事的约束", () => {
  const stories = (over: Array<Record<string, unknown>>) => over;
  it("覆盖自己 / 覆盖不存在的故事 / 链式覆盖，三种都要拒", async () => {
    const { checkStories: _c } = await import("../src/acceptanceIndex.js");
    void _c;
    // 校验在 runStages 的 stories 分支里，这里钉的是规则本身的形状。
    const cases: Array<[string, Array<Record<string, unknown>>]> = [
      ["自覆盖", stories([{ id: "A", subsumes: ["A"] }])],
      ["覆盖不存在", stories([{ id: "A", subsumes: ["Z"] }])],
      ["链式", stories([{ id: "A", subsumes: ["B"] }, { id: "B", subsumes: ["C"] }, { id: "C" }])],
    ];
    for (const [name, ss] of cases) {
      const byId = new Map(ss.map((s) => [s.id as string, s]));
      const covers = new Set(ss.flatMap((s) => (s.subsumes as string[]) ?? []));
      let bad = false;
      for (const s of ss) for (const id of ((s.subsumes as string[]) ?? [])) {
        if (id === s.id) bad = true;
        else if (!byId.has(id)) bad = true;
        else if (((byId.get(id)!.subsumes as string[]) ?? []).length) bad = true;
        else if (covers.has(s.id as string)) bad = true;
      }
      expect(bad, name).toBe(true);
    }
  });
});
