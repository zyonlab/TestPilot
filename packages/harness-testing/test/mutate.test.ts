import { describe, expect, it } from "vitest";
import { generateMutants, labelOf, nearMiss } from "../src/mutate/operators.js";
import { buildMutationScript } from "../src/mutate/inject.js";
import { judgeMutant, scoreMutants, survivorsAsGaps } from "../src/mutate/score.js";
import { detectionCases, fromCleanRun, fromMutantRun } from "../src/mutate/detection.js";
import { scoreDetection } from "@testpilot/harness-core";

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

describe("注入脚本本身要能被打包器解析", () => {
  it("模板体里不能出现反引号——注释里写一个都会把模板提前闭合", () => {
    const s = buildMutationScript({ id: "M", operator: "text", what: "", from: "", target: "a", replacement: "b" });
    expect(s.includes("`")).toBe(false);
  });
});

describe("检测评估：干净跑量虚报，变异跑量召回", () => {
  const M = { id: "M-1", operator: "text" as const, what: "", from: "", target: "FIND OWNERS", replacement: "FIND OWNER" };
  const oracles = [
    { caseId: "c1", literal: "FIND OWNERS" },   // 判据正是被改坏的那句
    { caseId: "c2", literal: "Veterinarians" }, // 判据是别的
    { caseId: "c3" },                            // 没有文字判据
  ];

  it("干净跑：产品是对的，所以实际情况全是「应该通过」", () => {
    const d = fromCleanRun([
      { caseId: "c1", status: "passed" },
      { caseId: "c2", status: "failed", failKind: "assert" },
    ]);
    expect(d.every((x) => x.actual === "passed")).toBe(true);
    // 判失败的那条就是虚报
    expect(d.find((x) => x.caseId === "c2")?.predicted).toBe("failed");
  });

  it("基础设施故障被排除——那是「没有判决」，不是「判错」", () => {
    const d = fromCleanRun([{ caseId: "c1", status: "failed", failKind: "infra" }]);
    expect(d[0]!.excluded).toBe(true);
  });

  it("变异跑：判据正是被改坏那句话的用例，实际情况是「应该失败」", () => {
    const d = fromMutantRun(M, oracles, [
      { caseId: "c1", status: "failed", failKind: "assert" },
      { caseId: "c2", status: "passed" },
      { caseId: "c3", status: "passed" },
    ]);
    expect(d.find((x) => x.caseId.endsWith("c1"))?.actual).toBe("failed");
    expect(d.find((x) => x.caseId.endsWith("c2"))?.actual).toBe("passed");
    expect(d.find((x) => x.caseId.endsWith("c3"))?.actual).toBe("passed");
  });

  it("大小写不敏感——判据来自规格，变异目标来自 innerText，可能只差大小写", () => {
    const d = fromMutantRun(
      { ...M, target: "find owners" },
      [{ caseId: "c1", literal: "FIND OWNERS" }],
      [{ caseId: "c1", status: "failed", failKind: "assert" }],
    );
    expect(d[0]!.actual).toBe("failed");
  });

  it("没生效的变异体不进检测——产品其实没被改坏，罚用例集是错的", () => {
    const d = detectionCases({
      clean: [{ caseId: "c1", status: "passed" }],
      oracles,
      mutantRuns: [{ mutant: M, outcomes: [{ caseId: "c1", status: "passed" }], applied: 0 }],
    });
    expect(d).toHaveLength(1); // 只有干净跑那一条
  });

  it("两者合起来才凑得齐混淆矩阵——只有干净跑量不出召回", () => {
    const d = detectionCases({
      clean: [
        { caseId: "c1", status: "passed" },
        { caseId: "c2", status: "passed" },
      ],
      oracles,
      mutantRuns: [
        { mutant: M, applied: 3, outcomes: [
          { caseId: "c1", status: "failed", failKind: "assert" }, // 该抓到，抓到了 → TP
          { caseId: "c2", status: "passed" },                      // 不该动，没动 → TN
        ] },
      ],
    });
    const r = scoreDetection(d as never);
    expect(r.truePositives).toBe(1);
    expect(r.falsePositives).toBe(0);
    expect(r.recall).toBe(1);
  });

  it("该抓没抓到就是漏报", () => {
    const d = detectionCases({
      clean: [{ caseId: "c1", status: "passed" }],
      oracles,
      mutantRuns: [{ mutant: M, applied: 3, outcomes: [{ caseId: "c1", status: "passed" }] }],
    });
    const r = scoreDetection(d as never);
    expect(r.falseNegatives).toBe(1);
    expect(r.recall).toBe(0);
  });
});

describe("判错 vs 没走到——xUnit 里的 failure 与 error", () => {
  it("停在声称要走到的终点上，失败就是真的判错", () => {
    const d = fromCleanRun([
      { caseId: "c1", status: "failed", failKind: "assert",
        endedAt: "http://localhost:8080/owners", covers: ["/owners/find->/owners"] },
    ]);
    expect(d[0]!.excluded).toBeUndefined();
  });

  it("没停在终点上就是没走到——那是 error，不算用例虚报", () => {
    // 实测：S-02-5 判据「页面显示 Pets」，PetClinic 的主人列表确实有这一列，
    // 但点 FIND OWNERS 只到搜索表单，执行停在 /owners/find。用例对、产品对、执行没走到。
    const d = fromCleanRun([
      { caseId: "c1", status: "failed", failKind: "assert",
        endedAt: "http://localhost:8080/owners/find", covers: ["/owners/find->/owners"] },
    ]);
    expect(d[0]!.excluded).toBe(true);
    expect(d[0]!.excludeReason).toContain("没走到");
  });

  it("通过的用例不受这条影响——只有失败才需要分辨是哪一种", () => {
    const d = fromCleanRun([
      { caseId: "c1", status: "passed", endedAt: "http://localhost:8080/x", covers: ["/a->/b"] },
    ]);
    expect(d[0]!.excluded).toBeUndefined();
  });

  it("说不出自己要走到哪的用例，无法判断，照旧算判错", () => {
    const d = fromCleanRun([
      { caseId: "c1", status: "failed", failKind: "assert", endedAt: "http://localhost:8080/x", covers: [] },
    ]);
    expect(d[0]!.excluded).toBeUndefined();
  });

  it("同路由消歧后缀不影响比对", () => {
    const d = fromCleanRun([
      { caseId: "c1", status: "failed", failKind: "assert",
        endedAt: "http://localhost:8080/owners/1/edit", covers: ["/owners/1->/owners/1/edit~1"] },
    ]);
    expect(d[0]!.excluded).toBeUndefined();
  });
});
