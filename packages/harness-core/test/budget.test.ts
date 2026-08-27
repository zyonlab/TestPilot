import { describe, expect, it } from "vitest";
import { estimateTokens, fitToBudget, trimMiddle } from "../src/model/budget.js";

const long = (n: number) => "x".repeat(n);

describe("estimateTokens", () => {
  it("counts CJK far heavier than Latin, which is what the window actually sees", () => {
    expect(estimateTokens("登录模块的产品规格")).toBeGreaterThan(estimateTokens("login spec"));
    expect(estimateTokens("")).toBe(0);
  });
});

describe("trimMiddle", () => {
  it("keeps the head and the tail and says what it removed", () => {
    const text = `START ${long(4000)} END`;
    const cut = trimMiddle(text, 100);
    expect(cut.startsWith("START")).toBe(true);
    expect(cut.endsWith("END")).toBe(true);
    expect(cut).toContain("trimmed to fit");
    expect(estimateTokens(cut)).toBeLessThanOrEqual(110);
  });

  it("leaves text that already fits completely alone", () => {
    expect(trimMiddle("short enough", 100)).toBe("short enough");
  });
});

describe("fitToBudget", () => {
  it("leaves everything intact when it fits", () => {
    const r = fitToBudget(
      [
        { name: "spec", text: "short spec", share: 3 },
        { name: "story", text: "short story", share: 1 },
      ],
      1000,
    );
    expect(r.fits).toBe(true);
    expect(r.dropped).toBe(0);
  });

  it("never trims a fixed part — an instruction that lost its middle is worse than useless", () => {
    const r = fitToBudget(
      [
        { name: "schema", text: long(2000), share: 0, fixed: true },
        { name: "spec", text: long(8000), share: 1 },
      ],
      600,
    );
    expect(r.parts.find((p) => p.name === "schema")!.dropped).toBe(0);
    expect(r.parts.find((p) => p.name === "spec")!.dropped).toBeGreaterThan(0);
  });

  it("gives an under-budget part's leftover to the part that needs it", () => {
    // Without redistribution, `spec` would be capped at half the window while `story`
    // wasted its half on two words — i.e. a smaller window for no reason.
    const withSpare = fitToBudget(
      [
        { name: "spec", text: long(8000), share: 1 },
        { name: "story", text: "tiny", share: 1 },
      ],
      500,
    );
    const withoutSpare = fitToBudget(
      [
        { name: "spec", text: long(8000), share: 1 },
        { name: "story", text: long(8000), share: 1 },
      ],
      500,
    );
    const specWith = withSpare.parts.find((p) => p.name === "spec")!.tokens;
    const specWithout = withoutSpare.parts.find((p) => p.name === "spec")!.tokens;
    expect(specWith).toBeGreaterThan(specWithout);
  });

  it("reports what it dropped rather than shrinking the prompt silently", () => {
    const r = fitToBudget([{ name: "spec", text: long(20000), share: 1 }], 300);
    expect(r.dropped).toBeGreaterThan(0);
    expect(r.total).toBeLessThanOrEqual(r.limit);
    expect(r.parts[0].text).toContain("trimmed");
  });

  it("stays within the limit even when every part is oversized", () => {
    const r = fitToBudget(
      [
        { name: "a", text: long(9000), share: 2 },
        { name: "b", text: long(9000), share: 1 },
      ],
      400,
    );
    expect(r.total).toBeLessThanOrEqual(400);
    // …and the bigger share still gets the bigger allowance.
    expect(r.parts[0].tokens).toBeGreaterThan(r.parts[1].tokens);
  });
});
