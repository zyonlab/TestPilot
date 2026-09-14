/**
 * 清空运行数据：工作流运行、产物、审核决定、基线、执行记录、花费。
 *
 * 不删的：项目本身（`projects`）、模型配置（`model.json`）、密钥（`secret.key`）、
 * 以及 `benchmark/` 下的 gold / human-labels / held-out / rubric——那些是真源，不是运行产物。
 *
 * 删之前先停服务：SQLite 开着 WAL 能容忍并发写，但清表这种事和正在跑的运行撞上，
 * 留下的是「表空了、目录还在」的半截状态，比没清更难查。
 */
import { config } from "dotenv";
import { rmSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
config({ path: resolve(import.meta.dirname, "../.env"), quiet: true } as never);
const { DATA_DIR } = await import("../src/datadir.js");
const { runLedger } = await import("../src/runService.js");
const dbmod = await import("../src/db.js");

const LEDGER = ["artifact_revisions", "case_approval_events", "case_approval_heads", "decision_outbox",
  "execution_baselines", "reviewed_case_heads", "role_spend", "run_memory", "run_retrievals",
  "run_stage_receipts", "run_work_units", "wf_node_outputs", "wf_run_registrations", "wf_runs",
  "workflow_controls", "workflow_events", "workflow_executions", "workflow_node_states", "workflow_start_requests"];
const APP = ["baselines", "case_revision_bindings", "perf_baselines", "runs", "test_cases",
  "run_model_snapshots", "run_write_grants", "batches", "batch_runs", "flakiness"];
const DIRS = ["revision-blobs", "artifacts", "inputs", "uploads", "private-run-grants"];

function wipe(db: { prepare: (sql: string) => { run: () => unknown; get: () => unknown }; exec: (sql: string) => unknown }, tables: string[], label: string) {
  for (const t of tables) {
    try {
      const before = (db.prepare(`SELECT count(*) c FROM "${t}"`).get() as { c: number }).c;
      if (!before) continue;
      db.prepare(`DELETE FROM "${t}"`).run();
      console.log(`${label} ${t}: -${before}`);
    } catch { /* 表不存在就跳过：不同版本的数据目录表不一样 */ }
  }
}
/**
 * 外键先关掉再清。
 *
 * 这几张表互相引用（`artifact_revisions` → `wf_run_registrations` → `wf_runs`），按任何顺序
 * 单表 DELETE 都会在中途撞上外键。关掉约束整批删，再打开——不是绕过约束，是**整批一起走**：
 * 删完之后没有任何一边剩下，约束本来要挡的「引用了不存在的行」不会发生。
 */
runLedger().db.exec("PRAGMA foreign_keys=OFF");
wipe(runLedger().db as never, LEDGER, "ledger");
runLedger().db.exec("PRAGMA foreign_keys=ON");
wipe(dbmod.db as never, APP, "app   ");
for (const d of DIRS) {
  const p = join(DATA_DIR, d);
  if (!existsSync(p)) continue;
  const n = readdirSync(p).length;
  rmSync(p, { recursive: true, force: true });
  console.log(`dir    ${d}: -${n}`);
}
runLedger().db.exec("VACUUM"); dbmod.db.exec("VACUUM");
console.log("剩下的项目：", (dbmod.db.prepare("SELECT count(*) c FROM projects").get() as { c: number }).c);
