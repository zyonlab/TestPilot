import { describe, expect, it } from "vitest";
import {
  describeOracle,
  evaluateOracle,
  MachineOracleSchema,
  readNumberNear,
  tierOf,
  type PageSnapshot,
} from "../src/exec/oracle.js";

/**
 * These are the checks a program settles. Everything here has to be decidable without a
 * model — that is the whole point, and a test that needed one would be evidence the design
 * had slipped back.
 */

const page = (text: string, url = "http://localhost:5300/#/processes"): PageSnapshot => ({ text, url });

describe("a literal the interface shows", () => {
  it("passes when it is there and fails with what was actually on the page", () => {
    expect(evaluateOracle({ kind: "text", value: "用户名不能为空" }, page("表单：用户名不能为空"))).toMatchObject({
      status: "pass",
    });
    const miss = evaluateOracle({ kind: "text", value: "用户名不能为空" }, page("欢迎回来"));
    expect(miss.status).toBe("fail");
    expect(miss.detail).toContain("没有");
  });

  it("settles absence too — the assertion negative cases need", () => {
    expect(evaluateOracle({ kind: "noText", value: "Invalid" }, page("Your dashboard"))).toMatchObject({
      status: "pass",
    });
    expect(evaluateOracle({ kind: "noText", value: "Invalid" }, page("Invalid password"))).toMatchObject({
      status: "fail",
    });
  });
});

describe("where the run ended up", () => {
  it("checks the address without asking anyone's opinion", () => {
    expect(evaluateOracle({ kind: "url", value: "#/review" }, page("x", "http://a/#/review"))).toMatchObject({
      status: "pass",
    });
    const wrong = evaluateOracle({ kind: "url", value: "#/review" }, page("x", "http://a/#/cases"));
    expect(wrong.status).toBe("fail");
    expect(wrong.detail).toContain("#/cases");
  });
});

describe("how many times something appears", () => {
  it("counts occurrences and reports the number it found", () => {
    const snap = page("gateway 运行中 agent 运行中 runner-1 运行中");
    expect(evaluateOracle({ kind: "count", value: "运行中", op: "eq", n: 3 }, snap).status).toBe("pass");
    expect(evaluateOracle({ kind: "count", value: "运行中", op: "gte", n: 4 }, snap)).toMatchObject({
      status: "fail",
      detail: expect.stringContaining("出现 3 次"),
    });
  });
});

describe("a relation between two observations (tier 2)", () => {
  it("compares the number beside a label, before and after", () => {
    const before = page("重启次数 0 心跳 1s");
    const after = page("重启次数 1 心跳 0s");
    expect(evaluateOracle({ kind: "delta", value: "重启次数", direction: "increased", by: 1 }, after, before))
      .toMatchObject({ status: "pass", detail: expect.stringContaining("0 → 1") });
    expect(evaluateOracle({ kind: "delta", value: "重启次数", direction: "decreased" }, after, before).status).toBe(
      "fail",
    );
  });

  it("says it could not measure, rather than blaming the product", () => {
    // Both of these are harness failures wearing a test failure's clothes if reported badly.
    const noBefore = evaluateOracle({ kind: "delta", value: "重启次数", direction: "increased" }, page("重启次数 1"));
    expect(noBefore.detail).toContain("没有取到步骤执行前的快照");

    const unreadable = evaluateOracle(
      { kind: "delta", value: "余额", direction: "increased" },
      page("余额 —"),
      page("余额 —"),
    );
    expect(unreadable.detail).toContain("读不到");
  });

  it("refuses to guess when the same label carries two different numbers", () => {
    expect(readNumberNear("重启次数 0 … 重启次数 3", "重启次数")).toBeUndefined();
    expect(readNumberNear("重启次数 2 … 重启次数 2", "重启次数")).toBe(2);
  });
});

describe("the tier an oracle actually delivers", () => {
  it("is a fact about the check, not a label someone typed", () => {
    expect(tierOf({ kind: "text", value: "x" })).toBe(1);
    expect(tierOf({ kind: "count", value: "x", op: "eq", n: 1 })).toBe(1);
    expect(tierOf({ kind: "delta", value: "x", direction: "increased" })).toBe(2);
  });

  it("reads back as a sentence, so a report can say what was checked", () => {
    expect(describeOracle({ kind: "text", value: "已停止" })).toBe("页面显示「已停止」");
    expect(describeOracle({ kind: "delta", value: "重启次数", direction: "increased", by: 1 })).toContain("增加 1");
  });

  it("rejects a shape that is not one of the settled forms", () => {
    expect(MachineOracleSchema.safeParse({ kind: "vibes", value: "looks right" }).success).toBe(false);
    expect(MachineOracleSchema.safeParse({ kind: "count", value: "x", n: 2 }).success).toBe(true);
  });
});
