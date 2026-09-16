import { describe, expect, it } from "vitest";
import { MachineOracleSchema, aggregateJudge, evaluateOracle, judgePolicy, tierOf, describeOracle } from "../src/exec/oracle.js";
import { judgeDemand, judgeOrder, readJudgeAnswer, sampleJudge, type JudgeAgent } from "../src/exec/judge.js";
import { normalizeCase, normalizeOracle } from "../src/casegen/normalizeOracle.js";
import { runGate } from "../src/casegen/gate.js";
import type { CaseBundle, TextCase } from "../src/casegen/types.js";

/**
 * judge 判据：给生成出来的内容用的 tier 3——几句是/否条件，问几次，按统计口径出判决。
 */
const criteria = ["图里只有一个红色的圆", "图的下方有一句配文", "配文提到了红色"];
const judge = (over: Record<string, unknown> = {}) => MachineOracleSchema.parse({ kind: "judge", criteria, ...over }) as Extract<ReturnType<typeof MachineOracleSchema.parse>, { kind: "judge" }>;

describe("judge 的形状与档位", () => {
  it("samples 缺省为 3，minPass 缺省为过半；判据永远是 tier 3", () => {
    const o = judge();
    expect(o.samples).toBe(3);
    expect(judgePolicy(o)).toEqual({ samples: 3, minPass: 2 });
    expect(judgePolicy({ samples: 4 })).toEqual({ samples: 4, minPass: 3 });
    expect(judgePolicy({ samples: 3, minPass: 7 })).toEqual({ samples: 3, minPass: 3 });
    expect(tierOf(o)).toBe(3);
    expect(describeOracle(o)).toContain("判 3 次，至少 2 次全部成立");
  });

  it("空条件、超过 8 条、采样超过 9 次都被拒", () => {
    expect(() => judge({ criteria: [] })).toThrow();
    expect(() => judge({ criteria: Array.from({ length: 9 }, (_, i) => `c${i}`) })).toThrow();
    expect(() => judge({ samples: 10 })).toThrow();
  });
});

describe("aggregateJudge", () => {
  const T = [true, true, true], F = [true, false, true];
  it("够数算过，并逐条给出成立次数", () => {
    const v = aggregateJudge(judge(), { verdicts: [T, T, F] });
    expect(v.status).toBe("pass");
    expect(v.judge).toEqual({ samples: 3, valid: 3, passed: 2, minPass: 2, perCriterion: [3, 2, 3], split: true });
    expect(v.detail).toContain("2/3 次采样全部条件成立");
    expect(v.detail).toContain("「图的下方有一句配文」2/3");
    expect(v.detail).toContain("意见不一");
  });

  it("失败的采样都算成立也不够数，才算挂", () => {
    expect(aggregateJudge(judge(), { verdicts: [F, F, T] }).status).toBe("fail");
    expect(aggregateJudge(judge(), { verdicts: [F, F, F] }).judge.split).toBe(false);
  });

  it("没拿到答案的采样足以翻盘时不下判决", () => {
    const v = aggregateJudge(judge(), { verdicts: [T, null, null] });
    expect(v.status).toBe("unobservable");
    expect(v.detail).toContain("2 次采样没拿到答案");
    // 条数对不上的回答也算无效。
    expect(aggregateJudge(judge(), { verdicts: [T, [true], F] }).status).toBe("unobservable");
  });

  it("evaluateOracle 没有采样结果时不假装判过", () => {
    expect(evaluateOracle(judge(), { text: "", url: "" }).status).toBe("unobservable");
    expect(evaluateOracle(judge(), { text: "", url: "", judge: { verdicts: [T, T, T] } }).status).toBe("pass");
  });
});

