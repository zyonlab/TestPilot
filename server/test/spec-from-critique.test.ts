import { describe, it, expect, afterAll } from "vitest";
import { rmSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { specFromSuggestion } from "../src/evalspecs.js";

const EVALS = resolve(process.cwd(), "..", "evals");
const written: string[] = [];
afterAll(() => {
  for (const f of written) rmSync(f, { force: true });
});

const base = {
  title: "门禁的负例比例门槛偏低",
  change: "把 gate.minNegativeRatio 从 0.3 提到 0.45",
  evidence: "最近 3 次运行里负例占比 0.31/0.29/0.33，恰好卡在门槛上",
  expectedEffect: "负例会变多，门禁分会掉",
};

describe("U-62 · critic 的建议要能变成一份能跑的评测", () => {
  it("消融类的建议造出两条只差一处的臂", () => {
    const spec = specFromSuggestion({
      suggestion: { ...base, test: { kind: "ablation", handle: "repair" } },
      graphId: "g1-text-cases",
    });
    written.push(resolve(EVALS, `${spec.id}.json`));
    expect(spec.a.ablate).toEqual([]);
    expect(spec.b.ablate).toEqual(["repair"]);
    expect(existsSync(resolve(EVALS, `${spec.id}.json`))).toBe(true);
  });

  it("参数类的建议把 node.param=value 拆成一处覆盖", () => {
    const spec = specFromSuggestion({
      suggestion: { ...base, test: { kind: "param", handle: "gate.minNegativeRatio=0.45" } },
      graphId: "g1-text-cases",
    });
    written.push(resolve(EVALS, `${spec.id}.json`));
    expect(spec.b.params).toEqual({ gate: { minNegativeRatio: 0.45 } });
  });

  it("说不出怎么证伪的建议造不出评测——硬造出来的两条臂量的是别的东西", () => {
    expect(() =>
      specFromSuggestion({ suggestion: { ...base, test: { kind: "manual" } }, graphId: "g1-text-cases" }),
    ).toThrow(/证伪/);
  });

  it("被判为不可采纳的建议不该被造成评测", () => {
    expect(() =>
      specFromSuggestion({
        suggestion: { ...base, test: { kind: "ablation", handle: "repair" }, inadmissible: "它把清单抄进了提示词" },
        graphId: "g1-text-cases",
      }),
    ).toThrow(/不可采纳/);
  });

  it("不给预判就记成 unknown——那是诚实的答案，而且 expect 不是断言", () => {
    const spec = specFromSuggestion({
      suggestion: { ...base, test: { kind: "ablation", handle: "dedupe" } },
      graphId: "g1-text-cases",
    });
    written.push(resolve(EVALS, `${spec.id}.json`));
    expect(spec.expect?.direction).toBe("unknown");
    expect(spec.expect?.note).toContain("负例");
  });

  it("why 带着证据，不是复述标题", () => {
    const spec = specFromSuggestion({
      suggestion: { ...base, test: { kind: "ablation", handle: "fragments" } },
      graphId: "g1-text-cases",
    });
    written.push(resolve(EVALS, `${spec.id}.json`));
    expect(spec.why).toContain("0.31/0.29/0.33");
    expect(spec.why).not.toBe(spec.title);
  });

  it("未知的消融开关当场被拒——和手写的定义受同一套检查", () => {
    expect(() =>
      specFromSuggestion({
        suggestion: { ...base, test: { kind: "ablation", handle: "not-a-real-switch" } },
        graphId: "g1-text-cases",
      }),
    ).toThrow(/未知的消融开关/);
  });
});
