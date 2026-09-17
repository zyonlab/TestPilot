import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 2026-09-16 初步交付：Web 发起的运行可以由本机 Claude Code 规划，不再非 Penguin 不可。
 *
 * 钉三件事：
 * - 创建时定下规划运行时并记进运行——绑定是「身份未知的宿主规划 + 项目的执行模型」；
 * - 首跑和续跑交给同一个运行时（续跑不能换人，模型绑定对不上）；
 * - 本机起不来的运行时在创建时就拒，而不是探索跑完才失败。
 */
const startWebRun = vi.fn(async (input: Record<string, unknown>) => ({ wfRunId: input.wfRunId }));
vi.mock("../src/penguinRun.js", () => ({ startRun: startWebRun, cancelRun: vi.fn() }));

let dir: string, projectId: string;
let db: typeof import("../src/db.js"), service: typeof import("../src/runService.js"), ops: typeof import("../src/workflowOps.js");
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "tp-web-claude-")); vi.stubEnv("TP_DATA_DIR", dir);
  vi.stubEnv("MIDSCENE_MODEL_NAME", "fixture-executor"); vi.stubEnv("MIDSCENE_MODEL_BASE_URL", "https://executor.test/v1"); vi.stubEnv("MIDSCENE_MODEL_API_KEY", "fixture-key");
  // 用 node 冒充 claude：`node --version` 退出码 0，足以回答「起得来吗」，而不会真的起一个会话。
  vi.stubEnv("TP_CLAUDE_BIN", process.execPath);
  db = await import("../src/db.js"); service = await import("../src/runService.js"); ops = await import("../src/workflowOps.js");
  projectId = db.createProject("Web Claude planner", "http://127.0.0.1:9879").id;
});
afterAll(() => { service.runLedger().close(); db.db.close(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

const spec = (key: string, extra: Record<string, unknown> = {}) => ({ idempotencyKey: key, sourceKind: "spec" as const,
  materials: [{ name: "requirements.md", text: "# 需求\n\n## 列表\n用户能新建任务。\n" }], ...extra });

describe("Web 发起、Claude Code 规划", () => {
  it("创建时记下规划运行时，绑定是身份未知的宿主规划；首跑交给 Claude Code", async () => {
    const { wfRunId } = await ops.createWebWorkflow(projectId, spec("claude-first", { planner: "claude-code" }));
    const run = service.runLedger().requireRun(wfRunId, projectId);
    expect(run.binding.models).toMatchObject({ entry: "host", runtime: "claude-code", planner: { source: "host", identityEvidence: "unknown", model: null } });
    expect(run.input.parameters).toMatchObject({ plannerRuntime: "claude-code", launchedBy: "web" });
    await vi.waitFor(() => expect(startWebRun.mock.calls.some(([i]) => i.wfRunId === wfRunId)).toBe(true));
    expect(startWebRun.mock.calls.find(([i]) => i.wfRunId === wfRunId)![0]).toMatchObject({ runtime: "claude-code", generationMode: "skill" });
  });

  it("不指定时用服务端默认：TP_AGENT_RUNTIME 不设就是 Claude Code", async () => {
    const { wfRunId } = await ops.createWebWorkflow(projectId, spec("claude-default"));
    expect(service.runLedger().requireRun(wfRunId, projectId).binding.models.runtime).toBe("claude-code");
  });

  it("续跑交给同一个运行时", async () => {
    const { wfRunId } = await ops.createWebWorkflow(projectId, spec("claude-resume", { planner: "claude-code" }));
    await vi.waitFor(() => expect(startWebRun.mock.calls.some(([i]) => i.wfRunId === wfRunId)).toBe(true));
    service.runLedger().db.prepare("UPDATE wf_runs SET status='paused' WHERE id=?").run(wfRunId);
    const before = startWebRun.mock.calls.filter(([i]) => i.wfRunId === wfRunId).length;
    await ops.resumeProjectWorkflow(wfRunId, projectId);
    await vi.waitFor(() => expect(startWebRun.mock.calls.filter(([i]) => i.wfRunId === wfRunId).length).toBe(before + 1));
    expect(startWebRun.mock.calls.filter(([i]) => i.wfRunId === wfRunId).at(-1)![0]).toMatchObject({ runtime: "claude-code" });
  });

  it("本机起不来的规划运行时在创建时就拒，不留半截运行", async () => {
    vi.stubEnv("TP_CLAUDE_BIN", join(dir, "no-such-claude"));
    await expect(ops.createWebWorkflow(projectId, spec("claude-missing", { planner: "claude-code" }))).rejects.toThrow(/planner_runtime_unavailable:claude-code/);
    vi.stubEnv("TP_CLAUDE_BIN", process.execPath);
    // 同一个幂等键修好之后还能创建：被拒的那次没有占住它。
    await expect(ops.createWebWorkflow(projectId, spec("claude-missing", { planner: "claude-code" }))).resolves.toMatchObject({ created: true });
  });
});
