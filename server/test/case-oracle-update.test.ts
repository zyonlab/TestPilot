import { describe, it, expect } from "vitest";
import { createProject, createCase, updateCase, getCase } from "../src/db.js";

/**
 * 改判据要落库。
 *
 * `updateCase` 的 UPDATE 里此前没有 `oracleJson`：改了判据，返回值回显合并后的对象，
 * 库里还是旧的——下一次运行照旧判。2026-09-07 在 hyperliquid 基准上把限价从 10000
 * 改到 40000，运行仍报「要求 eq 10000」才发现。这里断言的是**读回来**的值，不是返回值。
 */
describe("updateCase 落库判据", () => {
  const pid = createProject(`oracle-${Math.random().toString(36).slice(2, 7)}`, "https://x.example").id;

  it("改了 oracle 之后 getCase 读到的是新值", () => {
    const c = createCase({
      projectId: pid,
      title: "限价",
      steps: [{ text: "挂单" }],
      oracle: { kind: "api", url: "https://api.example/info", method: "POST", body: "{}", path: "[coin=BTC].limitPx", op: "eq", value: 10000 } as never,
    });
    expect(getCase(c.id)?.oracle).toMatchObject({ value: 10000 });
    updateCase(c.id, { oracle: { ...(c.oracle as object), value: 40000 } as never });
    expect(getCase(c.id)?.oracle).toMatchObject({ value: 40000 });
  });

  it("degraded 与 covers 同样落库；不传则保持原值", () => {
    const c = createCase({ projectId: pid, title: "覆盖", steps: [{ text: "x" }], covers: ["AC-1"] as never });
    updateCase(c.id, { degraded: true } as never);
    const got = getCase(c.id)!;
    expect(got.degraded).toBe(true);
    expect(got.covers).toEqual(["AC-1"]);
    updateCase(c.id, { covers: ["AC-1", "AC-2"] } as never);
    expect(getCase(c.id)?.covers).toEqual(["AC-1", "AC-2"]);
  });
});