describe("采样", () => {
  it("每次轮换提问顺序，回答按原顺序对回", () => {
    expect(judgeOrder(3, 0)).toEqual([0, 1, 2]);
    expect(judgeOrder(3, 1)).toEqual([1, 2, 0]);
    const demand = judgeDemand(criteria, judgeOrder(3, 1));
    expect(demand.c1).toContain(criteria[1]);
    expect(demand.c3).toContain(criteria[0]);
    // 第二次采样：c1 问的是第 2 条、c3 问的是第 1 条。
    expect(readJudgeAnswer({ c1: false, c2: true, c3: "是" }, judgeOrder(3, 1))).toEqual([true, false, true]);
    expect(readJudgeAnswer({ c1: true, c2: "maybe", c3: true }, judgeOrder(3, 0))).toBeNull();
    expect(readJudgeAnswer("yes", judgeOrder(3, 0))).toBeNull();
  });

  it("假的判官：第一条条件在所有顺序下都不成立，就一次都不过", async () => {
    const asked: string[][] = [];
    const agent: JudgeAgent = {
      async aiQuery(demand) {
        const keys = Object.keys(demand);
        asked.push(keys.map((k) => demand[k]!));
        return Object.fromEntries(keys.map((k) => [k, !demand[k]!.includes(criteria[0]!)]));
      },
    };
    const out = await sampleJudge(agent, judge());
    expect(asked).toHaveLength(3);
    expect(out.infra).toBe(false);
    expect(out.sampling.verdicts).toEqual([[false, true, true], [false, true, true], [false, true, true]]);
    const v = aggregateJudge(judge(), out.sampling);
    expect(v.status).toBe("fail");
    expect(v.judge.perCriterion).toEqual([0, 3, 3]);
  });

  it("全部采样都栽在环境上：记 infra，不当成判决", async () => {
    const agent: JudgeAgent = { async aiQuery() { throw new Error("ECONNREFUSED 127.0.0.1"); } };
    const out = await sampleJudge(agent, judge(), { isInfra: (m) => /ECONNREFUSED/.test(m), resolve: (t) => t });
    expect(out.infra).toBe(true);
    expect(out.sampling.verdicts).toEqual([null, null, null]);
    // 只有一部分栽在环境上：不是 infra，照常聚合。
    let n = 0;
    const flaky: JudgeAgent = { async aiQuery(d) { if (n++ === 0) throw new Error("ECONNREFUSED"); return Object.fromEntries(Object.keys(d).map((k) => [k, true])); } };
    const partial = await sampleJudge(flaky, judge(), { isInfra: (m) => /ECONNREFUSED/.test(m) });
    expect(partial.infra).toBe(false);
    expect(aggregateJudge(judge(), partial.sampling).status).toBe("pass");
  });
});

describe("约束解码的占位剥离", () => {
  it("judge 留下条件与采样参数，占位的 value 与 0 去掉", () => {
    const flat = { kind: "judge", value: "-", url: "-", method: "GET", path: "-", op: "eq", settleMs: 0, criteria, samples: 0, minPass: 0 };
    expect(normalizeOracle(flat)).toEqual({ kind: "judge", criteria });
    expect(MachineOracleSchema.parse(normalizeOracle(flat))).toMatchObject({ kind: "judge", samples: 3 });
    expect(normalizeOracle({ ...flat, samples: 5, minPass: 4 })).toEqual({ kind: "judge", criteria, samples: 5, minPass: 4 });
  });

  it("别的 kind 不带走 criteria", () => {
    expect(normalizeOracle({ kind: "text", value: "Saved", url: "-", method: "GET", path: "-", op: "eq", settleMs: 0, criteria: [], samples: 0, minPass: 0 }))
      .toEqual({ kind: "text", value: "Saved" });
    expect((normalizeCase({ id: "x", oracle: { kind: "none", criteria: [] } }) as Record<string, unknown>).oracle).toBeUndefined();
  });
});

describe("门禁", () => {
  const base = (over: Partial<TextCase>): TextCase => ({
    id: "TC-1", storyId: "US-1", title: "t", designMethod: "equivalence",
    precondition: [], steps: ["点击生成按钮"], postSteps: [], expected: "生成一张只有红色圆的图",
    tier: 3, key: "k", covers: [], sourceRefs: [], ...over,
  } as TextCase);
  const bundle = (cases: TextCase[]): CaseBundle => ({
    stories: [{ id: "US-1", title: "s", acceptance: ["前置 / 触发 / 结果"], role: "r", benefit: "b" }], cases, flows: [],
  } as unknown as CaseBundle);
  const rules = (c: TextCase) => runGate(bundle([c])).findings.filter((f) => f.caseId === c.id);

  it("含糊的条件、及格线超过采样数记警告；采样太少记提示", () => {
    const vague = rules(base({ oracle: judge({ criteria: ["图片看起来正常"] }) }));
    expect(vague.find((f) => f.rule === "judge-spec")).toMatchObject({ severity: "warn" });
    const over = rules(base({ oracle: judge({ samples: 3, minPass: 5 }) }));
    expect(over.find((f) => f.rule === "judge-spec")).toMatchObject({ severity: "warn", message: expect.stringContaining("needs 5") });
    const few = rules(base({ oracle: judge({ samples: 1 }) }));
    expect(few.find((f) => f.rule === "judge-spec")).toMatchObject({ severity: "info" });
    expect(rules(base({ oracle: judge() })).some((f) => f.rule === "judge-spec")).toBe(false);
  });

  it("judge 不能给 tier 1 撑腰：只带 judge 的 tier 1 用例照样被点名", () => {
    const found = rules(base({ tier: 1, oracle: judge() }));
    expect(found.find((f) => f.rule === "tier-unbacked" && f.severity === "warn")).toBeTruthy();
    expect(found.find((f) => f.rule === "tier-unbacked" && f.severity === "info")?.message).toContain("judged by a model (tier 3)");
    // 同时带着程序判据的断言：有撑腰，不点名。
    const backed = rules(base({ tier: 1, oracle: judge(), assertions: [{ id: "A-1", statement: "显示生成完成", ruleRefs: [], oracle: { kind: "text", value: "生成完成" } }] } as Partial<TextCase>));
    expect(backed.some((f) => f.rule === "tier-unbacked" && f.severity === "warn")).toBe(false);
  });
});
