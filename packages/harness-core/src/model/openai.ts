import type { ChatRequest, ChatResponse, ModelClient } from "./client.js";

export interface OpenAIModelOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  /**
   * How long one call may take. Generous by default and configurable, because the target
   * here is a local 27B on a laptop: a long prompt asking for a long answer legitimately
   * runs for minutes, and a cap tuned for a hosted endpoint turns that into a crash.
   */
  timeoutMs?: number;
  /**
   * Qwen3.x-style "thinking" is off by default. Measured on this project's endpoint: the
   * same trivial request takes 5.0s and comes back as reasoning prose that hits the token
   * limit with thinking on, and 1.0s with the answer when it is off.
   */
  noThink?: boolean;
  /** Ask the endpoint to constrain decoding to the schema. Not every server supports it. */
  guided?: boolean;
}

/**
 * An OpenAI-compatible chat client that speaks this project's request shape.
 *
 * The stable half goes in the system message and the variable half in the user message, so
 * the bytes the endpoint's prefix cache can reuse actually come first.
 */
export class OpenAIModel implements ModelClient {
  private guidedSupported: boolean;

  constructor(private opts: OpenAIModelOptions) {
    this.guidedSupported = opts.guided ?? true;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const at = Date.now();
    const content: Array<Record<string, unknown>> = [{ type: "text", text: req.variable }];
    for (const url of req.images ?? []) content.push({ type: "image_url", image_url: { url } });

    const body: Record<string, unknown> = {
      model: this.opts.model,
      messages: [
        { role: "system", content: req.stable },
        { role: "user", content: req.images?.length ? content : req.variable },
      ],
      max_tokens: req.maxTokens ?? 1024,
      temperature: 0,
    };
    if (this.opts.noThink !== false) {
      // Both spellings: servers differ in which one they honour, and sending the wrong one
      // alone silently leaves thinking on.
      body.enable_thinking = false;
      body.chat_template_kwargs = { enable_thinking: false };
    }
    if (req.schema && this.guidedSupported)
      body.response_format = { type: "json_schema", json_schema: { name: "output", schema: req.schema } };

    const timeoutMs = this.opts.timeoutMs ?? 900_000;
    let res;
    try {
      res = await this.post(body);
    } catch (e) {
      // "The operation was aborted due to timeout" names neither the call nor the limit,
      // which leaves whoever reads it guessing at both.
      if ((e as Error).name === "TimeoutError" || /timeout/i.test((e as Error).message))
        throw new Error(
          `model timed out after ${Math.round(timeoutMs / 1000)}s on ${req.label ?? "a call"} ` +
            `(asked for up to ${body.max_tokens} tokens) — raise TP_MODEL_TIMEOUT_MS or ask for less`,
        );
      throw e;
    }
    if (!res.ok && req.schema && this.guidedSupported) {
      // Guided decoding is a nice-to-have: an endpoint that rejects it should degrade to a
      // plain call (the reply is validated by schema afterwards either way), and it should
      // only be discovered once rather than on every call.
      this.guidedSupported = false;
      delete body.response_format;
      res = await this.post(body);
    }
    if (!res.ok) throw new Error(`model HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
      usage?: { total_tokens?: number };
    };
    return {
      text: json.choices?.[0]?.message?.content ?? "",
      tokens: json.usage?.total_tokens ?? 0,
      ms: Date.now() - at,
      // A cut-off reply parses as broken JSON, and "the model returned invalid JSON" sends
      // whoever reads it looking for a prompt problem that isn't there. The server knows
      // which it was; carry that answer instead of making it guessable.
      truncated: json.choices?.[0]?.finish_reason === "length",
    };
  }

  private post(body: Record<string, unknown>): Promise<Response> {
    return fetch(`${this.opts.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.opts.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 900_000),
    });
  }
}

/** Build a client from the environment the gateway already configures. */
export function modelFromEnv(env: NodeJS.ProcessEnv = process.env): OpenAIModel {
  return new OpenAIModel({
    baseUrl: env.OPENAI_BASE_URL ?? env.MIDSCENE_MODEL_BASE_URL ?? "http://127.0.0.1:8000/v1",
    apiKey: env.OPENAI_API_KEY ?? env.MIDSCENE_MODEL_API_KEY ?? "",
    model: env.MIDSCENE_MODEL_NAME ?? "Qwen3.8-27B-4bit",
    timeoutMs: env.TP_MODEL_TIMEOUT_MS ? Number(env.TP_MODEL_TIMEOUT_MS) : undefined,
  });
}
