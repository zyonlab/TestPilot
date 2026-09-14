import { afterEach, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EventBus, EventKind, MemoryEventStore, Supervisor, type Envelope } from "@testpilot/harness-core";
import type { DebugSpec, ExecResult, ExecSpec } from "../src/exec.js";
import type { RoleModelConnection } from "@testpilot/harness-core/model-profiles";

// No steps/assertions means this deliberately unreachable model must never be called.
const executorModel: RoleModelConnection = { role: "executor", model: "unused-vision", endpoint: "http://127.0.0.1:1/v1", apiKey: "test-only", thinking: false };

// End-to-end across the process boundary, WITHOUT the vision model: a case with no steps
// and no assertion still exercises everything this migration is about — launch, screenshot
// capture, perf capture, artifact write, RPC round-trip. Model calls only happen for
// steps/assertions, so this stays fast enough to run on every commit.

const ENTRY = fileURLToPath(new URL("../src/main.ts", import.meta.url));

let sup: Supervisor | undefined;
let site: Server | undefined;
let artifactDir: string | undefined;

afterEach(async () => {
  await sup?.stopAll();
  sup = undefined;
  site?.close();
  site = undefined;
  if (artifactDir) rmSync(artifactDir, { recursive: true, force: true });
  artifactDir = undefined;
});

function servePage(html: string): Promise<string> {
  site = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(html);
  });
  return new Promise((resolve) =>
    site!.listen(0, () => resolve(`http://127.0.0.1:${(site!.address() as AddressInfo).port}/`)),
  );
}

interface RunnerApi {
  exec(spec: ExecSpec): Promise<ExecResult>;
}
interface DebugApi {
  debug(spec: DebugSpec): Promise<void>;
  cancel(execId: string): Promise<boolean>;
}

it("captures a screenshot and perf metrics inside the runner process", async () => {
  const url = await servePage("<h1 style='background:#0af'>TestPilot</h1>");
  artifactDir = mkdtempSync(join(tmpdir(), "tp-artifacts-"));

  const events: Envelope[] = [];
  const bus = new EventBus(new MemoryEventStore(), { coalesceMs: 0 });
  bus.subscribe((e) => events.push(e));
  sup = new Supervisor(bus);
  sup.register({
    id: "runner-1",
    kind: "node",
    entry: ENTRY,
    execArgv: ["--import", "tsx"],
    restart: "never",
    heartbeatMs: 1000,
    readyTimeoutMs: 30_000,
  });
  await sup.start("runner-1");

  const result = await sup.rpc<RunnerApi>("runner-1")!.exec({
    execId: "exec-test",
    url,
    steps: [],
    expected: "",
    artifactDir,
    opts: { executorModel },
  });

  expect(result.status).toBe("passed");
  // One shot is taken right after navigation, before any step runs.
  expect(result.pngPaths).toHaveLength(1);
  expect(readFileSync(result.pngPaths[0]).subarray(1, 4).toString()).toBe("PNG");
  // Perf comes from the real navigation timings of the page under test.
  expect(Object.keys(result.perfMetrics).length).toBeGreaterThan(0);
  expect(result.perfMetrics.loadMs).toBeGreaterThanOrEqual(0);
  expect(result.oracle).toEqual([]);

  // The run reports progress on the bus, so the UI sees a live run without polling.
  const phases = events
    .filter((e) => e.kind === EventKind.runProgress)
    .map((e) => (e.payload as { phase: string }).phase);
  expect(phases).toEqual(["start", "done"]);
}, 120_000);

it("streams a debug session's frames over the bus and cleans up after it", async () => {
  const url = await servePage("<h1>debug</h1>");
  artifactDir = mkdtempSync(join(tmpdir(), "tp-artifacts-"));

  const frames: Array<Record<string, unknown>> = [];
  const bus = new EventBus(new MemoryEventStore(), { coalesceMs: 0 });
  bus.subscribe((e) => {
    if (e.kind === "session.progress") frames.push(e.payload as Record<string, unknown>);
  });
  sup = new Supervisor(bus);
  sup.register({
    id: "runner-1",
    kind: "node",
    entry: ENTRY,
    execArgv: ["--import", "tsx"],
    restart: "never",
    heartbeatMs: 1000,
    readyTimeoutMs: 30_000,
  });
  await sup.start("runner-1");

  // An empty plan with no assertion exercises the whole streaming path without a single
  // model call: launch, navigate, frame out, done.
  await sup.rpc<DebugApi>("runner-1")!.debug({
    execId: "dbg-test",
    url,
    artifactDir,
    plan: [],
    expected: "",
    resolve: { env: {}, secrets: {} },
    launch: { executorModel },
  });

  expect(frames.map((f) => f.type)).toEqual(["start", "navigated", "done"]);
  expect(frames.at(-1)).toMatchObject({ status: "passed" });
  // Screenshots cross as file refs, never as inline bytes — lineage would drown in base64.
  const navigated = frames[1] as { shotRef?: string };
  expect(navigated.shotRef).toMatch(/dbg-test-\d+\.jpg$/);
  expect(readFileSync(navigated.shotRef!).length).toBeGreaterThan(0);

  // Cancelling something that already finished is a no-op, not an error.
  expect(await sup.rpc<DebugApi>("runner-1")!.cancel("dbg-test")).toBe(false);
}, 120_000);

it("cancels a normal execution while page navigation is pending and closes the browser", async () => {
  let received!: () => void; const requested = new Promise<void>(r => { received = r; });
  site = createServer(() => { received(); });
  await new Promise<void>(r => site!.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  artifactDir = mkdtempSync(join(tmpdir(), "tp-cancel-"));
  sup = new Supervisor(new EventBus(new MemoryEventStore(), { coalesceMs: 0 }));
  sup.register({ id: "runner-1", kind: "node", entry: ENTRY, execArgv: ["--import", "tsx"], restart: "never", readyTimeoutMs: 30_000 });
  await sup.start("runner-1");
  const rpc = sup.rpc<RunnerApi & DebugApi>("runner-1")!;
  const pending = rpc.exec({ execId: "cancel-navigate", url, steps: [], expected: "", artifactDir, opts: { executorModel } });
  await requested; expect(await rpc.cancel("cancel-navigate")).toBe(true);
  const result = await pending;
  expect(result.status).toBe("failed"); expect(result.infraError).toBe(true); expect(result.failureReason).toBe("EXEC_CANCELLED");
  expect(await rpc.cancel("cancel-navigate")).toBe(false);
}, 45_000);
