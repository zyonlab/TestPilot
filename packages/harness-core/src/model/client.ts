import { createHash } from "node:crypto";
import { withModel } from "./lease.js";

/**
 * What a node asks the model for.
 *
 * The split between `stable` and `variable` is not cosmetic: the endpoint caches prompt
 * prefixes, and on a self-hosted model that cache is most of the speed. Measured on this
 * project's endpoint, ~6k of a ~9k-token request came back as a prefix-cache hit — which
 * only happens when the leading bytes are identical between calls. So the shape forces the
 * caller to say which half never changes.
 */
export interface ChatRequest {
  /** Never varies within a node type: role, method, output schema. Goes first. */
  stable: string;
  /** This call's material. Goes last. */
  variable: string;
  images?: string[];
  /** JSON Schema for guided decoding; also used to validate the reply. */
  schema?: Record<string, unknown>;
  maxTokens?: number;
  /** Label for cost attribution and for reading a recording. */
  label?: string;
}

/**
 * 进出各多少 token。
 *
 * `ChatResponse.tokens` 一直只有 `total_tokens` 一个数，而**成本不是它的函数**：
 * 同样 9k 个 token，8k 进 1k 出和 1k 进 8k 出，价钱能差好几倍（输出侧通常贵 3–5 倍）。
 * 只记总数，就等于承认「这次运行花了多少钱」这个问题答不了——而它恰好是
 * 「这个节点值不值」的分母。
 *
 * 端点不给分项时留空，**不要用总数去凑**：一个猜出来的分项会让成本看起来精确，
 * 而它错在哪没人查得出来。
 */
export interface TokenUsage {
  input?: number;
  output?: number;
  total?: number;
  /** 前缀缓存命中的那部分。这个端点的速度大半来自它，所以它是要盯的数。 */
  cached?: number;
}

export interface ChatResponse {
  text: string;
  tokens: number;
  ms: number;
  /** True when the answer came from a recording rather than the model. */
  replayed?: boolean;
  /** True when the model stopped because it ran out of budget, not because it was finished. */
  truncated?: boolean;
  /** 分项用量。见 `TokenUsage`——`tokens` 留着，因为现有的花费统计都读它。 */
  usage?: TokenUsage;
  /**
   * 真正回答这次调用的模型。
   *
   * 由客户端报，而不是由调用方假设：`modelFromEnv` 读的是环境变量，而一次运行中途
   * 换端点、或者代理把请求路由到别的模型，调用方是看不见的。一个「我们以为跑的是哪个模型」
   * 的成本报表，比没有报表更糟。
   */
  model?: string;
}

export interface ModelClient {
  chat(req: ChatRequest): Promise<ChatResponse>;
}

/**
 * Stable key for a request. Images are hashed rather than included: a screenshot is
 * megabytes, and what matters for identity is only that it is the same screenshot.
 */
export function requestKey(req: ChatRequest): string {
  const h = createHash("sha256");
  h.update(req.stable);
  h.update(" ");
  h.update(req.variable);
  h.update(" ");
  h.update(JSON.stringify(req.schema ?? null));
  h.update(" ");
  for (const img of req.images ?? []) h.update(createHash("sha256").update(img).digest("hex"));
  return h.digest("hex").slice(0, 32);
}

/**
 * Deterministic stand-in for the model.
 *
 * Unit tests must not depend on a 27B model being up, being fast, or being in the same
 * mood as yesterday — and a suite that takes minutes per assertion stops being run.
 */
export class FakeModel implements ModelClient {
  readonly calls: ChatRequest[] = [];

  constructor(
    private reply: string | ((req: ChatRequest, n: number) => string) = "ok",
    private opts: { tokens?: number; ms?: number } = {},
  ) {}

  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.calls.push(req);
    const text = typeof this.reply === "function" ? this.reply(req, this.calls.length - 1) : this.reply;
    return { text, tokens: this.opts.tokens ?? 0, ms: this.opts.ms ?? 0 };
  }
}

