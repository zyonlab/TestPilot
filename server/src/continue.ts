import { getGraph, getGraphVersion, listGraphs, nodeOutput, outputStore, registry, startRun } from "./graphs.js";
import type { GraphDef } from "@testpilot/harness-core";

/**
 * 接着往下跑：把一次运行的产物，作为另一张图的输入。
 *
 * 阶段一（读规格 → 拆故事 → 出用例 → 门禁①）和阶段二（生成代码 → 门禁② → 修复环）是两张图。
 * 这是有意为之——两段各自迭代、各自评测，把它们焊死成一张图，就没法只重跑后半段。
 * 代价是界面上出现了一道看不见的坎：一次运行跑到 `gate` 就结束了，而人自然会问「然后呢」。
 *
 * 运行时本来就支持给根节点喂一份种子（`startRun({ seed })`），缺的只是把这件事说出来：
 * **哪几张图能接着这次运行跑**，以及一个按钮。
 *
 * 判定方式是类型，不是名字：这次运行末端节点的 `outKind`，对上另一张图根节点的 `inKind`。
 * 写死「g1 之后是 g2」也能work，但那样每加一张图就要再改一次这里。
 */

/** 图里没有出边的节点——一次运行的产物就是它们产出的。 */
function terminals(def: GraphDef): string[] {
  const hasOut = new Set(def.edges.map((e) => e.from));
  return def.nodes.filter((n) => !hasOut.has(n.id)).map((n) => n.id);
}

/** 图的根节点：没有入边的那个。 */
function roots(def: GraphDef): string[] {
  const hasIn = new Set(def.edges.map((e) => e.to));
  return def.nodes.filter((n) => !hasIn.has(n.id)).map((n) => n.id);
}

const kindOf = (type: string) => registry.list().find((n) => n.type === type);

function defOfRun(runId: string): { def: GraphDef; graphId: string } | undefined {
  const row = outputStore.getRun(runId);
  if (!row) return undefined;
  const graphId = String(row.graphId);
  const version = Number(row.graphVersion);
  // The version the run actually used, not today's — a graph edited since would otherwise
  // decide what its own older runs may continue into.
  const def = getGraphVersion(graphId, version) ?? getGraph(graphId);
  return def ? { def, graphId } : undefined;
}

export interface Continuation {
  graphId: string;
  /** 这次运行的哪个节点的产物会被喂进去。 */
  fromNode: string;
  /** 喂给对方的哪个节点。 */
  intoNode: string;
  kind: string;
  /** 该产物是否真的存在——跑失败的运行没有可接着跑的东西。 */
  ready: boolean;
}

/** 哪几张图能接着这次运行跑。 */
export async function continuationsFor(runId: string): Promise<Continuation[]> {
  const source = defOfRun(runId);
  if (!source) return [];

  const out: Continuation[] = [];
  for (const tail of terminals(source.def)) {
    const tailType = source.def.nodes.find((n) => n.id === tail)?.type ?? "";
    const produces = kindOf(tailType)?.outKind;
    if (!produces) continue;
    const value = await nodeOutput(runId, tail).catch(() => undefined);

    for (const other of listGraphs()) {
      if (other.id === source.graphId) continue;
      for (const root of roots(other)) {
        const rootType = other.nodes.find((n) => n.id === root)?.type ?? "";
        if (kindOf(rootType)?.inKind !== produces) continue;
        out.push({
          graphId: other.id,
          fromNode: tail,
          intoNode: root,
          kind: produces,
          ready: value !== undefined,
        });
      }
    }
  }
  return out;
}

/**
 * 起一次接着跑的运行。
 *
 * 目标端跟着源运行走：接着跑出来的代码属于同一个项目，让人再选一次只会让两半落在不同地方。
 */
/**
 * `params` 是给续跑用的覆盖值。
 *
 * 没有它的时候，续跑只能照抄图里写死的参数——而 `g2-code` 的 `repair` 节点写着
 * `{ maxRounds: 1, limit: 3 }`，那是开发期为了省钱定的。于是「把这批用例整套跑一遍」
 * 这件事，在界面和 API 上都做不到，只能去改图。
 *
 * 而整套跑一遍恰恰是下一步（黑盒变异测试）的前提：它要拿同一套用例反复打不同的变异体。
 */
export async function continueRun(
  runId: string,
  graphId: string,
  params?: Record<string, Record<string, unknown>>,
): Promise<{ wfRunId: string }> {
  const options = await continuationsFor(runId);
  const pick = options.find((o) => o.graphId === graphId);
  if (!pick) throw new Error(`${graphId} 接不上这次运行：它的根节点要的输入类型对不上`);
  if (!pick.ready) throw new Error(`这次运行没有产出 ${pick.fromNode} 的结果，没有可以接着跑的东西`);

  const seed = await nodeOutput(runId, pick.fromNode);
  const previous = (outputStore.getRun(runId)?.detail ?? {}) as { target?: { projectId?: string; url?: string } };
  const started = await startRun({ graphId, seed, target: previous.target, ...(params ? { params } : {}) });
  return { wfRunId: started.wfRunId };
}
