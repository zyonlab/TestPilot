import { describe, expect, it } from "vitest";
import { OpenAIModel, flavorOf } from "../src/model/openai.js";

/**
 * 理由绑在出口上：Groq 拒绝 vLLM 一族的思考开关，要换一套字段。这里钉住两族各发什么。
 * 用一个假的 fetch 抓请求体——不打网络。
 */
async function capture(opts: ConstructorParameters<typeof OpenAIModel>[0]): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> = {};
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    body = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: "{}" }, finish_reason: "stop" }], usage: { total_tokens: 1 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    await new OpenAIModel({ ...opts, retries: 0 }).chat({ stable: "s", variable: "v", maxTokens: 10, schema: { type: "object" } });
  } finally {
    globalThis.fetch = realFetch;
  }
  return body;
}

describe("端点方言", () => {
  it("按主机名猜：groq.com 是 groq，别的都是 openai；显式给的压过猜", () => {
    expect(flavorOf("https://api.groq.com/openai/v1")).toBe("groq");
    expect(flavorOf("https://api.runinfra.ai/v1")).toBe("openai");
    expect(flavorOf("not a url")).toBe("openai");
    expect(flavorOf("https://api.groq.com/openai/v1", "openai")).toBe("openai");
  });

  it("groq 关思考：reasoning_effort=none，不发 chat_template_kwargs / thinking_budget", async () => {
    const b = await capture({ baseUrl: "https://api.groq.com/openai/v1", apiKey: "k", model: "qwen/qwen3.8-27b", noThink: true, thinkBudget: 500 });
    expect(b.reasoning_effort).toBe("none");
    expect(b.chat_template_kwargs).toBeUndefined();
    expect(b.enable_thinking).toBeUndefined();
    expect(b.thinking_budget).toBeUndefined();
    expect((b.response_format as { type: string }).type).toBe("json_schema");
  });

  it("groq 开思考：reasoning_format=hidden，推理不混进 content", async () => {
    const b = await capture({ baseUrl: "https://api.groq.com/openai/v1", apiKey: "k", model: "m", noThink: false });
    expect(b.reasoning_format).toBe("hidden");
    expect(b.reasoning_effort).toBeUndefined();
  });

  it("openai 一族关思考：两种拼法的 enable_thinking 之外还要发标准的 reasoning_effort", async () => {
    const off = await capture({ baseUrl: "https://api.runinfra.ai/v1", apiKey: "k", model: "m", noThink: true });
    expect(off.enable_thinking).toBe(false);
    expect((off.chat_template_kwargs as { enable_thinking: boolean }).enable_thinking).toBe(false);
    /**
     * 2026-09-11 实测：这个端点两个厂商扩展都不认，只有 `reasoning_effort: "none"` 管用。
     * 不发它，推理会把 max_tokens 吃光，content 为空串，下游报「模型返回空内容」。
     */
    expect(off.reasoning_effort).toBe("none");
    const on = await capture({ baseUrl: "https://api.runinfra.ai/v1", apiKey: "k", model: "m", noThink: false, thinkBudget: 500 });
    expect(on.thinking_budget).toBe(500);
    expect(on.enable_thinking).toBeUndefined();
    expect(on.reasoning_format).toBeUndefined();
  });
});
