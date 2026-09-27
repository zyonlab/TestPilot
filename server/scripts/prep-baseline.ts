/**
 * 执行准备基线（docs/v3/15 阶段 0）。**只读**账本，不写任何东西。
 *
 *   npx tsx scripts/prep-baseline.ts <runId> <projectId> [--data <server/.data 目录>] [--host <宿主会话目录>] [--json out.json]
 *
 * 数的是：每条用例在所有准备批次里的探查 / 试跑次数、首轮试跑是否通过、最终是否验证通过、
 * 是否被记过残留；宿主会话里服务端拒绝（run_gateway:<code>）的次数按错误码分；准备的起止时间。
 * 拒绝不进账本，只在规划宿主的会话记录里，所以要给 --host。
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { RunLedger } from "../src/runLedger.ts";

const args = process.argv.slice(2);
const [runId, projectId] = args;
if (!runId || !projectId) { console.error("usage: prep-baseline.ts <runId> <projectId> [--data dir] [--host dir] [--json out]"); process.exit(2); }
const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const data = resolve(opt("--data") ?? "server/.data");
const ledger = new RunLedger(join(data, "workflows.db"), join(data, "revision-blobs"));

type Unit = { caseId: string; status: string; leftResources?: unknown[]; priority?: { priority?: string } };
type Batch = { id: string; status: string; units: Unit[] };
const batches = (ledger.db.prepare("SELECT json FROM preparation_batches WHERE runId=? AND projectId=? ORDER BY rowid").all(runId, projectId) as { json: string }[])
  .map((r) => JSON.parse(r.json) as Batch);

type Row = { caseId: string; priority?: string; batches: number; probes: number; trials: number; firstTrialPassed: boolean | null; verified: boolean; leftResources: number; lastStatus: string };
const rows = new Map<string, Row>();
const row = (caseId: string) => rows.get(caseId) ?? rows.set(caseId, { caseId, batches: 0, probes: 0, trials: 0, firstTrialPassed: null, verified: false, leftResources: 0, lastStatus: "" }).get(caseId)!;

for (const b of batches) for (const u of b.units) {
  const r = row(u.caseId);
  r.batches++; r.lastStatus = u.status; r.priority ??= u.priority?.priority;
  if (u.status === "verified") r.verified = true;
  if (u.leftResources?.length) r.leftResources++;
}

// 探查与试跑：preparation/<batch>/<case>/{probe-N|round-N}/result。批次按创建顺序排，首轮试跑取最早那一批的 round-1。
const order = new Map(batches.map((b, i) => [b.id, i]));
const results = ledger.listRevisions(projectId, runId).filter((r) => /^preparation\/[^/]+\/[^/]+\/(probe|round)-\d+\/result$/.test(r.name));
const firstTrial = new Map<string, { batch: number; passed: boolean }>();
for (const rev of results) {
  const [, batchId, caseId, step] = rev.name.split("/");
  const r = row(caseId!);
  if (step!.startsWith("probe")) { r.probes++; continue; }
  r.trials++;
  if (step !== "round-1") continue;
  const at = order.get(batchId!) ?? Number.MAX_SAFE_INTEGER, prev = firstTrial.get(caseId!);
  if (prev && prev.batch <= at) continue;
  const status = (ledger.readRevision(rev.id, projectId).content as { status?: string }).status;
  firstTrial.set(caseId!, { batch: at, passed: status === "passed" });
}
for (const [caseId, t] of firstTrial) row(caseId).firstTrialPassed = t.passed;

// 服务端拒绝：宿主会话里工具结果以 run_gateway:<code> 开头；needs_review 另计（服务端判「改了审核意图」）。
const rejections: Record<string, number> = {};
const host = opt("--host");
// needs_review 只算「提交试跑被服务端判为改了审核意图」：准备器自己 resolve 成 needs_review 的回执不算拒绝。
if (host) for (const file of readdirSync(host).filter((f) => f.endsWith(".jsonl"))) {
  const actionOf = new Map<string, string>();
  for (const line of readFileSync(join(host, file), "utf8").split("\n")) {
    let o: { message?: { content?: Array<{ type?: string; id?: string; input?: { action?: string }; tool_use_id?: string; content?: unknown }> } };
    try { o = JSON.parse(line); } catch { continue; }
    for (const block of o.message?.content ?? []) {
      if (block.type === "tool_use" && block.id) { actionOf.set(block.id, block.input?.action ?? ""); continue; }
      if (block.type !== "tool_result") continue;
      const text = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
      const gateway = /run_gateway:([a-z_]+)/.exec(text)?.[1];
      const intent = !gateway && actionOf.get(block.tool_use_id ?? "") === "trial" && /\\?"status\\?":\\?"needs_review/.test(text) ? "trial_changed_reviewed_intent" : undefined;
      const code = gateway ?? intent;
      if (code) rejections[code] = (rejections[code] ?? 0) + 1;
    }
  }
}

const events = ledger.db.prepare("SELECT json FROM workflow_events WHERE runId=? AND node='g2' ORDER BY rowid").all(runId) as { json: string }[];
const at = events.map((e) => (JSON.parse(e.json) as { at?: string }).at).filter(Boolean) as string[];

const all = [...rows.values()].sort((a, b) => a.caseId.localeCompare(b.caseId));
const trialed = all.filter((r) => r.firstTrialPassed !== null);
const summary = {
  runId, batches: batches.length, cases: all.length,
  verified: all.filter((r) => r.verified).length,
  probes: all.reduce((n, r) => n + r.probes, 0), trials: all.reduce((n, r) => n + r.trials, 0),
  probesPerCase: +(all.reduce((n, r) => n + r.probes, 0) / all.length).toFixed(2),
  trialsPerCase: +(all.reduce((n, r) => n + r.trials, 0) / all.length).toFixed(2),
  firstTrialPassRate: trialed.length ? +(trialed.filter((r) => r.firstTrialPassed).length / trialed.length).toFixed(3) : null,
  firstTrialCases: trialed.length,
  casesFlaggedLeftResources: all.filter((r) => r.leftResources > 0).length,
  rejections,
  preparationSpan: at.length ? { from: at[0], to: at.at(-1) } : null,
};
console.log(JSON.stringify(summary, null, 2));
const out = opt("--json");
if (out) writeFileSync(out, JSON.stringify({ summary, cases: all }, null, 2));
