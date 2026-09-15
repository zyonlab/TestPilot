import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { checkRun, type GuardContext } from "@testpilot/harness-testing";
import { config } from "./procs.js";

export function runEnvReset(cmd: unknown): string[] | null {
  if (typeof cmd !== "string" || !cmd.trim()) return null;
  const result = spawnSync(cmd, { shell: true, cwd: resolve(import.meta.dirname, "../.."), encoding: "utf8", timeout: 60_000 });
  if (result.error || result.signal || result.status !== 0) throw new Error("ENV_RESET_FAILED");
  return ["environment reset completed"];
}
/**
 * 跑之前过一道守卫。`context` 来自这个被测对象的环境（人勾选的 `allowIrreversible`）与这次运行
 * 绑定的规则包（`sideEffectLabels`）。
 */
export function guardRun(url: string, steps: string[], context: GuardContext = {}) {
  const verdict = checkRun(url, steps, config.guard, context);
  if (!verdict.allow) { const error = new Error(`blocked by the guard: ${verdict.why}`) as Error & { code?: string }; error.code = verdict.code; throw error; }
}
