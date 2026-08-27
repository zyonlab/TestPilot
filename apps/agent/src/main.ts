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
  startChild,
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
  scope?: Record<string, string>;
}

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

const model = gated(modelFromEnv());

/**
 * Executing a case needs the database (environment, secrets) and a browser (the runner),
 * and this process has neither. So it asks the gateway, which owns both.
 */
function buildRegistry(target: unknown, wfRunId: string): NodeRegistry {
  const executor: CaseExecutor = {
    // `wfRunId` travels with the request so the gateway can file the execution under the
    // run that caused it — otherwise a case exercised only by the repair loop leaves no
    // trace in the project's execution ledger.
    run: async (input) =>
      (await child.parent.execCase({ ...input, target, wfRunId } as never)) as unknown as ReturnType<
        CaseExecutor["run"]
      > extends Promise<infer T>
        ? T
        : never,
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
child.emit(EventKind.log, { stream: "agent", text: `agent ${child.id} up (graph runtime ready)` });
