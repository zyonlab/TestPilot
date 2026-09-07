import { describe, it, expect } from "vitest";
import { MemoryEventStore, SqliteEventStore } from "../src/obs/store.js";

/**
 * 一次跑三天的运行会在自己还没跑完的时候被自己产生的日志挤出保留窗口。
 * 失败的样子不是报错——是轨迹变空，而「这次运行到底发生了什么」永远没有了答案。
 */
function fill(store: MemoryEventStore | SqliteEventStore, n: number, runId?: string) {
  for (let i = 0; i < n; i++)
    store.append({
      ts: new Date(1_700_000_000_000 + i).toISOString(),
      kind: "log",
      scope: runId ? { wfRunId: runId } : {},
      payload: { text: `line ${i}` },
    });
}

for (const [name, make] of [
  ["memory", () => new MemoryEventStore()],
  ["sqlite", () => new SqliteEventStore(":memory:")],
] as const) {
  describe(`U-64 · 保留窗口不能吃掉还在跑的运行（${name}）`, () => {
    it("不给保护名单时照常按条数裁", () => {
      const s = make();
      fill(s, 100);
      expect(s.prune(20)).toBe(80);
    });

    it("受保护的运行一行都不删", () => {
      const s = make();
      fill(s, 60, "wf-long"); // 老的，正常会被裁掉
      fill(s, 60); // 新的
      s.prune(20, ["wf-long"]);
      const left = s.since(0, 1000);
      expect(left.filter((e) => (e.scope as { wfRunId?: string }).wfRunId === "wf-long")).toHaveLength(60);
    });

    it("保护一个不存在的运行不会让裁剪失效", () => {
      const s = make();
      fill(s, 100);
      expect(s.prune(20, ["wf-nope"])).toBe(80);
    });
  });
}

/**
 * 血缘和日志挤在同一张表里，而按总条数裁的时候日志赢：
 * 实测 20 万行里 log 占 74.3%、血缘只占 1.47%——而血缘是那次运行的唯一记录。
 */
describe("U-65 · 吵闹的那几类各自一个窗口", () => {
  it("按 kind 裁只动那一类，血缘一行不掉", () => {
    const s = new SqliteEventStore(":memory:");
    for (let i = 0; i < 500; i++)
      s.append({ ts: new Date(1_700_000_000_000 + i).toISOString(), kind: "log", scope: {}, payload: { i } });
    for (let i = 0; i < 20; i++)
      s.append({
        ts: new Date(1_700_000_001_000 + i).toISOString(),
        kind: "wf.node.finished",
        scope: { wfRunId: "wf-a" },
        payload: { i },
      });
    const removed = s.pruneKind("log", 50);
    expect(removed).toBe(450);
    const left = s.since(0, 1000);
    expect(left.filter((e) => e.kind === "wf.node.finished")).toHaveLength(20);
    expect(left.filter((e) => e.kind === "log")).toHaveLength(50);
  });

  it("按 kind 裁也认保护名单——正在跑的那次运行的日志不删", () => {
    const s = new SqliteEventStore(":memory:");
    for (let i = 0; i < 100; i++)
      s.append({ ts: new Date().toISOString(), kind: "log", scope: { wfRunId: "wf-live" }, payload: { i } });
    for (let i = 0; i < 100; i++)
      s.append({ ts: new Date().toISOString(), kind: "log", scope: {}, payload: { i } });
    s.pruneKind("log", 10, ["wf-live"]);
    const left = s.since(0, 1000);
    expect(left.filter((e) => (e.scope as { wfRunId?: string }).wfRunId === "wf-live")).toHaveLength(100);
  });
});
