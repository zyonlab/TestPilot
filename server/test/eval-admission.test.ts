import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const graph = vi.hoisted(() => ({ start: vi.fn(), get: vi.fn(), output: vi.fn(), cancel: vi.fn(), definition: vi.fn() }));
vi.mock("../src/graphs.js", () => ({ startRun: graph.start, outputStore: { getRun: graph.get }, nodeOutput: graph.output,
  getGraph: graph.definition, getGraphVersion: graph.definition, cancelRun: graph.cancel, allOutputs: vi.fn(), runPromptDigest: vi.fn() }));
vi.mock("../src/procs.js", () => ({ bus: { publish: vi.fn() } }));
let root: string, goldPath: string, api: typeof import("../src/evals.js");
let n = 0;
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "tp-eval-admission-")); vi.stubEnv("TP_DATA_DIR", root); goldPath = join(root, "gold.json");
  writeFileSync(goldPath, JSON.stringify({ id: "synthetic", items: [
    { id: "dev", title: "Increment", match: { anyOf: ["increment"] } },
    { id: "hidden", title: "PRIVATE_SYNTHETIC_TITLE", heldOut: true, match: { anyOf: ["private"] } },
  ] }));
  api = await import("../src/evals.js");
});
beforeEach(() => {
  graph.start.mockReset().mockImplementation(async () => ({ wfRunId: `synthetic-${++n}`, graph: { version: 1 } }));
  graph.get.mockReset().mockReturnValue({ status: "done", detail: {} });
  graph.output.mockReset().mockResolvedValue({ cases: [{ title: "Increment", steps: ["Click"], expected: "1" }] });
  graph.definition.mockReset().mockReturnValue({ version: 1, nodes: [{ id: "gate" }] });
  graph.cancel.mockReset().mockResolvedValue({ result: "requested" });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
afterAll(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
const req = () => ({ graphId: "synthetic", goldPath, a: { label: "A" }, b: { label: "B", params: { gate: { minNegativeRatio: 0.5 } } } });
it("rejects unsupported runtimes synchronously, before any model work or success acknowledgment", () => {
  expect(() => api.startPairedEval({ ...req(), b: { label: "B", runtime: "claude-code" } })).toThrow("eval_runtime_unsupported");
  expect(graph.start).not.toHaveBeenCalled();
});
it("reports all admission issues and never falls back to another dataset", () => {
  graph.definition.mockReturnValue(undefined);
  expect(api.preflightPairedEval({ ...req(), goldPath: join(root, "missing"), a: { label: "A", runtime: "codex" } }).issues)
    .toEqual(expect.arrayContaining(["eval_runtime_unsupported", "eval_graph_missing", "eval_gold_unavailable"]));
  expect(() => api.startPairedEval({ ...req(), goldPath: undefined })).toThrow("eval_request_invalid");
});
it("gives a stable ID before work finishes and persists a development-only diagnostic", async () => {
  const ticket = api.startPairedEval(req());
  expect(ticket.status).toBe("running");
  await vi.waitFor(() => expect(api.getEval(ticket.id)?.validity).toBe("valid"));
  const result = api.getEval(ticket.id)!;
  expect(result.classification).toBe("diagnostic");
  expect(result.costDelta).toBeNull();
  expect(JSON.stringify(result)).not.toContain("PRIVATE_SYNTHETIC_TITLE");
  expect(JSON.stringify(result)).not.toContain('"hidden"');
  expect(api.listEvals().find(r => r.id === ticket.id)?.status).toBe("done");
});
it("persists invalid failure without starting a second arm or producing zero scores", async () => {
  graph.get.mockReturnValue({ status: "failed" });
  const ticket = api.startPairedEval(req());
  await vi.waitFor(() => expect(api.getEval(ticket.id)?.error).toBe("eval_run_not_completed"));
  expect(api.listEvals().find(r => r.id === ticket.id)?.status).toBe("invalid");
  expect(api.getEval(ticket.id)?.a).toBeUndefined();
  expect(graph.start).toHaveBeenCalledTimes(1);
});
it("distinguishes a missing artifact from a valid empty case set", async () => {
  graph.output.mockResolvedValueOnce(undefined);
  await expect(api.runPairedEval(req())).rejects.toThrow("eval_output_missing");
  graph.output.mockResolvedValue({ cases: [] });
  const result = await api.runPairedEval(req());
  expect(result.a.coverage).toBe(0);
  expect(result.validity).toBe("valid");
});
it("times out and requests cancellation rather than polling forever", async () => {
  vi.useFakeTimers(); graph.get.mockReturnValue({ status: "running" });
  const failure = api.runPairedEval({ ...req(), timeoutMs: 1000 }).catch(e => e.message);
  await vi.advanceTimersByTimeAsync(1001);
  expect(await failure).toBe("eval_timeout");
  expect(graph.cancel).toHaveBeenCalledTimes(1);
});
it("invalidates prompt drift between arms", async () => {
  graph.get.mockReturnValueOnce({ status: "done", detail: { prompts: { combined: "a", entries: [] } } })
    .mockReturnValueOnce({ status: "done", detail: { prompts: { combined: "b", entries: [] } } });
  await expect(api.runPairedEval(req())).rejects.toThrow("eval_prompt_drift");
});
it("does not credit a mutation when its healthy control could not run", async () => {
  graph.output.mockResolvedValue({ code: [{ caseId: "c1", title: "case", actions: [], uses: [] }] });
  vi.stubGlobal("fetch", async (url: string) => new Response(url.includes("defect=") ? "broken" : "healthy"));
  const execute = vi.fn(async () => ({ status: "failed", failKind: "infra" })); api.setCaseExecutor(execute);
  const result = await api.runDetectionEval({ wfRunId: "synthetic", target: { url: "http://synthetic.invalid" }, defects: ["injected"] });
  expect(result.mutationScore).toBeNull(); expect(result.falseAlarmRate).toBeNull();
  expect(result.validity).toBe("unobservable"); expect(execute).toHaveBeenCalledTimes(1);
});
