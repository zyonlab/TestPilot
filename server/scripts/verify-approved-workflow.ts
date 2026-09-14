/** Real executor integration with explicit synthetic reviewer fixtures, never production approvals. */
import { config } from "dotenv";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import type { AddressInfo } from "node:net";
if (!process.argv.includes("--real")) throw new Error("Pass --real for the local browser/model integration.");
const root = resolve(import.meta.dirname, "../.."); config({ path: join(root, "server/.env"), quiet: true } as any);
const dir = mkdtempSync(join(tmpdir(), "tp-approved-real-")); process.env.TP_DATA_DIR = join(dir, "data");
process.env.TP_PROCESSES = "1";
const out = resolve(process.env.TP_EVIDENCE_DIR ?? join(root, `docs/v3/evidence/n-07/real-execution-${Date.now()}`)); mkdirSync(out, { recursive: true });
let count = 0;
const fixture = createServer((req, res) => {
  if (req.url === "/increment" && req.method === "POST") { count++; res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ count })); return; }
  if (req.url === "/state") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ count })); return; }
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(`<!doctype html><html lang="en"><title>Approved workflow fixture</title><body style="font:24px system-ui;padding:72px"><h1>Counter</h1><p id="count">Count: ${count}</p><button style="font:24px system-ui;padding:24px" onclick="fetch('/increment',{method:'POST'}).then(r=>r.json()).then(s=>document.getElementById('count').textContent='Count: '+s.count)">Increment once</button></body></html>`);
});
fixture.listen(0, "127.0.0.1"); await once(fixture, "listening");
const url = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}`;
const db = await import("../src/db.js"), service = await import("../src/runService.js"), stages = await import("../src/runStages.js"), approvals = await import("../src/approvedRuns.js");
const procs = await import("../src/procs.js"), execution = await import("../src/workflowExecution.js");
const project = db.createProject("Synthetic approval integration fixture", url);
const registered = service.registerHostRun(project.id, { runtime: "codex", externalId: "fixture", idempotencyKey: "fixture", materials: [{ name: "counter.md", text: "Counter starts at 0. Clicking Increment once changes count to 1. GET /state returns count. Test one boundary from zero." }] });
const runId = registered.runId;
let passed = false, failure: string | undefined;
try {
  stages.loadRunInstructions(runId, project.id);
  const ref = stages.retrieveRunSpec(runId, project.id, { query: "Increment", budgetTokens: 2000 }).chunks[0].id;
  const stories = [{ id: "s1", title: "Count clicks", role: "visitor", benefit: "track one click", acceptance: ["Given count 0, when Increment once is clicked, then count is 1"] }];
  stages.writeRunStage(runId, project.id, "stories", { stories });
  stages.writeRunStage(runId, project.id, "cases", { stories, cases: [{ id: "c1", storyId: "s1", title: "First click from zero", designMethod: "boundary", key: "zero-one", priority: "P0",
    steps: ['Click the "Increment once" button'], expected: "Counter API equals 1", tier: 1, sourceRefs: [ref],
    oracle: { kind: "api", url: `${url}/state`, method: "GET", path: "count", op: "eq", value: 1, settleMs: 0 } }] });
  stages.gateRun(runId, project.id); stages.finalizeRun(runId, project.id);
  const reviewed = approvals.reviewRevisions(runId, project.id);
  approvals.decideRevisions(runId, project.id, { items: reviewed.map(c => ({ caseId: c.caseId, revisionId: c.revision.id, decision: "approved" })) }, { kind: "human", id: "SYNTHETIC_TEST_FIXTURE_NOT_USER_REVIEW" });
  const code = approvals.generateApprovedCode(runId, project.id);
  if (code.status !== "ready_to_execute") throw new Error("code_gate_blocked");
  await procs.startProcesses(() => {});
  const start = execution.startWorkflowExecution(runId, project.id, { codeRevision: code.revision.id, idempotencyKey: "first-execution" });
  const deadline = Date.now() + 120_000;
  let row: any;
  while (Date.now() < deadline) {
    row = execution.listWorkflowExecutions(runId, project.id).find((r: any) => r.id === start.executionId);
    if (row?.status !== "running") break;
    await new Promise(r => setTimeout(r, 200));
  }
  passed = row?.status === "passed" && count === 1;
  if (!passed) failure = row?.status ?? "execution_timeout";
} catch (error) { failure = error instanceof Error ? error.message.slice(0, 300) : "integration_failed"; }
finally {
  if (!passed) await execution.cancelWorkflowExecutions(runId, project.id);
  await procs.supervisor.stopAll(); fixture.closeAllConnections(); await new Promise<void>(r => fixture.close(() => r()));
  const run = service.runLedger().getRun(runId, project.id);
  const report = { passed, failure, fixtureCount: count, scope: "synthetic reviewer + actual g2 compiler + actual runner/Midscene + deterministic API oracle",
    humanReviewEvidence: false, nativePlanningEvidence: false, run, executions: execution.listWorkflowExecutions(runId, project.id),
    artifacts: run.revisions.map(r => service.runLedger().readRevision(r.id, project.id)) };
  writeFileSync(join(out, "result.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed, failure, fixtureCount: count, evidence: join(out, "result.json") }));
  service.runLedger().close(); db.db.close();
}
process.exit(passed ? 0 : 1);
