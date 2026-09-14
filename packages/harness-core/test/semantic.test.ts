import { describe, expect, it } from "vitest";
import { FakeModel } from "../src/model/client.js";
import { scoreCoverage, type CandidateCase, type GoldChecklist } from "../src/eval/coverage.js";
import { adjudicateMisses } from "../src/eval/semantic.js";

const gold: GoldChecklist = {
  id: "t",
  items: [
    { id: "G-09", title: "首次进入页面不显示错误提示", match: { assertAnyOf: ["不显示错误"] } },
    { id: "G-12", title: "超长输入不导致页面异常", match: { anyOf: ["超长"] } },
  ],
};

// The real under-read this exists for: the case says "不显示文案 …", the checklist says
// "不显示错误". Same behaviour, different words, and keywords cannot tell.
const cases: CandidateCase[] = [
  { id: "c1", title: "首次进入页面无错误提示", steps: ["打开登录页"], expected: "页面不显示文案 'Invalid username or password'" },
];

describe("adjudicateMisses", () => {
  it("recovers a miss that was only a wording difference", async () => {
    const model = new FakeModel((req) =>
      req.label === "coverage-adjudicate:G-09"
        ? '{"covered": true, "caseIndex": 0, "reason": "同一现象，措辞不同"}'
        : '{"covered": false, "caseIndex": -1, "reason": "nobody wrote it"}',
    );
    const deterministic = scoreCoverage(gold, cases);
    expect(deterministic.coverage).toBe(0); // both items missed by keywords

    const semantic = await adjudicateMisses(gold, cases, deterministic, model);
    expect(semantic.matched.map((m) => m.goldId)).toEqual(["G-09"]);
    expect(semantic.coverage).toBe(0.5);
    expect(semantic.stillMissing).toEqual(["G-12"]); // a real gap stays a gap
    expect(semantic.calls).toBe(2);
  });

  it("never touches items the deterministic pass already matched", async () => {
    const model = new FakeModel('{"covered": false, "caseIndex": -1, "reason": "no"}');
    const strong: CandidateCase[] = [{ id: "c1", title: "超长用户名", steps: [], expected: "不崩溃" }];
    const deterministic = scoreCoverage(gold, strong);
    const semantic = await adjudicateMisses(gold, strong, deterministic, model);
    // G-12 was a keyword hit; adjudication cannot take it away.
    expect(semantic.coverage).toBeGreaterThanOrEqual(deterministic.coverage);
    expect(model.calls.every((c) => !c.label?.includes("G-12"))).toBe(true);
  });

  it("keeps reporting a gap when the model's answer cannot be read", async () => {
    const model = new FakeModel("I think maybe yes?");
    const deterministic = scoreCoverage(gold, cases);
    const semantic = await adjudicateMisses(gold, cases, deterministic, model);
    expect(semantic.matched).toEqual([]);
    expect(semantic.stillMissing.sort()).toEqual(["G-09", "G-12"]);
  });

  it("reports what the measurement itself cost", async () => {
    const model = new FakeModel('{"covered": false, "caseIndex": -1}', { tokens: 120 });
    const deterministic = scoreCoverage(gold, cases);
    const semantic = await adjudicateMisses(gold, cases, deterministic, model);
    expect(semantic).toMatchObject({ calls: 2, tokens: 240 });
  });
});
