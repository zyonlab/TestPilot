import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { degradeDecision, recordDegrade } from "../src/degrade.js";

/** T-16：agent 改弱判据 → 拦；人改弱 → 放行但标记；不改弱 → 什么都不发生。 */
const before = { id: "tc-1", projectId: "p", expected: "页面显示「Error」", tier: 1, oracle: { kind: "text", value: "Error" } };

describe("退化门", () => {
  it("agent 把 text 判据改空：block", () => {
    const d = degradeDecision(before, { oracle: { kind: "text", value: "" } }, "agent");
    expect(d.block).toBe(true);
    expect(d.findings[0].kind).toBe("oracle-weakened");
  });
  it("人删掉判据：不拦，标 degraded", () => {
    const d = degradeDecision(before, { oracle: undefined }, "human");
    expect(d.block).toBe(false);
    expect(d.mark).toBe(true);
  });
  it("只改步骤文案：无发现", () => {
    const d = degradeDecision(before, { steps: [{ text: "点 Sign in" }] }, "agent");
    expect(d.findings).toEqual([]);
    expect(d.block).toBe(false);
  });
  it("账本一行一次", () => {
    const dir = mkdtempSync(join(tmpdir(), "tp-deg-"));
    recordDegrade({ caseId: "tc-1", projectId: "p", actor: "agent", blocked: true, findings: ["x"] }, dir);
    expect(existsSync(join(dir, "degrades.jsonl"))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "degrades.jsonl"), "utf8").trim())).toMatchObject({ caseId: "tc-1", blocked: true });
  });
});
