vi.mock("../src/runService.js", () => ({ registerWebRun: () => undefined, freezeGraphSources: () => undefined, runLedger: () => ({ registration: () => undefined }) }));
vi.mock("../src/modelSnapshots.js", () => import("./helpers/model-snapshot.js"));
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./../src/model.js", () => ({ model: {}, reconfigureModel: () => {} }));
vi.mock("../src/settings.js", () => ({
  getSettings: () => ({ prompts: { explore: "x" } }),
}));
let project: unknown;
let environment: unknown;
vi.mock("../src/db.js", () => ({
  ARTIFACT_DIR: "/tmp",
  getProject: () => project,
  getSecretValues: () => ({}),
  resolveEnvironment: () => environment,
  listEnvironments: () => (environment ? [environment] : []),
}));

const { startRun, runDetail, listGraphs } = await import("../src/graphs.js");
const GRAPH = listGraphs().find((g) => g.id === "g1-text-cases")!.id;

beforeEach(() => {
  project = undefined;
  environment = undefined;
});

describe("U-48 · 覆盖参数只影响这一次，而且当场校验", () => {
  it("合法覆盖被记进 paramOverrides，图本身版本号不动", async () => {
    const before = listGraphs().find((g) => g.id === GRAPH)!.version;
    const { wfRunId } = await startRun({
      graphId: GRAPH,
      params: { stories: { maxStories: 3 } },
    });
    expect(runDetail(wfRunId).paramOverrides).toEqual({ stories: { maxStories: 3 } });
    expect(listGraphs().find((g) => g.id === GRAPH)!.version).toBe(before);
    // 「带覆盖」这枚标签看的是**人要求的**那一份，不是最终生效的全部——
    // 后者每次都包含项目材料的自动注入，拿它去标，每一条运行都会带上这枚标签。
    expect(runDetail(wfRunId).requestedOverrides).toEqual({ stories: { maxStories: 3 } });
  });

  it("越界的覆盖在起跑那一刻就被拒，不是跑到那一步才报", async () => {
    // maxStories 是个数字；给一个字符串，zod 当场就该拒。此前这条路是：
    // 先跑完前面几步，再在这一步上抛 zod 错误——前面那些模型调用全白花。
    await expect(
      startRun({ graphId: GRAPH, params: { stories: { maxStories: "三条" } } }),
    ).rejects.toThrow(/stories/);
  });

  it("没人动过手的运行不带「覆盖」标记——哪怕项目材料被自动注入了", async () => {
    const { wfRunId } = await startRun({ graphId: GRAPH });
    expect(runDetail(wfRunId).requestedOverrides).toBeUndefined();
  });

  it("覆盖一个不存在的节点，说得出是哪个名字", async () => {
    await expect(startRun({ graphId: GRAPH, params: { nope: { x: 1 } } })).rejects.toThrow(/nope/);
  });
});
