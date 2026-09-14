import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { checkRun } from "@testpilot/harness-testing";
import { config } from "./procs.js";

export function runEnvReset(cmd: unknown): string[] | null {
  if (typeof cmd !== "string" || !cmd.trim()) return null;
  const result = spawnSync(cmd, { shell: true, cwd: resolve(import.meta.dirname, "../.."), encoding: "utf8", timeout: 60_000 });
  if (result.error || result.signal || result.status !== 0) throw new Error("ENV_RESET_FAILED");
  return ["environment reset completed"];
}
export function guardRun(url: string, steps: string[]) {
  const verdict = checkRun(url, steps, config.guard);
  if (!verdict.allow) { const error = new Error(`blocked by the guard: ${verdict.why}`) as Error & { code?: string }; error.code = verdict.code; throw error; }
}
