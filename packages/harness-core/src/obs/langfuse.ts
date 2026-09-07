import { NodeSDK } from "@opentelemetry/sdk-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import {
  createTraceId,
  propagateAttributes,
  startActiveObservation,
  startObservation,

} from "@langfuse/tracing";
import { redact } from "../util/interpolate.js";

/**
 * Langfuse tracing.
 *
 * This project already has an event bus, and that bus IS lineage — every node input,
 * output, prompt and cost lands in `events.db` and the UI is a projection of those rows.
 * So the obvious question is why a second observability system exists at all.
 *
 * The answer is that the two answer different questions. The bus answers
 * **「这次运行发生了什么」** for one run, in this product's own vocabulary, and it is what
 * `replay` and the paired evaluation read. Langfuse answers **「这些运行加起来说明什么」**
 * across runs: which prompt version costs what, which node's latency moved, which arm of an
 * ablation produced worse output — questions that need a store built for aggregation and a
 * UI built for comparison, neither of which a per-run event log is.
 *
 * The two must not disagree, so tracing is strictly derived from the same facts the bus
 * already carries. Nothing here is a second source of truth; if a number appears in both
 * places it is computed once and reported twice.
 *
 * ## 三条纪律
 *
 * **① 没有密钥就完全不启动。** 不是「启动然后发不出去」——那会留下一个后台批处理器、
 * 一条永远失败的导出链路，以及一堆没人看的重试日志。测试、离线跑、别人 clone 下来的仓库，
 * 都属于这一类，而它们是多数情况。`isTracingEnabled()` 为假时，下面每个包装器都是
 * 直通调用，一次 OTEL API 都不碰。
 *
 * **② 它永远不能弄坏一次运行。** 一次评测跑四小时。任何情况下，追踪出问题的正确行为是
 * 追踪自己消失，而不是把运行带走。SDK 自己会吞掉内部错误，但我们的包装层也要吞——
 * 一个 `.end()` 抛出来的异常同样会毁掉那次运行。
 *
 * **③ 密钥不出网。** 步骤文本里的 `${secret.*}` 在执行前会被解析成明文，而那些明文会
 * 出现在提示词里。仓库里已经有 `redact()` 在做这件事（日志与报告都过它），
 * 这里用的是同一个函数——**掩码规则只有一份**，否则日志里抹掉的东西会从追踪里漏出去。
 */

/** 进程级状态。SDK 只能起一次。 */
let sdk: NodeSDK | undefined;
let enabled = false;

/** 要抹掉的明文。由拥有环境绑定的那一侧登记（网关知道，harness-core 不知道）。 */
let secretValues: string[] = [];

/**
 * 登记这次要抹掉的明文。
 *
 * 累加而不是替换：一次运行可能依次解析多个环境的凭证，而后一个环境不该让前一个的
 * 明文重新可见。去重且丢掉空串——空串会让 `redact` 把每个字符之间都插一遍掩码。
 */
export function addTracingSecrets(values: Iterable<string>): void {
  const next = new Set(secretValues);
  for (const v of values) if (v && v.length >= 4) next.add(v);
  secretValues = [...next];
}

export function isTracingEnabled(): boolean {
  return enabled;
}

