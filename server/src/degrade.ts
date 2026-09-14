/**
 * 自愈退化的门（07 T-16）：一次对用例的改动是不是把它改弱了，以及该不该拦。
 * 规则在 `harness-testing/codegen/degrade.ts`；这里只决定「谁改的、拦不拦、记什么」。
 * `agent`（MCP / 自愈路径）改弱一律拦，回到人；人改弱放行但记账、把用例标 `degraded`。
 */
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { classifyDegrade, type DegradeFinding } from "@testpilot/harness-testing";
import { DATA_DIR } from "./datadir.js";

export interface DegradableCaseLike {
  id: string;
  projectId?: string;
  expected?: string;
  tier?: number;
  oracle?: unknown;
}

export interface DegradeDecision {
  findings: DegradeFinding[];
  /** 拦下（agent 改弱）。 */
  block: boolean;
  /** 放行但标 degraded（人改弱）。 */
  mark: boolean;
  actor: "agent" | "human";
}

export function degradeDecision(before: DegradableCaseLike, patch: Record<string, unknown>, actor: unknown): DegradeDecision {
  const who: "agent" | "human" = actor === "human" ? "human" : "agent";
  const after = { ...before, ...patch } as DegradableCaseLike;
  const findings = classifyDegrade(
    { id: before.id, expected: before.expected, tier: before.tier, oracle: before.oracle as never },
    { id: after.id, expected: after.expected, tier: after.tier, oracle: after.oracle as never },
  );
  return { findings, block: findings.length > 0 && who === "agent", mark: findings.length > 0 && who === "human", actor: who };
}

/** 退化账本：`<DATA_DIR>/degrades.jsonl`，`cost-report` 数它。记不下来不影响本次判决。 */
export function recordDegrade(row: { caseId: string; projectId?: string; actor: "agent" | "human"; blocked: boolean; findings: string[] }, dataDir: string = DATA_DIR): void {
  try {
    appendFileSync(resolve(dataDir, "degrades.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...row }) + "\n");
  } catch {
    /* best effort */
  }
}
