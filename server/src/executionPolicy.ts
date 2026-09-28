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
 * 判「留下了资源、整批停」之前，先问环境自己（docs/v3/15 阶段 5.4）。
 *
 * 2026-09-27：J02-04 收尾核对「页面上不再出现 Isolated」恒不成立，账户其实是干净的，整批照样停；
 * POS-05-03 是真残留（补偿时 429，0.001 BTC 没平掉）。两种情况执行器分不开——它只看得到屏幕上的收尾核对。
 * 环境可以声明一条**只读**核对命令 `vars.TP_VERIFY_CLEAN_CMD`（和 `TP_RESET_CMD` 同一种形态，内容是项目数据）：
 * 没清理的资源以 JSON 放在 `TP_PENDING_RESOURCES` 里交给它；退出码 0 = 账户里确实没有它们，1 = 确认还在，
 * 别的（没配、超时、崩了）一律当作不知道。只有 0 才不停——拿不准就停，和以前一样。
 */
export type CleanVerdict = { status: "clean" | "dirty" | "unknown"; output: string };
export function verifyCleanEnvironment(cmd: unknown, pending: Array<{ id: string; identity?: string }>, secrets: string[] = []): CleanVerdict | null {
  if (typeof cmd !== "string" || !cmd.trim()) return null;
  const result = spawnSync(cmd, { shell: true, cwd: resolve(import.meta.dirname, "../.."), encoding: "utf8", timeout: 60_000,
    env: { ...process.env, TP_PENDING_RESOURCES: JSON.stringify(pending.map((p) => ({ id: p.id, identity: p.identity ?? p.id }))) } });
  let output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().slice(-600);
  for (const secret of secrets) if (secret) output = output.split(secret).join("***");
  const status = result.error || result.signal ? "unknown" : result.status === 0 ? "clean" : result.status === 1 ? "dirty" : "unknown";
  return { status, output };
}
/**
 * 跑之前过一道守卫：禁止名单上的地址什么都不跑。不可逆步骤默认放行（它们是被测产品的功能），
 * 规则包的 `sideEffectLabels` 只在整机打开 `GUARD_STRICT` 时才用得上。
 */
export function guardRun(url: string, steps: string[], context: GuardContext = {}) {
  const verdict = checkRun(url, steps, config.guard, context);
  if (!verdict.allow) { const error = new Error(`blocked by the guard: ${verdict.why}`) as Error & { code?: string }; error.code = verdict.code; throw error; }
}
