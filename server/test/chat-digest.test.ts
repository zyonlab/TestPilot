import { describe, it, expect } from "vitest";
import { digest } from "../src/chat.js";

/**
 * 诊断此前读的是 `brief(output, 900)`——40 条用例的产物砍到 900 字符，
 * 剩下的是前两条的 JSON 开头。于是问「62% 差在哪、这 11 条先改哪三条」
 * 得到的必然是语气正确的空话：模型手里根本没有那 11 条。
 */
const CASES = Array.from({ length: 40 }, (_, i) => ({
  id: `tc-${i + 1}`,
  title: `第 ${i + 1} 条用例`,
  method: "equivalence",
}));
const FINDINGS = Array.from({ length: 11 }, (_, i) => ({
  rule: "oracle-vague",
  severity: "warn",
  caseId: `tc-${i + 1}`,
  message: `第 ${i + 1} 条的判据说不清`,
}));

describe("U-58 · explain 读整批", () => {
  const text = digest({
    cases: CASES,
    gate: {
      score: 0.627,
      scoreBasis: { cases: 40, flagged: FINDINGS.map((f) => f.caseId), formula: "1 − 11/40" },
      findings: FINDINGS,
    },
  });

  it("40 条用例一条不少，首尾都在", () => {
    expect(text).toContain("[C1] tc-1");
    expect(text).toContain("[C40] tc-40");
  });

  it("11 条 finding 一条不少，各有可引用的编号", () => {
    expect(text).toContain("[F1] warn oracle-vague · tc-1");
    expect(text).toContain("[F11] warn oracle-vague · tc-11");
  });

  it("分数怎么算的也在——「62% 差在哪」问的就是这一句", () => {
    expect(text).toContain("1 − 11/40");
    expect(text).toContain("0.627");
  });

  it("认不出形状的产物给得比原来的 900 宽，但仍然有上限", () => {
    const big = digest({ whatever: "x".repeat(9000) });
    expect(big.length).toBeGreaterThan(900);
    expect(big).toContain("truncated");
  });
});
