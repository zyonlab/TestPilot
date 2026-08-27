import { describe, expect, it, vi } from "vitest";
import {
  FakeModel,
  RecordedModel,
  gated,
  requestKey,
  type ChatRequest,
  type ModelClient,
} from "../src/model/client.js";
import { Gate } from "../src/model/gate.js";
import { setModelLease } from "../src/model/lease.js";

const req = (over: Partial<ChatRequest> = {}): ChatRequest => ({
  stable: "You are a test designer. Return JSON.",
  variable: "story: log in with a valid account",
  ...over,
});

describe("requestKey", () => {
  it("is stable for the same request and changes when the material changes", () => {
    expect(requestKey(req())).toBe(requestKey(req()));
    expect(requestKey(req({ variable: "story: log in with a locked account" }))).not.toBe(requestKey(req()));
  });

  it("separates requests that differ only in their stable half", () => {
    expect(requestKey(req({ stable: "different role" }))).not.toBe(requestKey(req()));
  });

  it("hashes images instead of carrying them: identity, not megabytes", () => {
    const big = "data:image/png;base64," + "A".repeat(200000);
    const k = requestKey(req({ images: [big] }));
    expect(k).toHaveLength(32);
    expect(k).not.toBe(requestKey(req()));
    expect(requestKey(req({ images: [big] }))).toBe(k);
  });
});

describe("FakeModel", () => {
  it("answers deterministically and remembers what it was asked", async () => {
    const m = new FakeModel("always this");
    expect((await m.chat(req())).text).toBe("always this");
    expect(m.calls).toHaveLength(1);
  });

  it("can answer differently per call, which is what testing a loop needs", async () => {
    const m = new FakeModel((_r, n) => `reply ${n}`);
    expect((await m.chat(req())).text).toBe("reply 0");
    expect((await m.chat(req())).text).toBe("reply 1");
  });
});

describe("RecordedModel", () => {
  it("replays a recorded answer without touching the model", async () => {
    const upstream = new FakeModel("live");
    const recording = { [requestKey(req())]: { text: "recorded", tokens: 12, ms: 3400 } };
    const m = new RecordedModel(recording, { upstream });
    const res = await m.chat(req());
    expect(res).toMatchObject({ text: "recorded", tokens: 12, replayed: true });
    expect(upstream.calls).toHaveLength(0);
  });

  it("refuses an unknown request in replay mode instead of quietly going live", async () => {
    const m = new RecordedModel({}, { upstream: new FakeModel("live") });
    await expect(m.chat(req({ label: "design.cases" }))).rejects.toThrow(/no recording for design.cases/);
  });

  it("records what it did not know, so re-recording is one run", async () => {
    const onRecord = vi.fn();
    const m = new RecordedModel({}, { mode: "record", upstream: new FakeModel("live"), onRecord });
    expect((await m.chat(req())).text).toBe("live");
    expect(onRecord).toHaveBeenCalledOnce();
    const again = await m.chat(req());
    expect(again.replayed).toBe(true);
  });
});

describe("gated", () => {
  it("routes every call through the process-wide admission gate", async () => {
    const gate = new Gate(1);
    setModelLease((fn) => gate.run(fn));
    const inner = new FakeModel("ok");
    const client: ModelClient = gated(inner);
    await Promise.all([client.chat(req()), client.chat(req())]);
    expect(inner.calls).toHaveLength(2);
    expect(gate.stats()).toMatchObject({ active: 0, waiting: 0 });
    setModelLease((fn) => fn());
  });
});
