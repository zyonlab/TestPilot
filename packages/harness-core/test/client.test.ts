import { describe, expect, it, vi } from "vitest";
import { OpenAIModel } from "../src/model/openai.js";
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

/**
 * 网络层失败重试，别的一概不重试。
 *
 * 界线跟着失败分档走：**infra 可重试，判决不可**。一次 `fetch failed` 说明这一刻网络不通，
 * 重来多半就好；一个格式不对的回复重来多半还是不对——重试它只是把同一个问题再问一遍，
 * 还掩盖了它。实测：一次五分钟的运行死在 `plan.stories: fetch failed`，而端点本身好好的。
 */
describe("transient failures reaching the model", () => {
  const reply = { choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { total_tokens: 3 } };
  const okResponse = () => ({ ok: true, status: 200, json: async () => reply, text: async () => "" }) as never;

  it("网络抖动之后重试成功", async () => {
    let calls = 0;
    const fake = { post: async () => { calls++; if (calls < 3) throw new Error("fetch failed"); return okResponse(); } };
    const m = new OpenAIModel({ baseUrl: "http://x/v1", apiKey: "k", model: "m", retryBackoffMs: 0 });
    (m as unknown as typeof fake).post = fake.post;
    expect((await m.chat({ stable: "s", variable: "v" })).text).toBe("ok");
    expect(calls).toBe(3);
  });

  it("一直不通就报「联系不上」，而不是报格式问题", async () => {
    const m = new OpenAIModel({ baseUrl: "http://x/v1", apiKey: "k", model: "m", retryBackoffMs: 0 });
    (m as unknown as { post: () => Promise<never> }).post = async () => { throw new Error("fetch failed"); };
    await expect(m.chat({ stable: "s", variable: "v", label: "plan.stories" })).rejects.toThrow(
      /unreachable on plan\.stories after 3 retries/,
    );
  });

  it("5xx 也重试——那是「这一刻不行」，不是「这个请求不对」", async () => {
    let calls = 0;
    const m = new OpenAIModel({ baseUrl: "http://x/v1", apiKey: "k", model: "m", retryBackoffMs: 0 });
    (m as unknown as { post: () => Promise<unknown> }).post = async () => {
      calls++;
      return calls < 2 ? ({ ok: false, status: 503, text: async () => "busy" } as never) : okResponse();
    };
    expect((await m.chat({ stable: "s", variable: "v" })).text).toBe("ok");
    expect(calls).toBe(2);
  });

  it("4xx 不重试——请求本身不对，重来一次还是不对", async () => {
    let calls = 0;
    const m = new OpenAIModel({ baseUrl: "http://x/v1", apiKey: "k", model: "m", retryBackoffMs: 0 });
    (m as unknown as { post: () => Promise<unknown> }).post = async () => {
      calls++;
      return { ok: false, status: 400, text: async () => "bad request" } as never;
    };
    await expect(m.chat({ stable: "s", variable: "v" })).rejects.toThrow(/HTTP 400/);
    expect(calls).toBe(1);
  });
});