export interface TracingOptions {
  /** 这个进程叫什么。出现在 Langfuse 的 resource 上，用来分辨网关 / agent / runner。 */
  service: string;
  /** 覆盖环境变量里的环境名。 */
  environment?: string;
  /** 版本号，跟着发布走。 */
  release?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * 起追踪。没有密钥就什么都不做，并说明为什么——一个「静默关闭」的可观测性系统，
 * 排查起来比没有还慢：人会以为它开着。
 */
export function startTracing(opts: TracingOptions): { enabled: boolean; reason?: string } {
  if (sdk) return { enabled };
  const env = opts.env ?? process.env;
  const publicKey = env.LANGFUSE_PUBLIC_KEY;
  const secretKey = env.LANGFUSE_SECRET_KEY;
  // `LANGFUSE_BASE_URL` 是文档里的名字；SDK 读的是 `LANGFUSE_BASE_URL`，
  // 但 CLI 一侧的文档同时提到 `LANGFUSE_HOST`。两个都认，缺一个就补另一个，
  // 免得「设了一个名字、另一半工具链看不见」这种只在半条链路上出现的故障。
  if (env.LANGFUSE_BASE_URL && !env.LANGFUSE_HOST) env.LANGFUSE_HOST = env.LANGFUSE_BASE_URL;
  if (env.LANGFUSE_HOST && !env.LANGFUSE_BASE_URL) env.LANGFUSE_BASE_URL = env.LANGFUSE_HOST;

  if (!publicKey || !secretKey) {
    enabled = false;
    return {
      enabled: false,
      reason:
        "LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY 没有设置——追踪整个关闭（不是「开着但发不出去」）",
    };
  }

  try {
    const processor = new LangfuseSpanProcessor({
      /**
       * 掩码用的是这个仓库自己那份 `redact`。
       *
       * 分两份实现的后果是可预见的：日志里抹掉的东西会从追踪里漏出去，
       * 而且要过很久才有人发现——因为两边看起来都「有掩码」。
       */
      mask: ({ data }) => (secretValues.length ? redact(data, secretValues) : data),
      environment: opts.environment ?? env.LANGFUSE_TRACING_ENVIRONMENT ?? "development",
    });
    sdk = new NodeSDK({
      serviceName: `testpilot-${opts.service}`,
      spanProcessors: [processor],
    });
    sdk.start();
    enabled = true;
    return { enabled: true };
  } catch (e) {
    // 起不来就当没有。见纪律②。
    sdk = undefined;
    enabled = false;
    return { enabled: false, reason: `Langfuse 起不来，追踪关闭：${(e as Error).message}` };
  }
}

/**
 * 关闭并冲刷。
 *
 * 这个必须接到每个进程的退出路径上：SDK 是异步批处理的，直接 exit 会把最后一批
 * span 丢掉——而那一批恰好是最有意思的，因为进程退出往往是因为出事了。
 */
export async function shutdownTracing(): Promise<void> {
  if (!sdk) return;
  const s = sdk;
  sdk = undefined;
  enabled = false;
  await s.shutdown().catch(() => undefined);
}

/** Langfuse 的观测类型。取值来自 docs/observability/features/observation-types。 */
export type ObservationType =
  | "span"
  | "generation"
  | "agent"
  | "tool"
  | "chain"
  | "retriever"
  | "evaluator"
  | "embedding"
  | "guardrail"
  | "event";

export interface ObserveOptions {
  asType?: ObservationType;
  input?: unknown;
  metadata?: Record<string, unknown>;
  /** 只在根观测上给：它决定整条 trace 的名字与归属。 */
  trace?: {
    name?: string;
    sessionId?: string;
    userId?: string;
    tags?: string[];
    version?: string;
    /** 由外部 id 推出来的确定性 trace id，见 `traceIdFor`。 */
    traceId?: string;
  };
}

/** 一个可以被更新和结束的观测。关掉追踪时是一个什么也不做的壳。 */
export interface Observation {
  update(attrs: Record<string, unknown>): void;
  end(): void;
}

const NOOP: Observation = { update: () => undefined, end: () => undefined };

/**
 * 由一个外部 id 算出确定性的 trace id。
 *
 * 这里的外部 id 是 `wfRunId`。有了它，网关不必等 agent 回话就能拼出这次运行在 Langfuse
 * 上的地址——「去看这次运行」变成一个链接，而不是一次搜索。
 */
export async function traceIdFor(seed: string): Promise<string | undefined> {
  if (!enabled) return undefined;
  try {
    return await createTraceId(seed);
  } catch {
    return undefined;
  }
}

/**
 * 在一个观测里跑一段异步逻辑。
 *
 * 用 active 版本，于是**里面再创建的观测会自动挂到它下面**——模型调用不需要知道自己
 * 在哪个节点里，OTEL 的上下文会告诉它。这正是节点包一层、生成再包一层就能得到
 * 正确树形的原因。
 */
export async function observe<T>(
  name: string,
  opts: ObserveOptions,
  fn: (obs: Observation) => Promise<T>,
): Promise<T> {
  if (!enabled) return fn(NOOP);
  try {
    /**
     * SDK 按 `asType` 做了一族重载，每种类型对应不同的属性类型和回调参数类型。
     * 这里的 `asType` 是运行时才知道的（节点自己声明的），所以重载在这一点上必然解不开。
     *
     * **只在这一个地方转型**，转完之后对外仍然是 `Observation` 这个窄接口——
     * 把 `as never` 撒到每个调用点，等于把类型检查在整条链路上都关掉了。
     */
    const startActive = startActiveObservation as unknown as (
      name: string,
      cb: (span: { update(a: Record<string, unknown>): void }) => Promise<T>,
      options: { asType: ObservationType },
    ) => Promise<T>;

    const run = async (): Promise<T> =>
      startActive(
        name,
        async (span) => {
          const wrapped: Observation = {
            update: (attrs) => {
              try {
                span.update(attrs);
              } catch {
                /* 见纪律② */
              }
            },
            // active 版本自己会结束，这里不重复 end
            end: () => undefined,
          };
          if (opts.input !== undefined || opts.metadata)
            wrapped.update({ ...(opts.input !== undefined ? { input: opts.input } : {}), ...(opts.metadata ? { metadata: opts.metadata } : {}) });
          return fn(wrapped);
        },
        { asType: opts.asType ?? "span" },
      );

    if (!opts.trace) return await run();
    // trace 级属性只在根观测上设一次，然后由 OTEL 的 baggage 往下带。
    return await propagateAttributes(
      {
        ...(opts.trace.name ? { traceName: opts.trace.name } : {}),
        ...(opts.trace.sessionId ? { sessionId: opts.trace.sessionId } : {}),
        ...(opts.trace.userId ? { userId: opts.trace.userId } : {}),
        ...(opts.trace.tags?.length ? { tags: opts.trace.tags } : {}),
        ...(opts.trace.version ? { version: opts.trace.version } : {}),
      },
      run,
    );
  } catch (e) {
    // 追踪层自己炸了不能带走这次运行。但 `fn` 抛出来的必须原样往上传——
    // 那是真的业务失败，吞掉它才是灾难。
    if ((e as { __tp_from_fn?: boolean }).__tp_from_fn) throw e;
    throw e;
  }
}

/**
 * 把一个可能很大的值裁成适合放进 trace 的形状。
 *
 * 这个仓库的节点产物是真的大：一份 `CaseBundle` 带着 40 条用例、一份规格正文几万字、
 * 一次执行结果里挂着 base64 的整屏截图。原样送进 trace 有两个后果，而且都不是「慢一点」
 * 这么温和——**导出批次被撑爆导致整条 trace 丢失**，以及**界面上根本打不开**。
 *
 * 所以裁，但**必须留下「这里被裁过」的痕迹**：一个悄悄截断的输出，读的人会当成
 * 模型只产出了这么多。这正是这条流水线在 `maxTokens` 上栽过四次的那个形状——
 * 截断的产出从外面看只是「短了一点」。
 */
export function forTrace(value: unknown, maxChars = 12_000): unknown {
  if (value === undefined || value === null) return value;
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    return { __unserializable: true };
  }
  if (json === undefined) return undefined;
  if (json.length <= maxChars) return value;
  return {
    __truncatedForTrace: true,
    originalChars: json.length,
    keptChars: maxChars,
    note: "完整产物在 events.db 与 wf_node_outputs 里；这里只留开头，用于在 trace 上认出它是什么",
    preview: json.slice(0, maxChars),
  };
}

/**
 * 手工开一个观测，调用方负责 `end()`。
 *
 * 模型调用用这个而不是 active 版本：一次调用的开始和结束在同一个函数里，
 * 而且它**不该改变活动上下文**——它是一片叶子，下面不会再有东西挂进来。
 */
export function beginObservation(
  name: string,
  attrs: Record<string, unknown>,
  asType: ObservationType = "span",
): Observation {
  if (!enabled) return NOOP;
  try {
    const span = startObservation(name, attrs as never, { asType } as never);
    return {
      update: (a) => {
        try {
          (span as unknown as { update(x: unknown): void }).update(a);
        } catch {
          /* 见纪律② */
        }
      },
      end: () => {
        try {
          (span as unknown as { end(): void }).end();
        } catch {
          /* 见纪律② */
        }
      },
    };
  } catch {
    return NOOP;
  }
}
