import { describe, expect, it } from "vitest";
import { digestDiff, digestTexts, sha8 } from "../src/util/digest.js";

/**
 * A run pins its graph version, which fixes the shape and every parameter — and says
 * nothing about the instructions. This is the part that notices when those move.
 */

describe("fingerprinting the instructions a run was produced by", () => {
  it("is stable for the same texts and changes when any one of them does", () => {
    const a = digestTexts({ "plan.stories": "one", "design.cases": "two" });
    expect(digestTexts({ "design.cases": "two", "plan.stories": "one" }).combined).toBe(a.combined);
    const b = digestTexts({ "plan.stories": "one", "design.cases": "two!" });
    expect(b.combined).not.toBe(a.combined);
  });

  it("points at which instruction moved, not merely that something did", () => {
    const a = digestTexts({ "plan.stories": "one", "design.cases": "two", "repair.loop": "three" });
    const b = digestTexts({ "plan.stories": "one", "design.cases": "CHANGED", "repair.loop": "three" });
    expect(digestDiff(a, b)).toEqual(["design.cases"]);
    expect(digestDiff(a, a)).toEqual([]);
  });

  it("counts a prompt that appeared or vanished as a difference", () => {
    // Adding an instruction is a change to what the model was told, even though every
    // prompt that was already there is untouched.
    const before = digestTexts({ "design.cases": "two" });
    const after = digestTexts({ "design.cases": "two", "design.cases:oracle-strict": "extra" });
    expect(before.combined).not.toBe(after.combined);
    expect(digestDiff(before, after)).toEqual(["design.cases:oracle-strict"]);
  });

  it("is short enough to sit in a run record and read back", () => {
    expect(sha8("x")).toHaveLength(8);
  });
});