export interface Recording {
  [key: string]: {
    label?: string;
    text: string;
    tokens: number;
    ms: number;
    /**
     * 录这一条时**用的是哪套模型配置**。见 `modelFingerprint`。
     *
     * 请求指纹只哈希 stable / variable / schema / images——它回答的是「问的是不是同一句话」，
     * 而不是「答的是不是同一个模型」。模型配置一旦可以随时改（换端点、换模型、开关思考），
     * `--replay` 会照样全部命中，然后**打印旧模型的成绩**——它从「省时间」
     * 变成了「静悄悄地报告错误的成绩」。
     */
    config?: string;
  };
}

/**
 * 一套模型配置的指纹。**不含密钥**——它会被写进录像文件，而录像文件进版本库。
 *
 * 只取会改变回答的那几样：模型名、端点、思不思考、思考预算。
 * 温度之类的参数这套 client 没有暴露，暴露了再加。
 */
export function modelFingerprint(cfg: {
  model?: string;
  baseUrl?: string;
  noThink?: boolean;
  thinkBudget?: number;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        model: cfg.model ?? "",
        baseUrl: cfg.baseUrl ?? "",
        noThink: !!cfg.noThink,
        thinkBudget: cfg.thinkBudget ?? null,
      }),
    )
    .digest("hex")
    .slice(0, 12);
}

/**
 * VCR: replay real answers, record new ones.
 *
 * Recordings come from real runs, so a graph-level test exercises the replies the model
 * actually gave without paying forty seconds a call. In `replay` mode an unknown request
 * is an error rather than a silent live call: a test that quietly starts hitting the model
 * would pass on one machine and hang on another.
 */
export class RecordedModel implements ModelClient {
  /** 已经就配置不匹配告过警的那些键。同一条不重复喊。 */
  private warned = new Set<string>();

  constructor(
    private recording: Recording,
    private opts: {
      mode?: "replay" | "record";
      upstream?: ModelClient;
      onRecord?: (r: Recording) => void;
      /**
       * 这一次跑用的模型配置指纹（`modelFingerprint`）。
       *
       * 给了它，回放时录像里配置不一样的那些条目会告警——**不拦**，因为一份跨了
       * 两套配置的录像仍然是有用的，只是它的成绩不能被当成这套配置的成绩。
       */
      config?: string;
      onConfigMismatch?: (info: { key: string; label?: string; recorded: string; now: string }) => void;
    } = {},
  ) {}

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const key = requestKey(req);
    const hit = this.recording[key];
    if (hit) {
      /*
       * 命中了，但可能是**另一套模型配置**录下来的。
       *
       * 请求指纹只回答「问的是不是同一句话」。换掉模型之后每一条都照样命中，
       * 而打印出来的是旧模型的成绩——一次看起来一切正常的、错误的报告。
       */
      if (this.opts.config && hit.config && hit.config !== this.opts.config && !this.warned.has(key)) {
        this.warned.add(key);
        const info = { key, label: hit.label, recorded: hit.config, now: this.opts.config };
        if (this.opts.onConfigMismatch) this.opts.onConfigMismatch(info);
        else
          console.warn(
            `[replay] ${hit.label ?? key} 是用另一套模型配置录的（录像 ${hit.config} ≠ 现在 ${this.opts.config}）——` +
              `回放出来的是那套配置的成绩，不是这套的`,
          );
      }
      return { text: hit.text, tokens: hit.tokens, ms: hit.ms, replayed: true };
    }
    if ((this.opts.mode ?? "replay") === "replay" || !this.opts.upstream)
      throw new Error(
        `no recording for ${req.label ?? "request"} (${key}). Re-record with mode "record", or fix the prompt that changed.`,
      );
    const res = await this.opts.upstream.chat(req);
    this.recording[key] = {
      label: req.label,
      text: res.text,
      tokens: res.tokens,
      ms: res.ms,
      // 录的时候就把配置记下来。事后补不回来——那时候只剩一句"这条是谁录的"。
      ...(this.opts.config ? { config: this.opts.config } : {}),
    };
    this.opts.onRecord?.(this.recording);
    return res;
  }
}

/** Wrap any client so every call passes the process-wide admission gate. */
export function gated(client: ModelClient): ModelClient {
  return { chat: (req) => withModel(() => client.chat(req)) };
}
