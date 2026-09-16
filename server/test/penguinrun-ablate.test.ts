import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
vi.mock("../src/modelSnapshots.js", () => import("./helpers/model-snapshot.js"));
vi.mock("../src/graphs.js", () => ({ nodeOutput: vi.fn(), outputStore: { saveRun: vi.fn(), getRun: vi.fn() } }));
vi.mock("../src/procs.js", () => ({ bus: { publish: vi.fn() } }));

/**
 * 07 T-12：`/api/wf/runs` 带的 `ablate` 必须交到运行时的 `startRun` 手上（它再写进 MCP env）。
 * 2026-09-08 三遍「消融臂」meta 里 `ablated: []`，其中一遍的根因就是这里只把 ablate 记进了运行记录、没往下传。
 */
vi.mock("../src/runtimes.js", () => {
  const startRun = vi.fn(async (input: Record<string, unknown>) => ({ sessionId: "s", workspace: "/tmp/ws", runId: String(input.runId), outDir: "/tmp/ws/runs/x" }));
  return {
    getRuntime: (name: string) => ({ name, startRun, watchRun: vi.fn(), readRun: vi.fn(), writeDecisions: vi.fn() }),
    defaultRuntimeName: () => "penguin",
    isRuntimeName: (x: string) => x === "claude-code" || x === "penguin",
    __startRun: startRun,
  };
});

describe("penguinRun.startRun 把 ablate 交给运行时", () => {
  it("body.ablate → rt.startRun({ ablate })", async () => {
    const rt = await import("../src/runtimes.js");
    const { startRun } = await import("../src/penguinRun.js");
    await startRun({ runtime: "penguin", materialsDir: "/tmp/m", limit: 1, ablate: ["domain-reference"], workspace: "/tmp/ws" } as never);
    const call = (rt as unknown as { __startRun: { mock: { calls: unknown[][] } } }).__startRun.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(call?.ablate).toEqual(["domain-reference"]);
  });
  it("Web 发起的 Claude Code 运行不带托管规划模型、工作区按运行分开；Codex 仍拒绝", async () => {
    const rt = await import("../src/runtimes.js");
    const { startRun } = await import("../src/penguinRun.js");
    const calls = (rt as unknown as { __startRun: { mock: { calls: unknown[][] } } }).__startRun.mock.calls;
    const before = calls.length;
    await startRun({ runtime: "claude-code", materialsDir: "/tmp/m", wfRunId: "run-web-claude" } as never);
    const call = calls[before]?.[0] as Record<string, unknown> | undefined;
    expect(call?.models).toBeUndefined();
    expect(String(call?.workspace)).toMatch(/host-workspaces[\\/]run-web-claude$/);
    await expect(startRun({ runtime: "codex", workspace: "/tmp/ws" } as never)).rejects.toThrow("managed_planner_unsupported (codex)");
  });
});

/**
 * 续跑的话术必须和首跑说同一件事（docs/v3/history/24 §28）。
 *
 * 2026-09-12 实测：开了工作单元的运行，一「继续运行」就被指使去调
 * `write_stories` / `write_cases`——而那两个工具在单元模式下必然被拒
 * （`stage_requires_units`），单元循环那套说明整段丢失。
 * 表现成「节点调整之后运行就失败」。
 */
describe("续跑的话术", () => {
  it("开了单元的运行，续跑时仍然给单元循环，并且不叫它去写整份", async () => {
    const rt = await import("../src/runtimes.js");
    const { startRun } = await import("../src/penguinRun.js");
    (rt as unknown as { __startRun: { mock: { calls: unknown[][] } } }).__startRun.mock.calls.length = 0;
    await startRun({ runtime: "penguin", materialsDir: "/tmp/m", workspace: "/tmp/ws",
      resumeStage: "stories", params: { workUnits: 1 } } as never);
    const call = (rt as unknown as { __startRun: { mock: { calls: unknown[][] } } }).__startRun.mock.calls[0]?.[0] as { message?: string } | undefined;
    const msg = String(call?.message ?? "");
    expect(msg).toContain("claim_unit");
    expect(msg).toContain("write_unit");
    expect(msg).toContain("Continue registered TestPilot run");
    // 「用整份写入」那句话只能出现在没开单元的运行里。
    expect(msg).not.toContain("complete only missing stages with write_stories");
  });
});

/**
 * 预算按「真正会拆出多少单元」给（docs/v3/history/24 §31）。
 *
 * 2026-09-12：故事扇出调对之后用例单元从 4 个变成 56 个，而预算还是按老口径
 * （主模块数 + 1 + 功能数）估的 324 次调用——规划器写到一半被自己的预算掐断，
 * 整次运行 failed，56 条故事白写。预算在起跑那一刻就交给 worker 开代理，事后改没用。
 */
describe("单元数的估法", () => {
  it("用例单元是一条故事一个，所以估的是故事数下限，不是功能数", async () => {
    const { estimateUnitCount } = await import("../src/penguinRun.js");
    const service = await import("../src/runService.js");
    const db = await import("../src/db.js");
    const projectId = db.createProject(`budget-${Date.now()}`, "http://localhost").id;
    const profiles = await import("../src/modelProfiles.js");
    for (const role of ["planner", "executor"] as const)
      profiles.saveProjectModelProfile(projectId, role, { expectedVersion: 0, provider: "test", model: "m",
        endpoint: "https://x.test/v1", apiKey: "k", thinking: false, capabilities: { vision: "unknown", toolUse: "unknown" } });
    const key = `budget-${Date.now()}`;
    const { runId } = service.registerHostRun(projectId, { runtime: "codex", externalId: key, idempotencyKey: key,
      materials: [{ name: "m.md", text: "# 材料\n\n## 一段\n内容\n" }], parameters: { workUnits: 1 } });
    // 三个叶子：一个挂 4 个功能，两个各挂 1 个 → 故事下限 4 + 2 + 2 = 8，而功能数只有 6。
    service.runLedger().putRevision({ runId, projectId, name: "product/model-candidate", kind: "report", content: {
      modules: [{ id: "a", parentId: null }, { id: "a.1", parentId: "a" }, { id: "a.2", parentId: "a" }, { id: "b", parentId: null }, { id: "b.1", parentId: "b" }],
      features: [{ moduleId: "a.1" }, { moduleId: "a.1" }, { moduleId: "a.1" }, { moduleId: "a.1" }, { moduleId: "a.2" }, { moduleId: "b.1" }],
    } }, { kind: "system", id: "test" });
    // 2 个根 + 1 个旅程 + 8 条故事 = 11（老口径：2 + 1 + 6 个功能 = 9）。
    expect(estimateUnitCount(runId, projectId)).toBe(11);
  });
});
