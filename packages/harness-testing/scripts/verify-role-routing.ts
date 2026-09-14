/** Explicit, paid integration smoke; never included in the unit suite. */
import { createServer } from "node:http";
import { once } from "node:events";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, join } from "node:path";
import type { AddressInfo } from "node:net";
import { parse } from "dotenv";
import { plannerConnectionFromEnv, executorConnectionFromEnv, environmentModelProfile, plannerModel, openRoleProxy, type RoleRequestRecord } from "@testpilot/harness-core";
import { resolveRunModels } from "@testpilot/harness-core/model-profiles";
import { executeRun } from "../src/exec/run.js";

if (!process.argv.includes("--real")) throw new Error("Use --real only when actual endpoint execution is authorized");
const root = fileURLToPath(new URL("../../..", import.meta.url));
const env = parse(readFileSync(join(root, "server/.env")));
const out = resolve(root, "docs/v3/evidence/n-03/real-routing"); mkdirSync(out, { recursive: true });
const records: Array<RoleRequestRecord & { at: string }> = [];
const record = (r: RoleRequestRecord) => { records.push({ at: new Date().toISOString(), ...r }); };
const p = plannerConnectionFromEnv(env), e = executorConnectionFromEnv(env);
const binding = resolveRunModels({ entry: "web", mode: "pipeline", runtime: "pipeline", profiles: { environment: {
  planner: environmentModelProfile("planner", env), executor: environmentModelProfile("executor", env),
} } });
const planner = await openRoleProxy(p, record), executor = await openRoleProxy(e, record);
let count = 0;
const fixture = createServer((req, res) => {
  if (req.method === "POST" && req.url === "/increment") { count++; res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ count })); return; }
  if (req.url === "/state") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ count })); return; }
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>TestPilot local fixture</title><body style="font:24px system-ui;padding:72px;background:#fff;color:#111"><h1>Counter test</h1><p id="status">Count: ${count}</p><button style="font:24px system-ui;padding:24px 40px" onclick="fetch('/increment',{method:'POST'}).then(r=>r.json()).then(s=>document.getElementById('status').textContent='Count: '+s.count)">Increment once</button></body></html>`);
});
fixture.listen(0, "127.0.0.1"); await once(fixture, "listening");
const url = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}`;
let result: Record<string, unknown> = { status: "failed", stage: "planner" };
try {
  const plan = await plannerModel(planner.connection).chat({
    stable: 'Return JSON only: {"steps":["one brief UI action"]}. Never invent controls.',
    variable: 'Local page has heading "Counter test", label "Count: 0", and one button "Increment once". Goal: count becomes 1. Plan exactly one click. Do not include assertions or other actions.',
    schema: { type: "object", properties: { steps: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 1 } }, required: ["steps"], additionalProperties: false },
    maxTokens: 160,
  });
  const data = JSON.parse(plan.text.replace(/^```(?:json)?\s*|\s*```$/g, ""));
  if (!Array.isArray(data.steps) || data.steps.length !== 1 || typeof data.steps[0] !== "string" || data.steps[0].length > 300) throw new Error("invalid_fixture_plan");
  result = { status: "failed", stage: "executor", plannerResponseModel: plan.model, plannerTokens: plan.tokens, steps: data.steps };
  const run = await executeRun(url, data.steps, "Counter API equals 1", {
    executorModel: executor.connection, oracle: { kind: "api", url: `${url}/state`, method: "GET", path: "count", op: "eq", value: 1, settleMs: 0 },
  });
  if (run.pngBuffers.at(-1)) writeFileSync(join(out, "after.png"), run.pngBuffers.at(-1)!);
  result = { ...result, status: run.status, stage: "finished", durationMs: run.durationMs, oracle: run.oracle, fixtureCount: count,
    ...(run.failure ? { failureCode: run.failure.code, failureAttribution: run.failure.attribution } : {}) };
} catch { result = { ...result, error: "role_routing_smoke_failed" }; process.exitCode = 1; }
finally {
  await planner.close(); await executor.close();
  await new Promise<void>(done => { fixture.close(() => done()); fixture.closeAllConnections(); });
  const summary = { at: new Date().toISOString(), fixture: "local counter only", binding, ...result, requests: records };
  writeFileSync(join(out, "result.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ status: result.status, stage: result.stage, calls: records.length, report: join(out, "result.json") }));
  if (result.status !== "passed") process.exitCode = 1;
}
