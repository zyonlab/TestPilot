import { resolve } from "node:path";
import {
  EventKind,
  NodeRegistry,
  SqliteOutputStore,
  gated,
  modelFromEnv,
  parseAblation,
  registerPack,
  runGraph,
  setModelLease,
  forTrace,
  observe,
  shutdownTracing,
  startChild,
  startTracing,
  traced,
  type GraphDef,
  type GraphRunResult,
  type RunMode,
} from "@testpilot/harness-core";
import { testingPack, type CaseExecutor, type ProductObserver } from "@testpilot/harness-testing";

/**
 * The agent process: owner of the graph runtime.
 *
 * It runs the workflow and owns the node outputs; it does not own the database, the
 * environment bindings or the browsers. Anything it needs from those it asks the gateway
 * for — which is also why the gateway can restart the browser side without disturbing a
 * run that is twenty minutes in.
 */

const REPO_ROOT = process.env.TP_REPO_ROOT ?? resolve(process.cwd(), "..", "..");
const WF_DB = process.env.TP_WF_DB ?? resolve(REPO_ROOT, "server", ".data", "workflows.db");

interface StartInput {
  def: GraphDef;
  wfRunId?: string;
  mode?: RunMode;
  seed?: unknown;
  breakpoints?: string[];
  ablate?: string[];
  budget?: { calls?: number; usd?: number; ms?: number };
  /** 这次运行在这一段之前已经花掉的——续跑时上限必须还是整次运行的上限。 */
  spent?: { calls?: number; tokens?: number; usd?: number; ms?: number };
  /** Opaque here: it is handed straight back to the gateway with each execution. */
  target?: unknown;
  /** 追踪归属：哪些运行算一组、打什么标签。网关决定。 */
  trace?: { sessionId?: string; tags?: string[] };
  scope?: Record<string, string>;
}

/**
 * 追踪要在**建任何模型客户端之前**起来。
 *
 * 顺序不是形式：`traced()` 在包的时候会读一次开关，而 OTEL 的 span 处理器要先注册，
 * 后面创建的 span 才有地方去。这个进程是图运行时的宿主，也就是绝大多数模型调用发生的
 * 地方——它没起来，trace 上就只剩网关那几次零散调用。
 *
 * 环境变量是从网关继承来的（监工 fork 时带 `...process.env`），所以这里不必再读 .env。
 */
const tracing = startTracing({ service: "agent" });

const store = new SqliteOutputStore(WF_DB);
const running = new Map<string, { controller: AbortController; promise: Promise<GraphRunResult> }>();

const child = startChild({
  heartbeatMs: 1000,
  api: {
    capabilities: async () => ({ graph: true, planning: true, eval: false }),

    /** Start a workflow. Returns as soon as it is under way; the rest arrives as events. */
    startRun: async (input: StartInput): Promise<{ wfRunId: string }> => {
      const wfRunId = input.wfRunId ?? `wf-${Date.now().toString(36)}`;
      const { on, unknown } = parseAblation(input.ablate);
      if (unknown.length) throw new Error(`unknown ablation switch(es): ${unknown.join(", ")}`);

      const controller = new AbortController();
      const registry = buildRegistry(input.target, wfRunId);
      child.setTask(`run ${wfRunId}`);

      const promise = runGraph(input.def, {
        registry,
        // The bus lives in the gateway; `emit` is the same one-way channel the runner uses.
        bus: forwarder,
        store,
        wfRunId,
        input: input.seed,
        mode: input.mode,
        breakpoints: input.breakpoints,
        ablate: on,
        budget: input.budget,
        spent: input.spent,
        signal: controller.signal,
        scope: input.scope,
        /**
         * 谁和谁算一组，由网关说了算——它才知道这次是一条普通运行还是一次配对评测的一臂。
         * 见 `RunGraphOptions.trace`。
         */
        trace: {
          ...(input.trace?.sessionId ? { sessionId: input.trace.sessionId } : {}),
          ...(input.trace?.tags?.length ? { tags: input.trace.tags } : {}),
        },
      }).finally(() => {
        running.delete(wfRunId);
        if (!running.size) child.setTask("idle");
      });
      promise.catch(() => undefined);
      running.set(wfRunId, { controller, promise });
      return { wfRunId };
    },

    cancelRun: async (wfRunId: string): Promise<boolean> => {
      const run = running.get(wfRunId);
      run?.controller.abort();
      return !!run;
    },

    activeRuns: async (): Promise<string[]> => [...running.keys()],

    /** Node outputs live with the runtime; the gateway reads them through here. */
    nodeOutput: async (wfRunId: string, nodeId: string): Promise<unknown> =>
      store.get(wfRunId, nodeId),
    allOutputs: async (wfRunId: string): Promise<Record<string, unknown>> => store.all(wfRunId),
  },
  onShutdown: () => {
    for (const run of running.values()) run.controller.abort();
    child.emit(EventKind.log, { stream: "agent", text: "agent draining" });
    /**
     * **冲刷是必须的。** SDK 是异步批处理的，直接退出会丢掉最后一批 span——
     * 而那一批恰好最有价值，因为进程退出往往是因为出了事。
     */
    void shutdownTracing();
  },
});

