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
  /** 网络层失败重试几次。默认 3。 */
  retries?: number;
  /** 退避基数（毫秒），第 n 次等 n×这个数。默认 2000。 */
  retryBackoffMs?: number;
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
      /**
       * **思考的 token 计入 `max_tokens`。**
       *
       * 调用方要的是「答案有多长」，而开着思考时，模型先写一段推理，再写答案，两段
       * 共用这一个预算。实测：思考打开之后，同样的 `plan.stories` 调用 3 次里 2 次
       * 在 12800 处被切断——不是模型不会答，是它把预算花在推理上，答案写到一半没地方了。
       *
       * 所以这里替调用方把推理那一份加回去。倍数 3 是实测的量级（一次简单问答里
       * 22 个 reasoning token 对 1 个答案 token；复杂任务上比例低得多，3 倍够用），
       * 上限 32000 是 DashScope 收得下的规模。
       *
       * 不这么做的话，「开思考」和「不开思考」的对照是不公平的：那等于让开着思考的那一组
       * 用一半的预算答同一道题。
       */
      max_tokens: Math.min(
        32000,
        (req.maxTokens ?? 1024) * (this.opts.noThink === false ? 3 : 1),
      ),
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
    /**
     * 网络层失败重试，别的一概不重试。
     *
     * 这条界线跟着本项目的失败分档走：**infra 是可重试的，判决不是**。一次
     * `fetch failed` 说明的是这一刻网络不通，重来一次多半就好了；而一个格式不对的回复
     * 重来一次多半还是不对——重试它只是把同一个问题再问一遍，还掩盖了它。
     *
     * 实测：一次五分钟的运行死在 `plan.stories: fetch failed` 上，而端点本身好好的。
     * 没有这几行，一次网络抖动就废掉整轮。
     */
    const RETRIES = this.opts.retries ?? 3;
    // 退避可配，主要是为了测试能把它设成 0——一个只能靠等的行为，测起来只能靠等。
    const backoff = this.opts.retryBackoffMs ?? 2000;
    for (let attempt = 1; ; attempt++) {
      try {
        res = await this.post(body);
        // 5xx 与 429 也是「这一刻不行」，不是「这个请求不对」。
        if ((res.status >= 500 || res.status === 429) && attempt <= RETRIES) {
          await new Promise((r) => setTimeout(r, attempt * backoff));
          continue;
        }
        break;
      } catch (e) {
        // "The operation was aborted due to timeout" names neither the call nor the limit,
        // which leaves whoever reads it guessing at both.
        if ((e as Error).name === "TimeoutError" || /timeout/i.test((e as Error).message))
          throw new Error(
            `model timed out after ${Math.round(timeoutMs / 1000)}s on ${req.label ?? "a call"} ` +
              `(asked for up to ${body.max_tokens} tokens) — raise TP_MODEL_TIMEOUT_MS or ask for less`,
          );
        if (attempt > RETRIES)
          throw new Error(
            `model unreachable on ${req.label ?? "a call"} after ${RETRIES} retries — ${(e as Error).message}`,
          );
        await new Promise((r) => setTimeout(r, attempt * backoff));
      }
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
    /**
     * `TP_MODEL_THINK=1` 打开思考。
     *
     * 默认关着，理由是思考的 token 计入 completion——同一句「reply OK」，开着花 22 个
     * reasoning token，关着花 1 个；而这条流水线的每个节点都在 maxTokens 边缘（已经因为
     * 预算不足失败过三次），思考会直接把可用的输出预算吃掉一块。
     *
     * 但「关掉思考会不会让产出变差」是个**经验问题**，不该由默认值替人回答——
     * 我们有黄金清单和覆盖度量，可以直接测。做成开关是为了能配对比较。
     */
    noThink: env.TP_MODEL_THINK === "1" ? false : undefined,
  });
}
