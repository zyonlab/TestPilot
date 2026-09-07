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
  /**
   * 端点方言。**理由绑在出口上，换出口就要重验**（见 `modelFromEnv` 里 noThink 那段）：
   * Groq 拒绝 `chat_template_kwargs` / `thinking_budget`（400 unsupported），关思考要用
   * `reasoning_effort: "none"`，开着思考要用 `reasoning_format: "hidden"` 让推理不混进
   * content（否则 JSON 模式只收到一对空的 <think> 标签而校验失败——2026-09-04 实测）。
   * 不给就按 baseUrl 的主机名猜：`groq.com` → groq，其余 → openai（vLLM / DashScope 那一族）。
   */
  flavor?: "openai" | "groq";
}

/** 从 baseUrl 猜方言。只认得出 Groq；别的都当 vLLM 一族的 OpenAI 兼容。 */
export function flavorOf(baseUrl: string, explicit?: "openai" | "groq"): "openai" | "groq" {
  if (explicit) return explicit;
  try {
    return new URL(baseUrl).hostname.endsWith("groq.com") ? "groq" : "openai";
  } catch {
    return "openai";
  }
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
   * 就地换一份配置。
   *
   * 存在的理由很具体：网关那份客户端是**模块顶层的 const**
   * （`server/src/graphs.ts` 的 `export const model = traced(gated(modelFromEnv()))`），
   * 它捕获的是 import 那一刻的值。往 `process.env` 里写新配置对它无效——
   * 于是「界面上改了端点」在网关自己这条路上要等到重启才生效，而人不会知道。
   *
   * 这么做是安全的，因为 `opts` 的每一项都在**调用时**才读（baseUrl / apiKey / model /
   * noThink / thinkBudget / timeoutMs），所以改完下一次调用就生效，不必重建客户端。
   *
   * 代价要说清楚：一次正在跑的运行可能跨两份配置。所以调用方要留一条审计记录，
   * 而成本报表应该按 `ChatResponse.model`（端点自己回报的那个）算，不是按配置算。
   */
  reconfigure(patch: Partial<OpenAIModelOptions>): void {
    this.opts = { ...this.opts, ...patch };
    if (patch.guided !== undefined) this.guidedSupported = patch.guided;
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
    const flavor = flavorOf(this.opts.baseUrl, this.opts.flavor);
    if (flavor === "groq") {
      // Groq：关思考是 reasoning_effort=none；开着思考时把推理藏起来，content 里只剩答案。
      // 它不认 thinking_budget，预算只能靠 max_tokens 兜。
      if (this.opts.noThink !== false) body.reasoning_effort = "none";
      else body.reasoning_format = "hidden";
    } else {
      if (this.thinkBudget) body.thinking_budget = this.thinkBudget;
      if (this.opts.noThink !== false) {
        // Both spellings: servers differ in which one they honour, and sending the wrong one
        // alone silently leaves thinking on.
        body.enable_thinking = false;
        body.chat_template_kwargs = { enable_thinking: false };
      }
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
      model?: string;
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
      usage?: {
        total_tokens?: number;
        prompt_tokens?: number;
        completion_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number };
      };
    };
    const u = json.usage;
    /**
     * 分项用量：有就带上，没有就留空。
     *
     * **不拿总数去减一个猜的数**——一个凑出来的分项让成本看起来精确，而错在哪没人查得出来。
     * 缓存命中数走 OpenAI 那个 `prompt_tokens_details.cached_tokens` 的位置；
     * 这条流水线的速度大半来自前缀缓存，所以它值得单独记一笔。
     */
    const usage =
      u && (u.prompt_tokens !== undefined || u.completion_tokens !== undefined || u.total_tokens !== undefined)
        ? {
            ...(u.prompt_tokens !== undefined ? { input: u.prompt_tokens } : {}),
            ...(u.completion_tokens !== undefined ? { output: u.completion_tokens } : {}),
            ...(u.total_tokens !== undefined ? { total: u.total_tokens } : {}),
            ...(u.prompt_tokens_details?.cached_tokens !== undefined
              ? { cached: u.prompt_tokens_details.cached_tokens }
              : {}),
          }
        : undefined;
    return {
      text: json.choices?.[0]?.message?.content ?? "",
      tokens: json.usage?.total_tokens ?? 0,
      ms: Date.now() - at,
      ...(usage ? { usage } : {}),
      // 端点回的那个名字优先：代理有可能把请求路由到别的模型，而我们配置里写的那个
      // 只是「我们以为的」。两者不一致时，报表该按真的算。
      model: json.model ?? this.opts.model,
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
/**
 * 判官的模型——**必须和生成器不同族**（P2：考官不能是考生）。
 *
 * 读 `TP_JUDGE_MODEL`；没设就退回 `MIDSCENE_MODEL_NAME`（此时判官=生成器，是 P2 的弱化，
 * 调用方应显式设置）。其余（baseUrl / key / thinking / 超时）与 `modelFromEnv` 同一套——
 * 判官走的是同一个网关的另一个模型，不是另一套凭证。
 */
export function judgeModelFromEnv(env: NodeJS.ProcessEnv = process.env): OpenAIModel {
  const judge = env.TP_JUDGE_MODEL && env.TP_JUDGE_MODEL.trim() ? env.TP_JUDGE_MODEL : undefined;
  return modelFromEnv(judge ? { ...env, MIDSCENE_MODEL_NAME: judge } : env);
}

export function modelFromEnv(env: NodeJS.ProcessEnv = process.env): OpenAIModel {
  return new OpenAIModel({
    baseUrl: env.OPENAI_BASE_URL ?? env.MIDSCENE_MODEL_BASE_URL ?? "http://127.0.0.1:8000/v1",
    apiKey: env.OPENAI_API_KEY ?? env.MIDSCENE_MODEL_API_KEY ?? "",
    model: env.MIDSCENE_MODEL_NAME ?? "Qwen3.8-27B-4bit",
    timeoutMs: env.TP_MODEL_TIMEOUT_MS ? Number(env.TP_MODEL_TIMEOUT_MS) : undefined,
    /**
     * **默认开着思考。**`TP_MODEL_THINK=0` 关掉。
     *
     * 这个默认值是量出来的，不是拍的。PetClinic 上两臂条件完全一致地各跑三轮
     * （见 `docs/spec/13-重新规划.md` 阶段 C）：
     *
     *   语义覆盖      关 0.723 ± 0.078　开 0.630 ± 0.128　——**看不出差别**
     *   门禁①        关 0.982 ± 0.025　开 **1.000 ± 0.000**
     *   说得出转移    关 76%　　　　　　开 **89%**
     *   用例数        关 34.0 ± **8.5**　开 39.7 ± **0.6**
     *   代价          +17% token，+55% 耗时
     *
     * 按覆盖率选，两者没区别；按**方差**选，开思考明显赢。而方差恰恰卡着这个项目的两件
     * 正事：配对评测（B 阶段的消融就死在单臂 ±0.39 的方差上，两臂均值差 0.00），
     * 以及产出交给人复核（门禁满分、89% 的用例说得出自己验哪条转移，直接降阅读成本）。
     *
     * **方差本身是可以被当作指标优化的**——一个方差小的配置，能让同样的样本量读出更小的
     * 效应。这条比覆盖率那一栏更值钱。
     *
     * 曾经默认是关的，理由是「推理 token 吃 maxTokens 预算」。那个理由在 DashScope 上成立
     * （实测同一句话开着花 22 个 reasoning token），在 TokenHarbor 上不成立
     * （实测 completion_tokens 与关着时相同）。**理由绑在出口上，换出口就要重验。**
     */
    noThink: env.TP_MODEL_THINK === "0" ? true : false,
    thinkBudget: env.TP_MODEL_THINK_BUDGET ? Number(env.TP_MODEL_THINK_BUDGET) : undefined,
    // 显式 `TP_MODEL_FLAVOR=groq|openai` 压过按主机名猜。
    flavor: env.TP_MODEL_FLAVOR === "groq" || env.TP_MODEL_FLAVOR === "openai" ? env.TP_MODEL_FLAVOR : undefined,
  });
}
