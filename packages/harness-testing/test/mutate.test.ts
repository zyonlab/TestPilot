import { describe, expect, it } from "vitest";
import { generateMutants, labelOf, nearMiss } from "../src/mutate/operators.js";
import { buildMutationScript } from "../src/mutate/inject.js";
import { judgeMutant, scoreMutants, survivorsAsGaps } from "../src/mutate/score.js";

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

describe("变异得分", () => {
  const M = { id: "M-1", operator: "text" as const, what: "把 A 改成 B", from: "规则 R-1", target: "A", replacement: "B" };
  const clean = [
    { caseId: "c1", status: "passed" as const },
    { caseId: "c2", status: "passed" as const },
    { caseId: "c3", status: "failed" as const, failKind: "assert" },
  ];

  it("「杀掉」是造成了新的失败，不是「有失败」——干净跑本来就有 3 条失败", () => {
    const same = [...clean];
    expect(judgeMutant(M, 4, clean, same).verdict).toBe("survived");
  });

  it("新失败才算杀掉，并记下是谁抓到的", () => {
    const worse = [{ caseId: "c1", status: "failed" as const, failKind: "assert" }, clean[1]!, clean[2]!];
    const r = judgeMutant(M, 4, clean, worse);
    expect(r.verdict).toBe("killed");
    expect(r.killedBy).toEqual(["c1"]);
  });

  it("基础设施故障不算抓住缺陷——否则模型越不稳，得分越高", () => {
    const flaky = [{ caseId: "c1", status: "failed" as const, failKind: "infra" }, clean[1]!, clean[2]!];
    const r = judgeMutant(M, 4, clean, flaky);
    expect(r.verdict).toBe("survived");
    expect(r.ignoredInfra).toEqual(["c1"]);
  });

  it("没生效是第三类，不是「活下来」——那是工具的问题，不是用例集的", () => {
    const r = judgeMutant(M, 0, clean, clean);
    expect(r.verdict).toBe("notApplied");
    expect(r.killedBy).toEqual([]);
  });

  it("杀掉率的分母只算生效了的——没生效的既不算杀掉也不算活下来", () => {
    const rs = [
      judgeMutant(M, 1, clean, [{ caseId: "c1", status: "failed", failKind: "assert" }, clean[1]!, clean[2]!]),
      judgeMutant({ ...M, id: "M-2" }, 1, clean, clean),
      judgeMutant({ ...M, id: "M-3" }, 0, clean, clean),
    ];
    const s = scoreMutants(rs);
    expect(s).toMatchObject({ killed: 1, survived: 1, notApplied: 1 });
    expect(s.score).toBe(0.5);
  });

  it("活下来的能直接说成缺口——报杀掉率必须同时报它们", () => {
    const rs = [judgeMutant(M, 3, clean, clean)];
    const g = survivorsAsGaps(scoreMutants(rs));
    expect(g).toHaveLength(1);
    expect(g[0]!.what).toContain("没有任何用例因此失败");
    expect(g[0]!.from).toBe("规则 R-1");
  });

  it("一个变异体都没生效时，得分是 0 而不是崩掉", () => {
    expect(scoreMutants([judgeMutant(M, 0, clean, clean)]).score).toBe(0);
  });
});

describe("大小写：采集用 innerText（会套 CSS 大小写变换），注入读文本节点（不会）", () => {
  it("改文案的匹配是大小写不敏感的", () => {
    const s = buildMutationScript({ id: "M", operator: "text", what: "", from: "", target: "FIND OWNERS", replacement: "FIND OWNER" });
    expect(s).toContain("toLowerCase");
  });
  it("藏控件的匹配也是", () => {
    const s = buildMutationScript({ id: "M", operator: "hide", what: "", from: "", target: "Find Owner" });
    expect(s).toContain("label.toLowerCase() === cfg.target.toLowerCase()");
  });
});