/**
 * The bus, as seen from here: publishing means telling the gateway. Only `publish` is used
 * by the runtime, so the rest of the interface is deliberately absent rather than faked.
 */
const forwarder = {
  publish: (kind: string, payload: unknown, scope?: Record<string, string>) => {
    child.emit(kind, payload, scope);
    return { v: 1 as const, id: 0, ts: new Date().toISOString(), scope: scope ?? {}, kind, payload };
  },
  subscribe: () => ({ close: () => undefined }),
  head: () => 0,
  replay: () => [],
  close: () => undefined,
} as unknown as Parameters<typeof runGraph>[1]["bus"];

// Model admission is global and lives in the gateway: this process borrows a slot per call.
setModelLease(async (fn) => {
  const ticket = (await child.parent.acquireModel()) as unknown as number;
  try {
    return await fn();
  } finally {
    void child.parent.releaseModel(ticket as never);
  }
});

/**
 * `traced(gated(...))`，顺序有意义：span 覆盖**排队等准入槽位的时间**，不只是 HTTP 往返。
 * 这条流水线上模型并发是 1–3，G1 那十几次串行调用最长的一段恰恰是排队——
 * 把等待藏起来的延迟数字，会让人去优化模型而不是去优化并发。
 */
const model = traced(gated(modelFromEnv()));

/**
 * Executing a case needs the database (environment, secrets) and a browser (the runner),
 * and this process has neither. So it asks the gateway, which owns both.
 */
function buildRegistry(target: unknown, wfRunId: string): NodeRegistry {
  const executor: CaseExecutor = {
    // `wfRunId` travels with the request so the gateway can file the execution under the
    // run that caused it — otherwise a case exercised only by the repair loop leaves no
    // trace in the project's execution ledger.
    /**
     * 执行一条用例，在追踪上是一次 `tool`。
     *
     * span 开在**这里**而不是 runner 里，是一个有代价的取舍，要说清楚：真正干活的是
     * runner 进程（浏览器、Midscene、视觉模型），而它跨了两次进程边界（agent → 网关 →
     * runner）。把 W3C 上下文一路传过去才能拿到 runner 内部的调用，那是另一件事。
     *
     * 在这一侧开 span，能拿到的是：这条用例跑了多久、判决是什么、失败归到哪一档
     * （infra / locate / assert）——而这三样恰好是读一次运行时最先要看的。拿不到的是
     * Midscene 每一步的视觉模型调用。**这条边界写在这里，免得以后有人对着一条
     * 「执行只有一个 span」的 trace 以为是埋点漏了。**
     */
    run: async (input) =>
      observe(
        "case.execute",
        {
          asType: "tool",
          input: forTrace(input, 4000),
          metadata: { wfRunId },
        },
        async (span) => {
          const out = (await child.parent.execCase({ ...input, target, wfRunId } as never)) as unknown as Awaited<
            ReturnType<CaseExecutor["run"]>
          >;
          const r = out as unknown as { status?: string; failureReason?: string; failure?: { attribution?: string } };
          span.update({
            output: forTrace(out, 6000),
            metadata: { status: r?.status, attribution: r?.failure?.attribution },
            // 判决为「挂了」不等于 ERROR：一条用例发现产品有问题，那是它成功了。
            // 只有基础设施故障才是这次执行自己出了错。
            ...(r?.failure?.attribution === "infra"
              ? { level: "WARNING", statusMessage: String(r?.failureReason ?? "").slice(0, 300) }
              : {}),
          });
          return out;
        },
      ) as unknown as ReturnType<CaseExecutor["run"]> extends Promise<infer T> ? T : never,
  };
  // 同样的道理：看一眼跑着的产品需要浏览器，这个进程没有。
  const observer: ProductObserver = {
    observe: async (input) => {
      // 目标端说的是哪个环境、哪个地址，探索就得去那里。此前这里只转发 projectId，
      // `envRef` 和 `url` 一个都没带过去——网关于是回落到项目的**默认**环境：
      // 一次声明「跑在 bench-juiceshop」的运行，浏览器打开的是 local 的地址、
      // 带的是 local 的请求头和凭证。而产出物看不出任何异常。
      const t = target as { projectId?: string; envRef?: string; url?: string } | undefined;
      return (await child.parent.observeProduct({
        url: t?.url,
        ...input,
        projectId: t?.projectId,
        envRef: t?.envRef,
      } as never)) as unknown as Awaited<ReturnType<ProductObserver["observe"]>>;
    },
  };
  const registry = new NodeRegistry();
  registerPack(registry, testingPack({ model, executor, observer, baseDir: REPO_ROOT }));
  return registry;
}

child.setTask("idle");
child.emit(EventKind.log, {
  stream: "agent",
  text:
    `agent ${child.id} up (graph runtime ready)` +
    // 说出来它是开是关。一个「静默关闭」的可观测性系统，排查起来比没有还慢——人会以为它开着。
    (tracing.enabled ? "，Langfuse 追踪已开" : `，Langfuse 追踪关闭：${tracing.reason ?? "未配置"}`),
});
