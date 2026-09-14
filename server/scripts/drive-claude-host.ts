/**
 * 把一次服务端探索出来的材料交给 **Claude Code 宿主**，由它驱动 modules → finalize。
 *
 * 2026-09-14：这是 PR #3 的实测没覆盖到的那一半——那次用的是脚本自带的本地 counter 规格，
 * 这次是真实的重前端页面（hyperliquid 测试网交易页，6 屏、32,656 字材料）。
 *
 * 探索留在服务端：MCP 里没有探索工具（`register_run` 收的是材料文本），
 * 而且探索要浏览器，宿主 agent 没有。所以分工是：服务端探索 → 宿主规划 → 人审核 → 执行。
 *
 * 冻结模块树那一下仍然必须有人明说：默认不按，`--freeze-as-operator` 才按，并记进日志。
 */
import { config } from "dotenv";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
const root = resolve(import.meta.dirname, "../..");
config({ path: join(root, "server/.env"), quiet: true } as never);
const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i < 0 ? undefined : process.argv[i + 1]; };
const projectId = arg("project")!, fromRun = arg("from")!;
const limit = Number(arg("limit") ?? 4);
const freezeAsOperator = process.argv.includes("--freeze-as-operator");

const { runLedger } = await import("../src/runService.js");
const { dataPath } = await import("../src/datadir.js");
const moduleStage = await import("../src/moduleStage.js");
const claude = await import("../src/claudecode.js");
const l = runLedger();

const material = l.readRevision(l.listRevisions(projectId, fromRun).filter((r: any) => r.name === "exploration.md").at(-1)!.id, projectId).content as string;
const runId = `cc-host-${Date.now()}`;
const workspace = dataPath(`host-workspaces/${runId}`), materialsDir = join(workspace, "materials");
mkdirSync(materialsDir, { recursive: true });
writeFileSync(join(materialsDir, "exploration.md"), material);
console.log(`材料 ${material.length} 字符 → ${materialsDir}`);

const freezes: unknown[] = [];
const watcher = setInterval(() => {
  if (!freezeAsOperator) return;
  try {
    const m = moduleStage.modulePlanState(runId, projectId);
    if (!m.exists || m.frozen) return;
    const r = moduleStage.freezeModulePlan(runId, projectId, { kind: "human", id: "CLAUDE_HOST_E2E_OPERATOR" });
    freezes.push({ at: new Date().toISOString(), ...r });
    console.log("freeze(operator):", JSON.stringify(r).slice(0, 200));
  } catch { /* 还没到能冻结的状态 */ }
}, 2000);

const started = await claude.startRun({ runId, workspace, materialsDir, scopeProjectId: projectId, limit });
console.log("claude session:", started.sessionId);
const result = await new Promise<{ status: string; error?: string }>((done) =>
  claude.watchRun({ ...started, scopeProjectId: projectId, timeoutMs: 45 * 60_000,
    onEvent: (e: any) => console.log(`  ${e.node}:${e.phase}`), onDone: done } as never));
clearInterval(watcher);
claude.cancelRun(runId);
console.log(JSON.stringify({ runId, projectId, status: result.status, error: result.error, freezes }, null, 1));
