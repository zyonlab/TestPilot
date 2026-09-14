import { afterAll, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { node24Path, penguinBin, REPO_ROOT } from "../src/penguin.js";
import { launchManagedPenguin, managedRunState, cancelManagedRun, type ManagedPenguinInput } from "../src/runtime/managed-penguin.js";
// This SDK transport fixture has no registered workflow. Ledger persistence is
// covered by role-spend/workflow-execution tests; retain the actual IPC callback.
vi.mock('../src/roleSpend.js', () => ({ recordModelRequests: vi.fn() }));

const dirs: string[] = [], servers: Server[] = [];
const running: string[] = [];
afterAll(async () => {
  running.forEach(cancelManagedRun);
  await Promise.all(servers.map(s => new Promise<void>(r => { s.close(() => r()); s.closeAllConnections(); })));
  dirs.forEach(d => rmSync(d, { recursive: true, force: true }));
});

const installed = existsSync(node24Path()) && existsSync(penguinBin());
function allText(dir: string): string {
  return readdirSync(dir, { withFileTypes: true }).map(e => e.isDirectory() ? allText(join(dir, e.name)) : readFileSync(join(dir, e.name)).toString()).join("\n");
}
async function setup(runId: string, hold = false, invokePipeline = false) {
  const dir = mkdtempSync(join(tmpdir(), "tp-managed-")); dirs.push(dir);
  const workspace = join(dir, "workspace"), outDir = join(workspace, "runs", runId); mkdirSync(outDir, { recursive: true });
  const materialsDir = join(workspace, "materials"); mkdirSync(materialsDir);
  writeFileSync(join(materialsDir, "fixture.md"), "# Counter\nClick Increment once to increase count from 0 to 1.");
  const requests: Array<{ key?: string; body: Record<string, unknown> }> = [];
  const server = createServer(async (req, res) => {
    const parts: Buffer[] = []; for await (const part of req) parts.push(Buffer.from(part));
    const body = JSON.parse(Buffer.concat(parts).toString()); requests.push({ key: req.headers.authorization, body });
    if (hold) return;
    res.setHeader("content-type", "text/event-stream");
    if (invokePipeline && requests.length === 1) {
      const tool = (body.tools as Array<{ function: { name: string } }>).find(t => t.function.name.endsWith("run_pipeline"));
      const args = { stage: "g1", materialsDir, outDir, stopAfter: "docs" };
      res.write(`data: ${JSON.stringify({ id: "mock-call", object: "chat.completion.chunk", model: "managed-planner", choices: [{ index: 0, delta: {
        role: "assistant", tool_calls: [{ index: 0, id: "call-pipeline", type: "function", function: { name: tool?.function.name ?? "missing_pipeline_tool", arguments: JSON.stringify(args) } }],
      }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: "mock-call", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`);
      res.end("data: [DONE]\n\n"); return;
    }
    res.write(`data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", model: "managed-planner", choices: [{ index: 0, delta: { role: "assistant", content: "ready" }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  servers.push(server); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const role = (r: "planner" | "executor") => ({ source: "configured" as const, role: r, profileId: r, profileVersion: 1, scope: "project" as const, provider: "test", endpoint, model: `managed-${r}`, thinking: false });
  const input: ManagedPenguinInput = { runId, workspace, outDir, root: join(dir, "penguin"), projectId: "test-project", agentId: "testpilot", nodeBin: node24Path(), penguinBin: penguinBin(), message: "Reply with ready. Do not call any tools.",
    mcpEnv: { TP_REPO_ROOT: REPO_ROOT, TP_RUNTIME: "penguin", TP_RUNS_DIR: join(workspace, "runs") },
    models: { binding: { schemaVersion: 1, entry: "web", mode: "pipeline", runtime: "penguin", planner: role("planner"), executor: role("executor") },
      planner: { role: "planner", endpoint, model: "managed-planner", apiKey: "private-planner-credential", thinking: false },
      executor: { role: "executor", endpoint, model: "managed-executor", apiKey: "private-executor-credential", thinking: false } },
  };
  running.push(runId); return { input, requests, dir };
}

it.runIf(installed)("uses the installed Penguin SDK with captured credentials and no secret persistence", async () => {
  const { input, requests, dir } = await setup("managed-success");
  const started = await launchManagedPenguin(input);
  expect(started.sessionId).toMatch(/session/);
  await vi.waitFor(() => expect(managedRunState(input.runId)).toBe("idle"), { timeout: 30_000, interval: 100 });
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.every(r => r.key === "Bearer private-planner-credential" && r.body.model === "managed-planner")).toBe(true);
  expect(requests[0].body.enable_thinking).toBe(false);
  const files = allText(dir);
  expect(files).not.toContain("private-planner-credential"); expect(files).not.toContain("private-executor-credential");
  expect(JSON.parse(readFileSync(join(input.outDir, "model-binding.json"), "utf8"))).toEqual(input.models.binding);
  const records = readFileSync(join(input.outDir, "model-requests.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(records.every(r => r.endpoint === input.models.planner.endpoint && r.role === "planner")).toBe(true);
}, 45_000);

it.runIf(installed)("cancels an active managed SDK request and exits its worker", async () => {
  const { input, requests } = await setup("managed-cancel", true);
  await launchManagedPenguin(input);
  await vi.waitFor(() => expect(requests.length).toBeGreaterThan(0), { timeout: 30_000, interval: 100 });
  expect(cancelManagedRun(input.runId)).toBe(true);
  await vi.waitFor(() => expect(managedRunState(input.runId)).toBe("gone"), { timeout: 10_000, interval: 100 });
  expect(cancelManagedRun(input.runId)).toBe(false);
}, 45_000);

it.runIf(installed)("rejects misleading public binding before starting any model request", async () => {
  const { input, requests } = await setup("managed-invalid");
  input.models.planner.model = "a-different-model";
  await expect(launchManagedPenguin(input)).rejects.toThrow("managed_model_binding_conflict");
  expect(requests).toHaveLength(0);
  expect(managedRunState(input.runId)).toBeUndefined();
});

it.runIf(installed)("carries the same run ID and public model snapshot through the actual MCP pipeline", async () => {
  const { input, requests } = await setup("managed-pipeline", false, true);
  await launchManagedPenguin(input);
  await vi.waitFor(() => expect(managedRunState(input.runId)).toBe("idle"), { timeout: 30_000, interval: 100 });
  const meta = JSON.parse(readFileSync(join(input.outDir, "meta.json"), "utf8"));
  expect(meta.runId).toBe(input.runId);
  expect(meta.modelRoles).toEqual(input.models.binding);
  expect(meta.model.baseUrl).toBe(input.models.planner.endpoint);
  expect(meta.spend.calls).toBe(0); // docs reads the local fixture; no generation request.
  expect(requests).toHaveLength(2); // SDK tool dispatch followed by the final response.
}, 45_000);
