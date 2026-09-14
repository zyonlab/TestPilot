/** Opt-in real host integration. Uses a disposable TestPilot DB and a local counter specification. */
import { config } from "dotenv";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import express from "express";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

if (!process.argv.includes("--real")) throw new Error("Pass --real to use the configured host model.");
const web = process.argv.includes("--web");
const runtime = web ? "web" : process.argv.includes("--codex") ? "codex" : process.argv.includes("--claude") ? "claude-code" : "penguin";
const root = resolve(import.meta.dirname, "../..");
config({ path: join(root, "server/.env"), quiet: true } as any);
const dir = mkdtempSync(join(tmpdir(), `tp-native-${runtime}-`));
process.env.TP_DATA_DIR = join(dir, "data");
const evidenceDir = resolve(process.env.TP_EVIDENCE_DIR ?? join(root, `docs/v3/evidence/n-04/real-${runtime}`));
mkdirSync(evidenceDir, { recursive: true });
const database = await import("../src/db.js"), service = await import("../src/runService.js"), stages = await import("../src/runStages.js");
const project = database.createProject(`Host stage verification (${runtime})`, "http://127.0.0.1");
const app = express(); app.use(express.json({ limit: "16mb" }));
app.use("/api/projects/:projectId/workflow-runs", (await import("../src/runRoutes.js")).runRouter());
const http = app.listen(0, "127.0.0.1"); await once(http, "listening");
process.env.TP_SERVER_URL = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
const penguin = await import("../src/penguin.js");
const launch = await import("../src/runtime/skill-launch.js");
const runId = `verify-${runtime}-${Date.now()}`, workspace = join(dir, "workspace"), materialsDir = join(workspace, "materials"), outDir = join(workspace, "runs", runId);
mkdirSync(materialsDir, { recursive: true }); mkdirSync(outDir, { recursive: true });
writeFileSync(join(materialsDir, "counter.md"), `# Counter: bounded local test specification
## User purpose
A visitor counts button clicks. One story is sufficient; design two independent cases.
## State and rules
Given a fresh page, count is 0. Clicking the visible Increment button once changes count to 1.
The visible Reset button sets count to 0. Clicking Reset when count is already 0 keeps it 0 (boundary).
The count is rendered in a visible element with data-testid=count. Increment and Reset are buttons with those exact accessible names.
Each case starts on a fresh page with count 0. After each case, Reset restores count 0.
There is no login, network operation, payment or trade. Assertions must use only the stated rules.
`);
const calls: Array<Record<string, unknown>> = [];
const startedAt = new Date().toISOString();
let session: any, failure: string | undefined;
try {
  if (web) {
    const webRun = await import("../src/penguinRun.js");
    await webRun.startRun({ wfRunId: runId, workspace, materialsDir, target: { projectId: project.id }, limit: 1, generationMode: "skill" });
    const deadline = Date.now() + 600_000;
    while (Date.now() < deadline) {
      const state = service.runLedger().getRun(runId, project.id);
      if (stages.registeredStageProducts(runId).finalized) break;
      if (["failed", "cancelled", "interrupted"].includes(state.status)) { failure = `web_${state.status}`; break; }
      await new Promise(r => setTimeout(r, 1000));
    }
    if (failure) webRun.cancelRun(runId);
    else (await import("../src/runtime/managed-penguin.js")).cancelManagedRun(runId);
    writeFileSync(join(evidenceDir, "host.json"), JSON.stringify({ runtime: "penguin", entry: "web", modelRoles: service.runLedger().getRun(runId, project.id).binding?.models }, null, 2));
  } else if (runtime === "codex") {
    const adapter = await import("../src/codex.js");
    const started = await adapter.startRun({ runId, workspace, materialsDir, scopeProjectId: project.id, limit: 1 });
    const result = await new Promise<{ status: string; error?: string }>(done => adapter.watchRun({ ...started, scopeProjectId: project.id, timeoutMs: 600_000, pollMs: 1000, onEvent: e => calls.push({ node: e.node, phase: e.phase, at: e.at }), onDone: done }));
    adapter.cancelRun(runId); if (result.status !== "done") failure = result.error ?? "codex_not_finalized";
    const events = readFileSync(join(outDir, "codex-events.jsonl"), "utf8").trim().split("\n").flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    const toolCalls = events.filter(e => e.type === "item.completed" && e.item?.type === "mcp_tool_call").map(e => ({ server: e.item.server, tool: e.item.tool, status: e.item.status }));
    writeFileSync(join(evidenceDir, "host.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(outDir, "host-identity.json"), "utf8")), toolCalls, usage: events.filter(e => e.type === "turn.completed").map(e => e.usage), calls }, null, 2));
  } else if (runtime === "claude-code") {
    const claude = await import("../src/claudecode.js");
    const started = await claude.startRun({ runId, workspace, materialsDir, scopeProjectId: project.id, limit: 1 });
    const result = await new Promise<{ status: string; error?: string }>(done => claude.watchRun({ ...started, scopeProjectId: project.id, timeoutMs: 600_000, pollMs: 1000,
      onEvent: e => calls.push({ node: e.node, phase: e.phase, at: e.at }), onDone: done }));
    claude.cancelRun(runId);
    if (result.status !== "done") failure = result.error ?? "claude_not_finalized";
    const stream = readFileSync(join(outDir, "claude-stream.jsonl"), "utf8").trim().split("\n").flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    const init = stream.find(x => x.type === "system" && x.subtype === "init");
    writeFileSync(join(evidenceDir, "host.json"), JSON.stringify({ runtime, model: init?.model ?? null, sessionId: started.sessionId,
      result: stream.filter(x => x.type === "result").map(x => ({ is_error: x.is_error, subtype: x.subtype, usage: x.usage, total_cost_usd: x.total_cost_usd })), calls }, null, 2));
  } else {
    const started = await penguin.startRun({ runId, workspace, materialsDir, scopeProjectId: project.id, limit: 1 });
    const result = await new Promise<{ status: string; error?: string }>(done => penguin.watchRun({ ...started, scopeProjectId: project.id, timeoutMs: 600_000, pollMs: 1000,
      onEvent: e => calls.push({ node: e.node, phase: e.phase, at: e.at }), onDone: done }));
    (await import("../src/runtime/native-penguin.js")).cancelNativeRun(runId);
    if (result.status !== "done") failure = result.error ?? "penguin_not_finalized";
    const identity = JSON.parse(readFileSync(join(outDir, "host-identity.json"), "utf8"));
    writeFileSync(join(evidenceDir, "host.json"), JSON.stringify({ ...identity, calls }, null, 2));
  }
  if (!stages.registeredStageProducts(runId).finalized) failure ??= "host_finished_without_finalization";
} catch (e) { failure = (e as Error).message.slice(0, 500); }
finally {
  await session?.dispose();
  const run = service.runLedger().getRun(runId, project.id);
  const artifacts = run.revisions.map(r => service.runLedger().readRevision(r.id, project.id));
  writeFileSync(join(evidenceDir, "result.json"), JSON.stringify({ runtime, runId, startedAt, finishedAt: new Date().toISOString(), passed: !failure, failure,
    run, artifacts, privateWorkspace: dir }, null, 2));
  await new Promise<void>(r => http.close(() => r())); service.runLedger().close(); database.db.close();
}
console.log(JSON.stringify({ runtime, runId, passed: !failure, failure, evidenceDir }));
process.exit(failure ? 1 : 0);
