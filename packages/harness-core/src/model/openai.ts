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
  /** 涨预算重发时说一声。留空则不说——这个类不该假设调用方有什么日志设施。 */
  onLog?: (message: string) => void;
  /** 开着思考时，推理最多写多长。见 `max_tokens` 那段。 */
  thinkBudget?: number;
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

  /**
   * **被截断就加大预算重来一次。**
   *
   * 截断的检测一直都有（`finish_reason === "length"`），但只被写进错误消息，从没拿来
   * 重试过。于是每一个手工定的 `maxTokens` 常数都是**正确性关键**的：定小了，产出不是
   * 报错，是「看起来正常、只是少了一截」——规格少几条规则、故事少几条、用例从 40 条
   * 变成 9 条。一天之内这样撞了四次（6000、7200、12800、12800）。
   *
   * 有了这一层，那些常数就只影响**成本和时延**，不再影响**对错**：定小了就多花一次调用，
   * 而且日志里说得清清楚楚。这才是「让这个数自己算出来」该有的样子——
   * 光按材料规模乘一个我拍的每项常数，只是把猜测从总量挪到了每一项。
   *
   * 最多涨两次（×2、×4），上限 32000。还被截断就如实报错：那时问题多半不是预算，
   * 是模型在原地重复。
   */
  async chat(req: ChatRequest): Promise<ChatResponse> {
    const ceiling = 32000;
    let asked = req.maxTokens ?? 1024;
    for (let grow = 0; ; grow++) {
      const out = await this.once({ ...req, maxTokens: asked });
      if (!out.truncated || grow >= 2 || asked >= ceiling) return out;
      const next = Math.min(ceiling, asked * 2);
      if (next === asked) return out;
      this.opts.onLog?.(
        `${req.label ?? "a call"}: 回复在 ${asked} tokens 处被截断，加大到 ${next} 重来一次`,
      );
      asked = next;
    }
  }

  private async once(req: ChatRequest): Promise<ChatResponse> {
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
       * 调用方要的是「答案有多长」，而开着思考时模型先写推理再写答案，两段共用这一个
       * 预算。实测：思考打开之后同样的 `plan.stories` 调用 3 次里 2 次在 12800 处被切断
       * ——不是模型不会答，是它把预算花在推理上，答案写到一半没地方了。
       *
       * 第一版的修法是把总预算 ×3。**那个方向是错的**：它没有约束推理，只是允许模型
       * 生成到 32000 token，于是一次 `plan.stories` 跑了 30 分钟还没结束——从「静悄悄
       * 地截断」换成了「静悄悄地慢到不可用」。
       *
       * 正确的旋钮是 `thinking_budget`：**限的是推理本身的长度**。给推理一份固定的额度，
       * 答案的额度一分不动，两者相加才是 `max_tokens`。这样「开思考」和「不开思考」
       * 对照时，答案那一份是完全相同的——差别只在模型有没有先想一遍。
       */
      max_tokens: Math.min(32000, (req.maxTokens ?? 1024) + (this.thinkBudget ?? 0)),
      temperature: 0,
    };
    if (this.thinkBudget) body.thinking_budget = this.thinkBudget;
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

  /** 开着思考才有推理预算；关着时是 0，`max_tokens` 与不思考完全一致。 */
  private get thinkBudget(): number {
    return this.opts.noThink === false ? (this.opts.thinkBudget ?? 1024) : 0;
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
    thinkBudget: env.TP_MODEL_THINK_BUDGET ? Number(env.TP_MODEL_THINK_BUDGET) : undefined,
  });
}
