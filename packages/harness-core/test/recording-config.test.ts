import { describe, it, expect, vi } from "vitest";
import { RecordedModel, modelFingerprint, FakeModel, type Recording } from "../src/model/client.js";

const REQ = { stable: "s", variable: "v", label: "design.cases" };

describe("U-80 · 录像回放的指纹要含模型配置", () => {
  it("换掉模型之后回放仍然命中——但会告警说这是另一套配置的成绩", async () => {
    const a = modelFingerprint({ model: "qwen3-8-27b", baseUrl: "https://api.example/v1" });
    const b = modelFingerprint({ model: "qwen3-max", baseUrl: "https://api.example/v1" });
    expect(a).not.toBe(b);

    const recording: Recording = {};
    // 用配置 a 录一条。
    const rec = new RecordedModel(recording, { mode: "record", upstream: new FakeModel("旧模型的回答"), config: a });
    await rec.chat(REQ);
    expect(Object.values(recording)[0].config).toBe(a);

    // 换成配置 b 回放：命中了，但必须喊出来。
    const seen: Array<{ recorded: string; now: string }> = [];
    const play = new RecordedModel(recording, { mode: "replay", config: b, onConfigMismatch: (i) => seen.push(i) });
    const res = await play.chat(REQ);
    expect(res.text).toBe("旧模型的回答");
    expect(res.replayed).toBe(true);
    expect(seen).toEqual([expect.objectContaining({ recorded: a, now: b })]);
  });

  it("同一套配置回放不告警", async () => {
    const a = modelFingerprint({ model: "qwen3-8-27b" });
    const recording: Recording = {};
    await new RecordedModel(recording, { mode: "record", upstream: new FakeModel("x"), config: a }).chat(REQ);
    const seen: unknown[] = [];
    await new RecordedModel(recording, { mode: "replay", config: a, onConfigMismatch: (i) => seen.push(i) }).chat(REQ);
    expect(seen).toHaveLength(0);
  });

  it("同一条只喊一次——十条一样的请求不该刷屏", async () => {
    const a = modelFingerprint({ model: "old" });
    const b = modelFingerprint({ model: "new" });
    const recording: Recording = {};
    await new RecordedModel(recording, { mode: "record", upstream: new FakeModel("x"), config: a }).chat(REQ);
    const seen: unknown[] = [];
    const play = new RecordedModel(recording, { mode: "replay", config: b, onConfigMismatch: (i) => seen.push(i) });
    await play.chat(REQ);
    await play.chat(REQ);
    await play.chat(REQ);
    expect(seen).toHaveLength(1);
  });

  it("指纹里没有密钥——它会跟着录像进版本库", () => {
    const fp = modelFingerprint({ model: "m", baseUrl: "https://x/v1" });
    expect(fp).toMatch(/^[0-9a-f]{12}$/);
    // 老录像没有 config，那不是错，只是没法判断——不告警。
    expect(fp.includes("sk-")).toBe(false);
  });

  it("老录像（没有 config）照常回放，不告警", async () => {
    const recording: Recording = { [""]: { text: "", tokens: 0, ms: 0 } };
    const key = Object.keys(recording)[0];
    delete recording[key];
    const rec = new RecordedModel(recording, { mode: "record", upstream: new FakeModel("x") });
    await rec.chat(REQ); // 录的时候没给 config
    const stored = Object.values(recording)[0];
    expect(stored.config).toBeUndefined();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await new RecordedModel(recording, { mode: "replay", config: modelFingerprint({ model: "whatever" }) }).chat(REQ);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
