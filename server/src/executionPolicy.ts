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
 * 跑之前过一道守卫：禁止名单上的地址什么都不跑。不可逆步骤默认放行（它们是被测产品的功能），
 * 规则包的 `sideEffectLabels` 只在整机打开 `GUARD_STRICT` 时才用得上。
 */
export function guardRun(url: string, steps: string[], context: GuardContext = {}) {
  const verdict = checkRun(url, steps, config.guard, context);
  if (!verdict.allow) { const error = new Error(`blocked by the guard: ${verdict.why}`) as Error & { code?: string }; error.code = verdict.code; throw error; }
}
