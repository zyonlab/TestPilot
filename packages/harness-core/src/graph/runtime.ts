import { EventKind } from "../obs/envelope.js";
import type { EventBus } from "../obs/bus.js";
import type { Scope } from "../obs/envelope.js";
import { forTrace, observe } from "../obs/langfuse.js";
import { ZERO_SPEND, type Spend } from "../harness/protocol.js";
import { downstreamOf, topoOrder, upstreamOf, validateGraph, type GraphDef } from "./graph.js";
import type { NodeContext, NodeRegistry } from "./node.js";

/**
 * Node outputs, kept per workflow run.
 *
 * This is what makes the three debugging modes possible: "run only this node" needs its
 * upstream's last output, and "resume" needs everything already computed. It doubles as
 * what the canvas shows when you click a node.
 */
export interface OutputStore {
  get(wfRunId: string, nodeId: string): Promise<unknown | undefined>;
  set(wfRunId: string, nodeId: string, value: unknown): Promise<void>;
  all(wfRunId: string): Promise<Record<string, unknown>>;
}

export class MemoryOutputStore implements OutputStore {
  private runs = new Map<string, Map<string, unknown>>();
  async get(wfRunId: string, nodeId: string) {
    return this.runs.get(wfRunId)?.get(nodeId);
  }
  async set(wfRunId: string, nodeId: string, value: unknown) {
    const run = this.runs.get(wfRunId) ?? new Map<string, unknown>();
    run.set(nodeId, value);
    this.runs.set(wfRunId, run);
  }
  async all(wfRunId: string) {
    return Object.fromEntries(this.runs.get(wfRunId) ?? new Map());
  }
}

export type RunMode =
  /** Everything, in order. */
  | { kind: "full" }
  /** One node, fed from the stored output of its upstream. Debug mode ②/①. */
  | { kind: "only"; node: string }
  /** That node and everything downstream of it, upstream taken from the store. Debug mode ③. */
  | { kind: "from"; node: string };

export interface RunGraphOptions {
  registry: NodeRegistry;
  bus: EventBus;
  /** Reused across runs to keep node outputs; a fresh one means "start clean". */
  store?: OutputStore;
  /** Seed for source nodes. */
  input?: unknown;
  wfRunId?: string;
  scope?: Scope;
  mode?: RunMode;
  /** Pause BEFORE these nodes, leaving the run resumable. */
  breakpoints?: string[];
  ablate?: Iterable<string>;
  signal?: AbortSignal;
  /** Stop once spend crosses one of these. "Exhausted" is a different ending from "done". */
  budget?: Partial<Pick<Spend, "calls" | "usd" | "ms">>;
  /**
   * What this run had already spent before this segment started.
   *
   * A run that stopped at its cap and was resumed is **one** run, and its cap has to mean
   * the same thing after the resume as before it. Without this the counter restarted at
   * zero every time: the cap silently became "per resume", and the run's recorded cost came
   * out lower than what it actually cost — a report that understates spend is worse than
   * no report, because it reads as a measurement.
   */
  spent?: Partial<Spend>;
  /**
   * 追踪上的归属信息。**由调用方给，因为 harness-core 不知道什么东西该被归到一起。**
   *
   * 一次配对评测的两条臂属于同一个 session（它们是同一个问题的两半），
   * 而一次普通运行属于它的项目。这两种归法都对，但只有网关知道这次是哪一种——
   * 在这里替它猜，就等于把一个业务判断写死进了运行时。
   */
  trace?: { sessionId?: string; userId?: string; tags?: string[] };
}

export interface NodeRunRecord {
  nodeId: string;
  type: string;
  status: "done" | "failed" | "skipped";
  ms: number;
  spend: Spend;
  error?: string;
}

export interface GraphRunResult {
  wfRunId: string;
  graph: { id: string; version: number };
  status: "done" | "paused" | "failed" | "cancelled" | "budget";
  outputs: Record<string, unknown>;
  nodes: NodeRunRecord[];
  spend: Spend;
  pausedAt?: string;
  ablated: string[];
  error?: { node: string; message: string };
}

let seq = 0;
const newRunId = (): string => `wf-${Date.now().toString(36)}-${++seq}`;

/**
 * The graph runtime: a DAG walked in a stable order, one node at a time.
 *
 * It is written here rather than on top of a workflow library because of what this
 * project actually asks of it — partial re-runs from any node, per-node output caching for
 * the canvas, version-pinned reproducibility — and because the harness philosophy puts
 * loops *inside* nodes (a bounded repair loop is a node, not a cycle in the graph). What a
 * library would have added is checkpointing, which the output store already provides.
 */
