/**
 * **Claude Code 宿主按工作单元规划**一条运行：探索留在服务端，规划交给宿主，一次领一个单元。
 *
 * 为什么不直接用 `drive-claude-host.ts`：那个脚本只登记材料文本，账本里没有
 * `product/model-candidate`，而 `planUnits` 正是按它切单元的——于是那条路上的宿主运行
 * **从来开不了 workUnits**。2026-09-15 回查 Vikunja 那次宿主运行，parameters 里确实没有它。
 *
 * 也不直接让 Web 工作流接着跑：`launchSource` 探索完就去拉 Penguin，绑定里记的规划方
 * 也是 Penguin。这里的分工照 `start-hl-arm.ts --arm host`：
 *   ① 一条带规则包的 Web 探索运行（`--from`）出探索报告与产品模型；
 *   ② 另登记一条 **claude-code 宿主运行**，`workUnits: 1`，把规则包、产品模型、探索报告原样拷进去；
 *   ③ 起 Claude Code，话术用单元循环那一份（`unitGenerationMessage`）。
 *
 * **不代人冻结模块树。** `freezeModulePlan` 只收 `kind: "human"`；上一个脚本用一个
 * 叫 OPERATOR 的 human 身份绕过去，那等于在账本里写了一句假话。这里只把树摆出来，
 * 冻结交给人；冻完用 `--run <runId>` 再起一个会话接着走。
 *
 * 用法：
 *   tsx scripts/drive-host-units.ts --project <id> --from <探索运行 id> [--limit 1]
 *   tsx scripts/drive-host-units.ts --project <id> --run <已登记的宿主运行 id> [--limit 1]
 */
import { config } from "dotenv";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
const root = resolve(import.meta.dirname, "../..");
config({ path: join(root, "server/.env"), quiet: true } as never);
const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i < 0 ? undefined : process.argv[i + 1]; };
const projectId = arg("project");
const fromRun = arg("from");
const existing = arg("run");
const limit = Number(arg("limit") ?? 1);
if (!projectId || (!fromRun && !existing)) throw new Error("用法: --project <id> (--from <探索运行> | --run <宿主运行>)");

const { runLedger, registerHostRun } = await import("../src/runService.js");
const { dataPath } = await import("../src/datadir.js");
const moduleStage = await import("../src/moduleStage.js");
const claude = await import("../src/claudecode.js");
const { unitGenerationMessage } = await import("../src/runtime/skill-launch.js");
const l = runLedger();

let runId = existing;
if (!runId) {
  const latest = (name: string) => {
    const r = l.listRevisions(projectId, fromRun!).filter((x) => x.name === name).sort((a, b) => a.revision - b.revision).at(-1);
    if (!r) throw new Error(`探索运行 ${fromRun} 里没有 ${name}——它不是一条带规则包、跑完了 source 的运行`);
    return { revision: r, content: l.readRevision(r.id, projectId).content };
  };
  const material = latest("exploration.md").content as string;
  const pack = l.listRevisions(projectId, fromRun!).find((x) => x.name.startsWith("knowledge/rulepack/"));
  if (!pack) throw new Error("探索运行没绑规则包：没有规则包就没有产品模型，工作单元切不出来");
  const key = `host-units-${fromRun}`;
  const registered = registerHostRun(projectId, {
    runtime: "claude-code", externalId: key, idempotencyKey: key,
    materials: [{ name: "exploration.md", text: material }],
    parameters: { workUnits: 1, limit, outputLanguage: "zh", derivedFrom: fromRun },
  });
  runId = registered.runId;
  if (registered.created) {
    const copy = (name: string, content: unknown, by: "web" | "explorer" | "stage-validator") =>
      l.putRevision({ projectId, runId: runId!, name, kind: "report", content }, { kind: "system", id: by });
    copy(pack.name, l.readRevision(pack.id, projectId).content, "web");
    copy("exploration/report", latest("exploration/report").content, "explorer");
    copy("product/model-candidate", latest("product/model-candidate").content, "stage-validator");
  }
  console.log(`宿主运行 ${runId}（${registered.created ? "新登记" : "已存在"}），材料 ${material.length} 字，派生自 ${fromRun}`);
}

const workspace = dataPath(`host-workspaces/${runId}`);
const materialsDir = join(workspace, "materials");
mkdirSync(materialsDir, { recursive: true });
writeFileSync(join(materialsDir, "exploration.md"),
  l.readRevision(l.listRevisions(projectId, runId).find((r) => r.name === "exploration.md")!.id, projectId).content as string);

const plans: unknown[] = [];
const watcher = setInterval(() => {
  try {
    const m = moduleStage.modulePlanState(runId!, projectId);
    if (!m.exists || m.frozen || plans.length) return;
    plans.push(m);
    console.log(`模块树已提议（${m.modules} 个模块，机检 ${m.findings.length} 条）——等人冻结，本脚本不代冻`);
  } catch { /* 还没提议 */ }
}, 3000);

const outDir = join(workspace, "runs", runId);
const message = unitGenerationMessage({ materialsDir, outDir, limit, workUnits: true });
const started = await claude.startRun({ runId, workspace, materialsDir, scopeProjectId: projectId, limit, envRef: "local", message });
console.log("claude session:", started.sessionId);
const result = await new Promise<{ status: string; error?: string }>((done) =>
  claude.watchRun({ ...started, scopeProjectId: projectId, timeoutMs: 120 * 60_000,
    onEvent: (e: { node: string; phase: string }) => console.log(`  ${new Date().toISOString()} ${e.node}:${e.phase}`), onDone: done } as never));
clearInterval(watcher);
claude.cancelRun(runId);
console.log(JSON.stringify({ runId, projectId, status: result.status, error: result.error, modulePlan: plans[0] ?? null }, null, 1));
process.exit(0);
