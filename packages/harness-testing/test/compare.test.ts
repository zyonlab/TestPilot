import { it, expect } from "vitest";
import { compareExecutions, describeComparison, type ExecutionSnapshot } from "../src/exec/compare.js";

const snap = (executionId: string, results: Array<[string, "passed" | "failed" | "not_run"]>, codeRevision = "rev-1"): ExecutionSnapshot =>
  ({ executionId, codeRevision, results: results.map(([caseId, status]) => ({ caseId, status })) });

it("修好、回归、仍绿、仍红各归各位", () => {
  const a = snap("e1", [["c1", "failed"], ["c2", "passed"], ["c3", "passed"], ["c4", "failed"]]);
  const b = snap("e2", [["c1", "passed"], ["c2", "failed"], ["c3", "passed"], ["c4", "failed"]]);
  const { summary, cases } = compareExecutions(a, b);
  expect(summary).toMatchObject({ fixed: 1, regressed: 1, stillPassing: 1, stillFailing: 1, flaky: 0 });
  expect(cases.find((c) => c.caseId === "c1")!.change).toBe("fixed");
  expect(cases.find((c) => c.caseId === "c2")!.change).toBe("regressed");
});

it("中间几次红过就叫抖——哪怕基线和当前都是绿的", () => {
  const a = snap("e1", [["c1", "passed"]]);
  const mid = snap("e2", [["c1", "failed"]]);
  const b = snap("e3", [["c1", "passed"]]);
  const { summary, cases } = compareExecutions(a, b, [mid]);
  expect(summary).toMatchObject({ flaky: 1, stillPassing: 0, fixed: 0, regressed: 0 });
  expect(cases[0]!.history).toEqual(["passed", "failed", "passed"]);
  expect(cases[0]!.flips).toBe(2);
});

it("变一次就稳住的不是抖：红→绿→绿是真的修好了", () => {
  const a = snap("e1", [["c1", "failed"]]);
  const mid = snap("e2", [["c1", "passed"]]);
  const b = snap("e3", [["c1", "passed"]]);
  expect(compareExecutions(a, b, [mid]).summary).toMatchObject({ flaky: 0, fixed: 1 });
});

it("绿→红→红→红是回归，不是抖——它坏了之后就没好过", () => {
  const a = snap("e1", [["c1", "passed"]]);
  const m1 = snap("e2", [["c1", "failed"]]), m2 = snap("e3", [["c1", "failed"]]);
  const b = snap("e4", [["c1", "failed"]]);
  const { summary, cases } = compareExecutions(a, b, [m1, m2]);
  expect(summary).toMatchObject({ regressed: 1, flaky: 0 });
  expect(cases[0]!.flips).toBe(1);
});

it("未执行不算红：它没被跑过，不该被读成失败", () => {
  const a = snap("e1", [["c1", "passed"]]);
  const b = snap("e2", [["c1", "not_run"]]);
  const { cases } = compareExecutions(a, b);
  expect(cases[0]!.change).toBe("regressed");
  expect(cases[0]!.current).toBe("not_run");
});

it("只在一边出现的用例单独记，不混进回归", () => {
  const a = snap("e1", [["c1", "passed"]]);
  const b = snap("e2", [["c1", "passed"], ["c2", "failed"]]);
  expect(compareExecutions(a, b).summary).toMatchObject({ appeared: 1, regressed: 0 });
  expect(compareExecutions(b, a).summary).toMatchObject({ disappeared: 1 });
});

it("编译版本不同要说出来——差异可能来自用例而不是产品", () => {
  const a = snap("e1", [["c1", "passed"]], "rev-1");
  const b = snap("e2", [["c1", "failed"]], "rev-2");
  const { summary } = compareExecutions(a, b);
  expect(summary.sameCodeRevision).toBe(false);
  expect(describeComparison(summary)).toContain("编译版本不同");
});