export async function runGraph(def: GraphDef, opts: RunGraphOptions): Promise<GraphRunResult> {
  const issues = validateGraph(def, opts.registry);
  if (issues.length)
    throw new Error(`graph ${def.id}@${def.version} is invalid: ${issues.map((i) => i.message).join("; ")}`);

  const wfRunId = opts.wfRunId ?? newRunId();
  const store = opts.store ?? new MemoryOutputStore();
  const scope: Scope = { ...opts.scope, wfRunId };
  const ablated = new Set(opts.ablate ?? []);
  const mode = opts.mode ?? { kind: "full" };
  const breakpoints = new Set(opts.breakpoints ?? []);
  // Asking for a node by name is a decision to run it, so its own breakpoint does not
  // stand in the way — otherwise "continue" would stop in front of the same node forever.
  const askedFor = mode.kind === "full" ? undefined : mode.node;
  const startedMs = Date.now();

  const order =
    mode.kind === "full"
      ? topoOrder(def)
      : mode.kind === "from"
        ? downstreamOf(def, mode.node)
        : [mode.node];

  // 从上一段接着算，而不是从零。见 RunGraphOptions.spent。
  const spend: Spend = { ...ZERO_SPEND, ...opts.spent };
  const spentMsBefore = opts.spent?.ms ?? 0;
  const nodes: NodeRunRecord[] = [];
  const outputs: Record<string, unknown> = await store.all(wfRunId);

  opts.bus.publish(
    EventKind.wfRunStarted,
    { graphId: def.id, graphVersion: def.version, mode, nodes: order, ablated: [...ablated] },
    scope,
  );

  const finish = (
    status: GraphRunResult["status"],
    extra: Partial<GraphRunResult> = {},
  ): GraphRunResult => {
    spend.ms = spentMsBefore + (Date.now() - startedMs);
    const result: GraphRunResult = {
      wfRunId,
      graph: { id: def.id, version: def.version },
      status,
      outputs,
      nodes,
      spend,
      ablated: [...ablated],
      ...extra,
    };
    opts.bus.publish(
      EventKind.wfRunFinished,
      { status, spend, pausedAt: result.pausedAt, error: result.error, nodes },
      scope,
    );
    return result;
  };

  /**
   * 走一遍图。抽成一个闭包，是为了让整次运行能被一个根观测包住——
   * 循环里有五个提前 return（取消、断点、预算、上游缺产物、节点失败），
   * 而其中四个都不是「失败」，却都必须让根观测正确收尾。
   */
  const walk = async (): Promise<GraphRunResult> => {
  for (const nodeId of order) {
    if (opts.signal?.aborted) return finish("cancelled");
    if (breakpoints.has(nodeId) && nodeId !== askedFor) {
      opts.bus.publish(EventKind.wfPaused, { nodeId, reason: "breakpoint" }, { ...scope, nodeRunId: nodeId });
      return finish("paused", { pausedAt: nodeId });
    }
    const exhausted = overBudget(spend, startedMs - spentMsBefore, opts.budget);
    if (exhausted) {
      // "Ran out of budget" and "finished the work" are different endings, and a report
      // that conflates them invites reading a partial result as a complete one.
      opts.bus.publish(EventKind.wfPaused, { nodeId, reason: `budget:${exhausted}` }, scope);
      return finish("budget", { pausedAt: nodeId });
    }

    const node = def.nodes.find((n) => n.id === nodeId)!;
    const nodeDef = opts.registry.get(node.type)!;
    const upstreamId = upstreamOf(def, nodeId);
    const rawInput = upstreamId === undefined ? opts.input : outputs[upstreamId];

    if (upstreamId !== undefined && rawInput === undefined) {
      const message = `no stored output from ${upstreamId}; run it first`;
      nodes.push({ nodeId, type: node.type, status: "skipped", ms: 0, spend: { ...ZERO_SPEND }, error: message });
      return finish("failed", { error: { node: nodeId, message } });
    }

    const nodeScope: Scope = { ...scope, nodeRunId: `${wfRunId}:${nodeId}` };
    opts.bus.publish(EventKind.wfNodeStarted, { nodeId, type: node.type }, nodeScope);

    const nodeSpend: Spend = { ...ZERO_SPEND };
    const at = Date.now();
    const ctx: NodeContext = {
      nodeId,
      emit: (kind, payload, extra) => opts.bus.publish(kind, payload, { ...nodeScope, ...extra }),
      spend: (delta) => {
        nodeSpend.calls += delta.calls ?? 0;
        nodeSpend.tokens += delta.tokens ?? 0;
        nodeSpend.usd += delta.usd ?? 0;
        spend.calls += delta.calls ?? 0;
        spend.tokens += delta.tokens ?? 0;
        spend.usd += delta.usd ?? 0;
        /*
         * 花费**在节点跑着的时候**就播出去。
         *
         * 此前数字只在节点 finished 时才刷新，于是一个跑六分钟的节点内部纹丝不动——
         * 看起来像卡死了。`budget.update` 这个 kind 早就声明了，全项目却搜不到第二处：
         * 无人发布，也就无人消费。这里是那个发布点。
         *
         * 它在 COALESCED_KINDS 里，所以每次模型调用都发也不会把界面刷爆；
         * 而 lineage 那一侧从不合并，账仍然是全的。
         */
        opts.bus.publish(
          EventKind.budgetUpdate,
          {
            nodeId,
            node: { ...nodeSpend, ms: Date.now() - at },
            total: { ...spend, ms: spentMsBefore + (Date.now() - startedMs) },
            budget: opts.budget,
          },
          nodeScope,
        );
      },
      signal: opts.signal ?? new AbortController().signal,
      ablated,
    };

    try {
      const parsedInput = nodeDef.input.safeParse(rawInput);
      if (!parsedInput.success)
        throw new Error(`input does not match ${node.type}: ${issueText(parsedInput.error.issues)}`);
      const parsedParams = nodeDef.params.safeParse(node.params ?? {});
      if (!parsedParams.success)
        throw new Error(`params do not match ${node.type}: ${issueText(parsedParams.error.issues)}`);

      /**
       * 节点包一层观测。用 active 版本，于是**这个节点里发出的每一次模型调用会自动挂进来**
       * ——`traced()` 那一层不需要知道自己在哪个节点里，OTEL 的上下文会告诉它。
       * 这就是「节点包一层、生成再包一层」能得到正确树形的全部机制。
       *
       * 名字用 `node.type`（`design.cases`）而不是 `nodeId`：名字要低基数，
       * 它是拿来筛选、建看板、挂评测的。实例 id 进 metadata。
       */
      const raw = await observe(
        node.type,
        {
          asType: nodeDef.observationType ?? "span",
          input: forTrace(parsedInput.data),
          metadata: {
            nodeId,
            graphId: def.id,
            graphVersion: def.version,
            params: forTrace(parsedParams.data, 4000),
            ...(ablated.size ? { ablated: [...ablated] } : {}),
          },
        },
        async (span) => {
          const out = await nodeDef.run(parsedInput.data, parsedParams.data, ctx);
          span.update({
            output: forTrace(out),
            metadata: { spend: { ...nodeSpend }, ms: Date.now() - at },
          });
          return out;
        },
      );
      const parsedOut = nodeDef.output.safeParse(raw);
      // A node whose output does not match its own contract is a bug that must stop here:
      // downstream nodes were connected on the strength of that contract.
      if (!parsedOut.success)
        throw new Error(`output does not match ${node.type}: ${issueText(parsedOut.error.issues)}`);

      const out = parsedOut.data;
      outputs[nodeId] = out;
      await store.set(wfRunId, nodeId, out);
      nodeSpend.ms = Date.now() - at;
      nodes.push({ nodeId, type: node.type, status: "done", ms: nodeSpend.ms, spend: { ...nodeSpend } });
      opts.bus.publish(
        EventKind.wfNodeFinished,
        { nodeId, type: node.type, status: "done", ms: nodeSpend.ms, spend: nodeSpend },
        nodeScope,
      );
    } catch (e) {
      const message = (e as Error).message;
      nodeSpend.ms = Date.now() - at;
      nodes.push({ nodeId, type: node.type, status: "failed", ms: nodeSpend.ms, spend: { ...nodeSpend }, error: message });
      opts.bus.publish(
        EventKind.wfNodeFinished,
        { nodeId, type: node.type, status: "failed", ms: nodeSpend.ms, error: message },
        nodeScope,
      );
      // Failure stops the branch it is on. With one input per node, that is the whole
      // remaining line — carrying on would hand the next node an input that never existed.
      return finish("failed", { error: { node: nodeId, message } });
    }
  }

  return finish("done");
  };

  /**
   * 整次运行是一条 trace。
   *
   * 这个边界是照着 Langfuse 的口径挑的——「一条 trace 是一个自成一体的工作单元」，
   * 一次流水线执行正好是。往上并到「一个项目」会让一条 trace 长到读不动；
   * 往下拆到「一个节点」则丢掉了这条流水线最要紧的性质：**上游的产物决定下游的输入**，
   * 而跨节点的因果正是要看的东西。
   *
   * 根观测报 `span` 而不是 `agent`：这一层就是一条确定性的 DAG，不是一个自主循环
   * （见 `casegen/nodes.ts` 的那段说明）。真正是 agent 的只有探索那一个节点，
   * 而它自己声明成 `agent`。**照着代码报，不照着期望报。**
   */
  return observe(
    "workflow.run",
    {
      asType: "span",
      /**
       * 根观测的 input 就是**整条 trace 的 input**——它显示在列表页那一列，评测读它，
       * 数据集实验拿它跨运行对比。所以这里要放「一眼看过去够判断这是哪次运行」的东西，
       * 而不是把种子原样倒出来：多数运行的种子是空的，那一列就会整片空白。
       */
      input: {
        graph: `${def.id}@${def.version}`,
        mode: mode.kind,
        ...(opts.scope?.projectId ? { projectId: opts.scope.projectId } : {}),
        ...(ablated.size ? { ablated: [...ablated] } : {}),
        ...(opts.input === undefined ? {} : { seed: forTrace(opts.input, 4000) }),
      },
      metadata: {
        graphId: def.id,
        graphVersion: def.version,
        wfRunId,
        mode: mode.kind,
        nodes: order,
        ...(ablated.size ? { ablated: [...ablated] } : {}),
        ...(opts.budget ? { budget: opts.budget } : {}),
        ...(opts.breakpoints?.length ? { breakpoints: opts.breakpoints } : {}),
      },
      trace: {
        name: def.id,
        version: String(def.version),
        ...(opts.trace?.sessionId ? { sessionId: opts.trace.sessionId } : {}),
        ...(opts.trace?.userId ? { userId: opts.trace.userId } : {}),
        /**
         * 标签是给横向比较用的维度。消融开关放进标签，是这里最值钱的一条：
         * 它让「关掉 dedupe 的那批运行」在 Langfuse 上变成一个可筛的集合——
         * 而配对评测的两条臂，差别恰恰就是这个。
         */
        tags: [
          `graph:${def.id}`,
          `mode:${mode.kind}`,
          ...[...ablated].map((a) => `ablate:${a}`),
          ...(opts.trace?.tags ?? []),
        ],
      },
    },
    async (root) => {
      const result = await walk();
      root.update({
        output: forTrace({
          status: result.status,
          spend: result.spend,
          pausedAt: result.pausedAt,
          error: result.error,
          nodes: result.nodes.map((n) => ({ nodeId: n.nodeId, status: n.status, ms: n.ms })),
        }),
        // 「跑完了」和「预算花光了」「撞上断点了」在报告里是三件不同的事，
        // 在 trace 上也必须是——只有真的失败才是 ERROR。
        ...(result.status === "failed"
          ? { level: "ERROR", statusMessage: `${result.error?.node}: ${result.error?.message}`.slice(0, 500) }
          : result.status === "budget" || result.status === "cancelled"
            ? { level: "WARNING", statusMessage: `run ended: ${result.status}` }
            : {}),
      });
      return result;
    },
  );
}

/**
 * 花超了没有。
 *
 * `effectiveStartMs` 是把上一段已经耗掉的时间倒推回去之后的起点，所以时间上限和调用、
 * 金额一样是**整次运行**的上限，不是每一段各来一次。
 */
function overBudget(
  spend: Spend,
  effectiveStartMs: number,
  budget: RunGraphOptions["budget"],
): "calls" | "usd" | "ms" | undefined {
  if (!budget) return undefined;
  if (budget.calls !== undefined && spend.calls >= budget.calls) return "calls";
  if (budget.usd !== undefined && budget.usd > 0 && spend.usd >= budget.usd) return "usd";
  if (budget.ms !== undefined && Date.now() - effectiveStartMs >= budget.ms) return "ms";
  return undefined;
}

const issueText = (issues: Array<{ path: PropertyKey[]; message: string }>): string =>
  issues.map((i) => `${i.path.join(".") || "(root)"} ${i.message}`).join("; ");
