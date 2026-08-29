import { describe, expect, it } from "vitest";
import { generateMutants, labelOf, nearMiss } from "../src/mutate/operators.js";
import { buildMutationScript } from "../src/mutate/inject.js";

const graph = {
  states: [
    { id: "/owners/find", route: "/owners/find", title: "Find Owners",
      controls: ['input[text]: Last name', 'button[submit]: Find Owner', 'a: Add Owner -> /owners/new', '（无可见文案·x）'] },
    { id: "/owners", route: "/owners", title: "Owners", controls: ['a: Home -> /'] },
  ],
  transitions: [
    { from: "/", to: "/owners/find", action: { kind: "goto", target: "/owners/find" } },
    { from: "/owners/find", to: "/owners", action: { kind: "click", target: "Find Owner" } },
    { from: "/owners", to: "/vets", action: { kind: "goto", target: "/vets" } },
  ],
};
const spec = {
  rules: [
    { id: "R-1", text: "空提交时逐项提示", evidence: "must not be empty" },
    { id: "R-2", text: "搜不到时提示", evidence: "has not been found" },
  ],
};

describe("变异算子", () => {
  it("近似而不是面目全非——只动一个词，考的才是断言的精度", () => {
    // 替换表按顺序试：`empty` 排在 `not` 前面，所以改的是名词而不是否定词。
    // 改名词更接近真实的产品变更（一次文案调整），也更考验断言的逐字精度。
    expect(nearMiss("must not be empty")).toBe("must not be blank");
    expect(nearMiss("has not been found")).toBe("has never been found");
    expect(nearMiss("不能为空")).toBe("不可为空");
  });

  it("没有可换的词时仍然只改一个字符", () => {
    const s = "Welcome";
    const m = nearMiss(s);
    expect(m).not.toBe(s);
    expect(m.length - s.length).toBeLessThanOrEqual(1);
  });

  it("控件文案从采集串里取出来", () => {
    expect(labelOf("button[submit]: Find Owner")).toBe("Find Owner");
    expect(labelOf("a: Add Owner -> /owners/new")).toBe("Add Owner");
  });
});

describe("生成变异体：只看产品，不看用例", () => {
  it("改文案取自规格规则引用的产品原话", () => {
    const ms = generateMutants({ graph, spec });
    const t = ms.filter((m) => m.operator === "text");
    expect(t.map((m) => m.target)).toEqual(["must not be empty", "has not been found"]);
    expect(t[0]!.from).toContain("R-1");
  });

  it("藏控件取自图上真实采到的控件，跳过没有文案的", () => {
    const ms = generateMutants({ graph, spec });
    const h = ms.filter((m) => m.operator === "hide").map((m) => m.target);
    expect(h).toContain("Find Owner");
    expect(h.some((x) => x.startsWith("（无可见文案"))).toBe(false);
  });

  it("断链接只取真正走过的 goto 转移——点击的落点事先不知道", () => {
    const ms = generateMutants({ graph, spec });
    const r = ms.filter((m) => m.operator === "relink").map((m) => m.target);
    expect(r).toEqual(["/owners/find", "/vets"]);
    expect(r).not.toContain("Find Owner");
  });

  it("每个变异体都说得出自己从产品的哪条事实来——判断等价变异体要靠它", () => {
    for (const m of generateMutants({ graph, spec })) {
      expect(m.from).toBeTruthy();
      expect(m.what).toBeTruthy();
    }
  });

  it("同一个目标不生成两个变异体", () => {
    const ms = generateMutants({ graph: { ...graph, states: [...graph.states, ...graph.states] }, spec });
    const keys = ms.map((m) => `${m.operator}::${m.target}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("limit 限的是每一类算子——成本是变异体数 × 跑一遍用例集", () => {
    const ms = generateMutants({ graph, spec }, 1);
    for (const op of ["text", "hide", "relink"])
      expect(ms.filter((m) => m.operator === op).length).toBeLessThanOrEqual(1);
  });

  it("空输入不产生变异体，而不是编几个出来", () => {
    expect(generateMutants({})).toEqual([]);
  });
});

describe("注入脚本", () => {
  const m = (o: Record<string, unknown>) =>
    buildMutationScript({ id: "M-1", operator: "text", what: "w", from: "f", target: "x", ...o } as never);

  it("参数被序列化进去，而不是拼字符串——拼接会被引号打断", () => {
    const s = m({ target: 'He said "hi"', replacement: "bye" });
    expect(s).toContain(JSON.stringify('He said "hi"'));
  });

  it("自己记账改了几处——0 处是「没生效」，不是「活下来」", () => {
    expect(m({})).toContain("state.applied");
    expect(m({})).toContain("window.__tpMutation");
  });

  it("用 MutationObserver 持续应用——单页应用会把一次性的改动重绘掉", () => {
    expect(m({})).toContain("MutationObserver");
  });

  it("浏览器里跑的代码不能有具名内部函数（打包器的 keepNames 会注入 __name）", () => {
    expect(m({})).not.toMatch(/function\s+\w+\s*\(/);
  });

  it("四种算子都在脚本里有分支", () => {
    const s = m({});
    for (const op of ["text", "hide", "relink", "dropOne"]) expect(s).toContain(`"${op}"`);
  });
});
