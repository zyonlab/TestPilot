import { EventKind } from "../obs/envelope.js";
import type { EventBus } from "../obs/bus.js";
import type { Scope } from "../obs/envelope.js";
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

      const raw = await nodeDef.run(parsedInput.data, parsedParams.data, ctx);
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
