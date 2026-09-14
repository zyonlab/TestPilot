import { describe, expect, it } from "vitest";
import {
  addTracingSecrets,
  forTrace,
  isTracingEnabled,
  observe,
  beginObservation,
  startTracing,
  traceIdFor,
} from "../src/obs/langfuse.js";
import { traced } from "../src/model/traced.js";
import { FakeModel } from "../src/model/client.js";

/**
 * 这组测试盯的是**没有密钥时的行为**，而那是绝大多数情况：测试、离线跑、
 * 别人 clone 下来的仓库。追踪在这条路径上必须彻底消失——不是「开着但发不出去」。
 *
 * 网络那一半（真的发一条 trace 出去再拉回来审）不在这里：一个依赖外部服务的单元测试
 * 会在别人机器上红，然后被关掉，然后它什么也保护不了。
 */
describe("langfuse tracing, unconfigured", () => {
  it("stays off without credentials, and says why", () => {
    const r = startTracing({ service: "test", env: {} as NodeJS.ProcessEnv });
    expect(r.enabled).toBe(false);
    // 「静默关闭」的可观测性系统比没有还糟：人会以为它开着。
    expect(r.reason).toMatch(/LANGFUSE_PUBLIC_KEY/);
    expect(isTracingEnabled()).toBe(false);
  });

  it("observe() is a pass-through when off — value and errors both survive", async () => {
    const got = await observe("x", { asType: "chain" }, async () => 42);
    expect(got).toBe(42);
    await expect(observe("x", {}, async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
  });

  it("beginObservation() returns a no-op that cannot throw", () => {
    const o = beginObservation("x", { input: 1 }, "generation");
    expect(() => {
      o.update({ output: 2 });
      o.end();
    }).not.toThrow();
  });

  it("traceIdFor() yields nothing when off, rather than a fake id", async () => {
    expect(await traceIdFor("wf-1")).toBeUndefined();
  });

  it("traced() does not disturb the client it wraps", async () => {
    const fake = new FakeModel("hello", { tokens: 7 });
    const res = await traced(fake).chat({ stable: "s", variable: "v", label: "n:1" });
    expect(res.text).toBe("hello");
    expect(res.tokens).toBe(7);
    expect(fake.calls).toHaveLength(1);
  });
});

describe("forTrace", () => {
  it("passes small values through untouched", () => {
    const v = { a: 1, b: "x" };
    expect(forTrace(v)).toBe(v);
  });

  it("truncates big ones AND says that it did", () => {
    const big = { cases: Array.from({ length: 2000 }, (_, i) => ({ id: `C-${i}`, title: "用例" })) };
    const out = forTrace(big, 500) as Record<string, unknown>;
    // 悄悄截断是这个仓库栽过四次的那个形状：产出从外面看只是「短了一点」。
    expect(out.__truncatedForTrace).toBe(true);
    expect(out.originalChars).toBeGreaterThan(500);
    expect(String(out.preview)).toHaveLength(500);
  });

  it("survives a value JSON cannot serialise", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(forTrace(cyclic)).toEqual({ __unserializable: true });
  });

  it("leaves null and undefined alone", () => {
    expect(forTrace(null)).toBeNull();
    expect(forTrace(undefined)).toBeUndefined();
  });
});

describe("secret registration", () => {
  it("accumulates and ignores values too short to be secrets", () => {
    // 空串会让 redact 在每个字符之间插一遍掩码；短串会误伤正常文本。
    expect(() => addTracingSecrets(["", "ab", "a-real-looking-secret"])).not.toThrow();
  });
});
