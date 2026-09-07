import { describe, expect, it } from "vitest";
import { SqliteEventStore } from "../src/obs/store.js";

/**
 * 事件按运行取，而不是"先取最旧一万条再切尾"。
 *
 * 钉的是 docs/spec/17 的 U-23。原来的取法是 `since(0, 10_000).slice(-limit)`，
 * 而 `since` 是 `WHERE id > ? ORDER BY id ASC LIMIT ?`——两者合起来，一旦库里事件
 * 超过一万条，拿到的永远是**最旧一万条里的最后一千条**。历史运行的轨迹于是永远是空的，
 * 而界面把这个取数缺陷说成了一句关于那次运行的事实陈述。
 */
describe("按运行取事件", () => {
  const seed = (n: number) => {
    const s = new SqliteEventStore(":memory:");
    for (let i = 0; i < n; i++)
      s.append({
        ts: new Date(1_700_000_000_000 + i).toISOString(),
        kind: "wf.node.finished",
        scope: { wfRunId: i % 2 === 0 ? "wf-old" : "wf-new" },
        payload: { i },
      });
    return s;
  };

  it("超过一万条之后，仍然取得到最后那次运行的事件", () => {
    const s = seed(10_500);
    // 旧取法：最旧一万条里的最后一千条——这一千条里一条 id > 10000 的都没有。
    const oldWay = s.since(0, 10_000).slice(-1000);
    expect(Math.max(...oldWay.map((e) => e.id))).toBeLessThanOrEqual(10_000);

    // 新取法：拿到的确实全是这次运行的，而且**知道自己被截断了**。
    const mine = s.byRun("wf-new", 0, 1000);
    expect(mine.every((e) => e.scope.wfRunId === "wf-new")).toBe(true);
    expect(s.countByRun("wf-new")).toBe(5250);
    expect(mine.length).toBeLessThan(s.countByRun("wf-new")); // 截断了，而调用方查得出来

    // 而且分页真的能走到最后一条——这是旧取法永远做不到的。
    let cursor = 0;
    let last = 0;
    for (let i = 0; i < 10; i++) {
      const page = s.byRun("wf-new", cursor, 1000);
      if (!page.length) break;
      cursor = page[page.length - 1]!.id;
      last = cursor;
    }
    expect(last).toBeGreaterThan(10_000);
    s.close();
  });

  it("latest 取的是最新的，顺序仍然是升序", () => {
    const s = seed(10_500);
    const last = s.latest(5);
    expect(last).toHaveLength(5);
    expect(last[4]!.id).toBe(10_500);
    expect(last.map((e) => e.id)).toEqual([...last.map((e) => e.id)].sort((a, b) => a - b));
    s.close();
  });

  it("sinceId 让轨迹可以增量接上，不必每次重取", () => {
    const s = seed(200);
    const first = s.byRun("wf-new", 0, 10);
    const next = s.byRun("wf-new", first[first.length - 1]!.id, 10);
    expect(next[0]!.id).toBeGreaterThan(first[first.length - 1]!.id);
    s.close();
  });
});
