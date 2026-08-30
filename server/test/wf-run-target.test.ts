import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * 重跑一个节点，不许把这次运行的目标地址擦掉。
 *
 * `startRun` 里写着「Re-running one node of an existing run must use that run's target,
 * not today's default」，而接口层用 `body.target ?? { projectId: body.projectId, ... }`
 * 把它废掉了——**那个兜底对象永远为真**，哪怕三个字段全是 undefined。
 *
 * 实测后果：重跑 `wf-mtd7gcdk` 的一个节点，目标被静默擦成 `{}`，三条用例在 12 毫秒内
 * 以 infra 失败，`record()` 因为没有 projectId 直接返回，一条执行记录都没写——
 * 而运行状态是 `done`。**一次什么都没跑的运行，报告说它成功了。**
 * 存量数据也被改坏了（那次运行原来的 target 没了，只能从兄弟运行里抄回来）。
 */

const seen: Array<Record<string, unknown>> = [];
vi.mock("../src/graphs.js", () => ({
  startRun: async (input: Record<string, unknown>) => {
    seen.push(input);
    return { wfRunId: "wf-x", graph: {}, target: {} };
  },
}));

/** 接口层那一行的逻辑，抽出来单独钉住——它太容易在重构里被写回原样。 */
const targetFrom = (body: {
  target?: unknown;
  projectId?: string;
  envRef?: string;
  url?: string;
}): unknown =>
  body.target ??
  (body.projectId || body.envRef || body.url
    ? { projectId: body.projectId, envRef: body.envRef, url: body.url }
    : undefined);

beforeEach(() => {
  seen.length = 0;
});

describe("POST /api/wf/runs 的目标解析", () => {
  it("请求什么都没说时**不造** target——让 startRun 沿用这次运行原来的", () => {
    expect(targetFrom({ })).toBeUndefined();
    expect(targetFrom({ target: undefined })).toBeUndefined();
  });

  it("请求真的说了才拼", () => {
    expect(targetFrom({ url: "http://x.invalid" })).toEqual({
      projectId: undefined,
      envRef: undefined,
      url: "http://x.invalid",
    });
    expect(targetFrom({ projectId: "p1" })).toMatchObject({ projectId: "p1" });
  });

  it("显式传 target 时原样用", () => {
    const t = { projectId: "p1", url: "http://y.invalid" };
    expect(targetFrom({ target: t })).toBe(t);
  });

  it("显式传一个空 target 也照收——那是「我就是要清空」，和「没说」不是一回事", () => {
    expect(targetFrom({ target: {} })).toEqual({});
  });
});
