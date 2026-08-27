import { describe, expect, it } from "vitest";
import { describeLeaning, scoreDetection, type DetectionCase } from "../src/eval/detect.js";
import { comparePaired, mcnemar } from "../src/eval/paired.js";

const c = (id: string, predicted: "passed" | "failed", actual: "passed" | "failed", excluded = false): DetectionCase => ({
  caseId: id,
  predicted,
  actual,
  excluded,
});

describe("scoreDetection", () => {
  it("treats a reported failure as the positive class", () => {
    const r = scoreDetection([
      c("1", "failed", "failed"), // caught a real defect
      c("2", "failed", "passed"), // false alarm
      c("3", "passed", "failed"), // missed one
      c("4", "passed", "passed"),
    ]);
    expect(r).toMatchObject({ truePositives: 1, falsePositives: 1, falseNegatives: 1, trueNegatives: 1 });
    expect(r.precision).toBe(0.5);
    expect(r.recall).toBe(0.5);
    expect(r.f1).toBe(0.5);
  });

  it("excludes environmental failures instead of scoring them as wrong verdicts", () => {
    const r = scoreDetection([c("1", "failed", "passed", true), c("2", "failed", "failed")]);
    expect(r.excluded).toBe(1);
    expect(r.precision).toBe(1); // the infra case never entered the arithmetic
  });

  it("says when a version cries wolf", () => {
    const r = scoreDetection([
      c("1", "failed", "failed"),
      c("2", "failed", "passed"),
      c("3", "failed", "passed"),
      c("4", "failed", "passed"),
    ]);
    expect(r.leaning).toBe("false-alarms");
    expect(describeLeaning(r)).toMatch(/cries wolf: 75%/);
  });

  it("says when a version stays silent", () => {
    const r = scoreDetection([
      c("1", "passed", "failed"),
      c("2", "passed", "failed"),
      c("3", "passed", "failed"),
      c("4", "failed", "failed"),
      c("5", "passed", "passed"),
    ]);
    expect(r.leaning).toBe("silence");
    expect(describeLeaning(r)).toMatch(/stays silent: it found 25%/);
  });

  it("distinguishes the two failures even at similar F1 — they want opposite fixes", () => {
    const noisy = scoreDetection([
      c("1", "failed", "failed"),
      c("2", "failed", "failed"),
      c("3", "failed", "passed"),
      c("4", "failed", "passed"),
      c("5", "failed", "passed"),
    ]);
    const quiet = scoreDetection([
      c("1", "failed", "failed"),
      c("2", "passed", "failed"),
      c("3", "passed", "failed"),
      c("4", "passed", "failed"),
      c("5", "passed", "passed"),
    ]);
    expect(noisy.leaning).toBe("false-alarms");
    expect(quiet.leaning).toBe("silence");
    // Close enough in score that a single F1 would not tell them apart; opposite diseases.
    expect(Math.abs(noisy.f1 - quiet.f1)).toBeLessThan(0.2);
  });

  it("reports nothing rather than a flattering zero when nothing was judged", () => {
    const r = scoreDetection([c("1", "passed", "passed")]);
    expect(r.leaning).toBe("undetermined");
    expect(describeLeaning(r)).toMatch(/nothing was judged/);
  });
});

describe("mcnemar", () => {
  it("ignores the items both versions agreed on", () => {
    const r = mcnemar([
      { id: "1", a: true, b: true },
      { id: "2", a: false, b: false },
    ]);
    expect(r).toMatchObject({ aOnly: 0, bOnly: 0, p: 1 });
    expect(r.reading).toMatch(/nothing to compare/);
  });

  it("calls a clear one-sided improvement significant", () => {
    const pairs = Array.from({ length: 10 }, (_, i) => ({ id: String(i), a: false, b: true }));
    const r = mcnemar(pairs);
    expect(r.bOnly).toBe(10);
    expect(r.p).toBeLessThan(0.05);
    expect(r.reading).toMatch(/B is better/);
  });

  it("refuses to call a two-item edge significant", () => {
    const r = mcnemar([
      { id: "1", a: false, b: true },
      { id: "2", a: false, b: true },
      { id: "3", a: true, b: true },
    ]);
    expect(r.p).toBeGreaterThan(0.05);
    expect(r.reading).toMatch(/could easily be chance/);
  });

  it("reports no direction when the disagreements are even", () => {
    const r = mcnemar([
      { id: "1", a: true, b: false },
      { id: "2", a: false, b: true },
    ]);
    expect(r.reading).toMatch(/evenly split/);
  });
});

describe("comparePaired", () => {
  it("reports direction counts alongside the mean, because a mean hides them", () => {
    // Overall it improved, and yet most items got worse — the shape that a single average
    // would have concealed entirely.
    const r = comparePaired([
      { id: "1", a: 0.5, b: 0.9 },
      { id: "2", a: 0.5, b: 0.45 },
      { id: "3", a: 0.5, b: 0.45 },
    ]);
    expect(r.meanDelta).toBeGreaterThan(0);
    expect(r).toMatchObject({ improved: 1, worsened: 2, unchanged: 0 });
  });

  it("handles an empty comparison without dividing by nothing", () => {
    expect(comparePaired([])).toMatchObject({ n: 0, meanDelta: 0 });
  });
});
