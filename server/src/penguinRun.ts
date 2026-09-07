/**
 * 起跑那条路的 Penguin 版本。
 *
 * `penguin.ts` 是**适配层**（只认 Penguin 与磁盘）；这个文件是**接线**：把一次 Penguin session
 * 接到领域服务已有的三样东西上——运行记录（`wf_runs`）、产物存储（`wf_node_outputs`）、
 * 事件总线（`/ws`）。分成两个文件是因为这两件事的寿命不同：适配层要活到 Phase 3 之后，
 * 而接线里对 `outputStore` 的依赖恰恰是 Phase 3 要拆掉的那个（盘点表里 `SqliteOutputStore`
 * 标的是「换」）。
 *
 * ## 为什么产物要回写进 outputStore
 *
 * `review.ts::reviewBatch` 按**节点 id** 读产物（`nodeOutput(wfRunId, "gate")`），
 * `pendingRuns` 还要求运行记录 `status === "done"`。跑完把 `runs/<id>/*.json` 拼成
 * 一份 `GatedBundle` 写到 `"gate"` 这个 id 下，复核那整条路——批次、编辑、重打分、批准进看板
 * ——**一行都不用改**，前端更不用。
 *
 * 反过来说：这里多写了一份，磁盘上那份仍然是原件。审计端点读的是磁盘那份（它跨运行、
 * 跨清库都在），复核读的是库里这份（它要和决定、编辑 join）。两份的**方向**是单向的，
 * 磁盘 → 库，所以不会出现两个真相。
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nodeOutput, outputStore } from "./graphs.js";
import { bus } from "./procs.js";
import {
  AGENT_ID,
  PROJECT_ID,
  defaultWorkspace,
  workspacesDir,
  newRunId,
  publishNodeEvent,
  readRun,
  startRun as penguinStartRun,
  stopWatching,
  watchRun,
  type NodeEvent,
  type RunProducts,
} from "./penguin.js";

/** 这条路的「图 id」。它不是一张图——但运行记录那一列不能空，列表按它分组。 */
export const PENGUIN_GRAPH_ID = "penguin:testpilot-generate";

/** 九步在这一版里叫这几个名字（`packages/testpilot-mcp/src/pipeline.ts` 的 `steps`）。 */
export const PENGUIN_NODES = ["docs", "spec", "stories", "design", "gate"];

export interface PenguinRunTarget {
  projectId?: string;
  envRef?: string;
  url?: string;
}

export interface PenguinStartInput {
  /** 兼容字段：图 id 在这条路上没有意义，收下只是为了请求体一模一样。 */
  graphId?: string;
  target?: PenguinRunTarget;
  /** 最多几条故事。前端的 `params.stories.maxStories` 也认。 */
  limit?: number;
  params?: Record<string, Record<string, unknown>>;
  ablate?: string[];
  budget?: { calls?: number; usd?: number; ms?: number };
  /** 直接指定材料目录 / 工作区（自举与评测用）。 */
  materialsDir?: string;
  workspace?: string;
  /** 自己指定运行 id（配对评测要两条臂对得上号时用）。 */
  wfRunId?: string;
  trace?: { sessionId?: string; tags?: string[] };
}

/**
 * 事件同时用两种 kind 发。
 *
 * 契约 §1 说 `NodeEvent`，任务书说 kind 用 `wf.node`——那是**新**的那一份，
 * 给审计台与断点续跑用。而 `src/lib/wf.ts` 的 `handle()` 今天只认
 * `wf.node.started` / `wf.node.finished`（Phase 2 没动它，那是画布的输入）。
 * 只发新的，画布全灰；只发旧的，契约落空。所以两份都发，**同一件事的两种说法**，
 * 而不是两件事：payload 由同一个 `NodeEvent` 派生，不会各说各话。
 *
 * Phase 3 前端收敛到 `wf.node` 之后，这里删掉下半段即可。
 */
function publishBoth(e: NodeEvent, wfRunId: string, projectId?: string): void {
  publishNodeEvent(e, wfRunId, projectId);
  const nodeScope = {
    ...(projectId ? { projectId } : {}),
    wfRunId,
    // 前端 `traceRowFor` 按 `nodeRunId.split(":").pop()` 取节点名——这个格式是约定，不是巧合。
    nodeRunId: `${wfRunId}:${e.node}`,
  };
  if (e.phase === "start") {
    bus.publish("wf.node.started", { nodeId: e.node, type: e.node }, nodeScope);
    return;
  }
  bus.publish(
    "wf.node.finished",
    {
      nodeId: e.node,
      type: e.node,
      status: e.phase === "error" ? "failed" : "done",
      ms: e.ms ?? 0,
      ...(e.calls !== undefined || e.tokens !== undefined
        ? { spend: { calls: e.calls ?? 0, tokens: e.tokens ?? 0 } }
        : {}),
      ...(e.error ? { error: e.error } : {}),
    },
    nodeScope,
  );
}

/* ── 材料：探索产物 → markdown ────────────────────────────────────────── */

/**
 * 一个项目的材料从哪来。
 *
 * ACME 那个 SUT 有一份人写的 PRD，所以 `materials/` 里躺着 `acme-portal.md`，直接读就行。
 * **Binance 没有。** `demo.binance.com` 是一个别人的产品，规格不存在——能拿到的只有
 * 「探索的时候真的看见了什么」：哪些路由、每个路由上有哪些控件、点了之后到哪。
 *
 * 这正是架构 §5 里那条硬结论：**锚定基底选可执行运行时（DOM / 接口响应），不选可能不全的
 * 规格**（2606.00898：稀疏库 100% 假阳性）。所以这里不去编一份 PRD，而是把探索产物原样
 * 渲染成材料——写出来的用例锚在观察到的控件上，而不是锚在一段想象出来的规格上。
 *
 * 渲染成 **markdown**，不是 JSON：`run_pipeline` 的 `collectMaterials` 只收 `*.md` / `*.txt`
 * （`packages/testpilot-mcp/src/pipeline.ts`）。写成 `.json` 的表现是材料目录非空、
 * 而管线报「没有规格文档」——一条查起来很费时间的空路。
 */
interface ExploreGraph {
  states?: Array<{ id: string; route?: string; title?: string; controls?: string[] }>;
  transitions?: Array<{ from: string; to?: string; ok?: boolean; walked?: boolean; action?: { kind?: string; target?: string } }>;
  stoppedBecause?: string;
}

/** 这个项目最近一次跑出过探索产物的运行。 */
async function latestExplore(
  projectId: string,
): Promise<{ runId: string; graph?: ExploreGraph; specText?: string } | undefined> {
  const rows = outputStore
    .listRuns(200)
    .filter((r) => String(r.projectId ?? "") === projectId)
    .sort((a, b) => String(b.startedAt ?? "").localeCompare(String(a.startedAt ?? "")));
  for (const r of rows) {
    const id = String(r.id);
    const explore = (await nodeOutput(id, "explore").catch(() => undefined)) as
      | { graph?: ExploreGraph }
      | undefined;
    const spec = (await nodeOutput(id, "spec").catch(() => undefined)) as
      | { text?: string; specText?: string }
      | undefined;
    const graph = explore?.graph;
    const specText = spec?.specText ?? spec?.text;
    if (graph?.states?.length || specText) return { runId: id, graph, specText };
  }
  return undefined;
}

/** 探索出来的状态图 → 一份能读的材料。 */
export function renderObserved(runId: string, graph: ExploreGraph): string {
  const lines = [
    `# 观察到的产品（探索产物 · 运行 ${runId}）`,
    "",
    "> 这份材料不是规格，是**探索的时候真的看见了什么**。下面每一个控件、每一条跳转都被",
    "> 走到过；没走到的不在这里。断言要锚在这里面的东西上——写不出出处的断言就是编的。",
    "",
  ];
  for (const st of graph.states ?? []) {
    const name = st.title || st.id;
    lines.push(`## ${name}${st.route ? ` \`${st.route}\`` : ""}`, "");
    if (st.controls?.length) {
      lines.push("看得见的控件：", "");
      for (const c of st.controls) lines.push(`- ${c}`);
      lines.push("");
    } else {
      lines.push("（这一屏上没有探到控件。）", "");
    }
    const out = (graph.transitions ?? []).filter((t) => t.from === st.id);
    if (out.length) {
      lines.push("从这一屏走出去的：", "");
      for (const t of out) {
        const how = t.action?.kind === "goto" ? `走到 ${t.action?.target ?? "?"}` : `点「${t.action?.target ?? "?"}」`;
        lines.push(`- ${how}${t.to ? ` → ${t.to}` : ""}${t.walked === false ? "（没走到）" : ""}`);
      }
      lines.push("");
    }
  }
  if (graph.stoppedBecause) lines.push(`> 探索停在这里：${graph.stoppedBecause}`, "");
  return lines.join("\n");
}

/**
 * 把这个项目的材料准备到工作区里，返回材料目录。
 *
 * 每次起跑**先清空再写**：材料目录是这次运行的输入，留着上一次的残余会让
 * `materialsHash`（契约 §1 P3 来源印记的一部分）指向一份没人打算跑的混合物。
 * 清的只是本函数生成的那些（`observed-*.md` / `spec-*.md`），人自己放的 `.md` 不动。
 */
export async function prepareMaterials(projectId: string, workspace: string): Promise<string> {
  const dir = join(workspace, "materials");
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(dir))
    if (/^(observed|spec)-.*\.md$/.test(f)) rmSync(join(dir, f), { force: true });

  const found = await latestExplore(projectId);
  if (!found) return dir; // 没探索过：人自己放的材料还在，照跑
  if (found.graph?.states?.length)
    writeFileSync(join(dir, `observed-${found.runId}.md`), renderObserved(found.runId, found.graph));
  if (found.specText)
    writeFileSync(
      join(dir, `spec-${found.runId}.md`),
      `# 整理过的规格（探索产物 · 运行 ${found.runId}）\n\n${found.specText}\n`,
    );
  return dir;
}

/**
 * 起一次 Penguin 运行，立刻返回。
 *
 * 返回形状与 `graphs.ts::startRun` 一致（`{ wfRunId, graph, target }`）——前端只读
 * `wfRunId`，但两条路的返回不一样的话，`TP_RUNTIME` 这个开关就不是一个开关，
 * 而是两套接口。
 */
export async function startRun(
  input: PenguinStartInput = {},
): Promise<{ wfRunId: string; graph: { id: string; version: number; title?: string; nodes: never[]; edges: never[] }; target: PenguinRunTarget }> {
  const target = input.target ?? {};
  const scopeProjectId = target.projectId;
  const runId = input.wfRunId ?? newRunId();
  /**
   * 一个项目一个工作区。
   *
   * 共用一个的话，两个项目的 `materials/` 会互相覆盖——而材料是这次运行的输入，
   * 覆盖的后果不是报错，是「这批用例是照着另一个产品写的」，且看不出来。
   */
  const workspace =
    input.workspace ??
    (scopeProjectId ? join(workspacesDir(), scopeProjectId) : defaultWorkspace());
  const limit =
    input.limit ??
    (typeof input.params?.stories?.maxStories === "number"
      ? (input.params.stories.maxStories as number)
      : typeof input.params?.design?.maxStories === "number"
        ? (input.params.design.maxStories as number)
        : undefined);

  // 挂了项目就用探索产物当材料（Binance 那条路：没有 PRD，只有观察）。
  // 显式指了 materialsDir 的不动——那是调用方自己的决定。
  const materialsDir =
    input.materialsDir ?? (scopeProjectId ? await prepareMaterials(scopeProjectId, workspace) : undefined);

  const startedAt = new Date().toISOString();
  const started = await penguinStartRun({
    workspace,
    ...(materialsDir ? { materialsDir } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(scopeProjectId ? { scopeProjectId } : {}),
    ...(target.envRef ? { envRef: target.envRef } : {}),
    runId,
  });

  outputStore.saveRun({
    id: runId,
    graphId: PENGUIN_GRAPH_ID,
    graphVersion: 1,
    status: "running",
    startedAt,
    detail: {
      runtime: "penguin",
      target,
      // 「看 trace →」的深链就靠这两个。缺了它们，审计台上那一列是死的。
      penguin: {
        sessionId: started.sessionId,
        workspace: started.workspace,
        outDir: started.outDir,
        agentId: AGENT_ID,
        projectId: PROJECT_ID,
        url: `http://127.0.0.1:7364/sessions/${started.sessionId}`,
      },
      ...(input.budget ? { budget: input.budget } : {}),
      ...(input.ablate?.length ? { ablate: input.ablate } : {}),
      ...(input.params ? { requestedOverrides: input.params, paramOverrides: input.params } : {}),
      targetSnapshot: {
        describe: `Penguin · ${AGENT_ID} · ${started.workspace}`,
      },
    },
  });

  bus.publish(
    "wf.run.started",
    {
      graphId: PENGUIN_GRAPH_ID,
      graphVersion: 1,
      mode: { kind: "full" },
      nodes: PENGUIN_NODES,
      ablated: input.ablate ?? [],
      sessionId: started.sessionId,
    },
    { wfRunId: runId, ...(scopeProjectId ? { projectId: scopeProjectId } : {}) },
  );

  watchRun({
    runId,
    sessionId: started.sessionId,
    workspace: started.workspace,
    outDir: started.outDir,
    ...(scopeProjectId ? { scopeProjectId } : {}),
    onEvent: (e) => publishBoth(e, runId, scopeProjectId),
    onDone: (r) => void finish(runId, startedAt, target, r),
  });

  return {
    wfRunId: runId,
    graph: { id: PENGUIN_GRAPH_ID, version: 1, title: "TestPilot · generate（Penguin）", nodes: [], edges: [] },
    target,
  };
}

/**
 * 跑完（或跑挂）之后的三件事：产物入库、运行记录收尾、事件收尾。
 *
 * 顺序不能换：**产物先入库，状态再置 done**。反过来的话，`pendingRuns` 会在产物写进去之前
 * 看到一条 done 的运行，`reviewBatch` 抛「no output」，那一批就从复核队列里静默消失了——
 * 而运行记录上写着它成功了。
 */
async function finish(
  wfRunId: string,
  startedAt: string,
  target: PenguinRunTarget,
  r: { status: "done" | "failed"; error?: string; products?: RunProducts },
): Promise<void> {
  const finishedAt = new Date().toISOString();
  const prev = (outputStore.getRun(wfRunId)?.detail ?? {}) as Record<string, unknown>;
  const products = r.products;

  if (products) {
    // `reviewBatch` 读的就是这个 id。stories 也一并放进去——`GatedBundle` 本来就含它。
    await outputStore.set(wfRunId, "gate", {
      origin: "penguin",
      stories: products.bundle.stories,
      cases: products.bundle.cases,
      gate: products.bundle.gate,
    });
  }

  outputStore.saveRun({
    id: wfRunId,
    graphId: PENGUIN_GRAPH_ID,
    graphVersion: 1,
    status: r.status,
    startedAt,
    finishedAt,
    detail: {
      ...prev,
      target,
      ...(products?.meta ? { meta: products.meta, prompts: products.meta.promptsDigest } : {}),
      ...(products?.spend ? { spend: products.spend } : {}),
      ...(r.error ? { error: r.error } : {}),
    },
  });

  bus.publish(
    "wf.run.finished",
    {
      status: r.status,
      ...(products?.spend ? { spend: products.spend } : {}),
      ...(r.error ? { error: r.error } : {}),
      nodes: PENGUIN_NODES,
      cases: products?.bundle.cases.length ?? 0,
    },
    { wfRunId, ...(target.projectId ? { projectId: target.projectId } : {}) },
  );
}

/** 取消：把看门狗停掉，运行记录标 cancelled。session 本身留给 Penguin 自己收（不杀别人起的进程）。 */
export function cancelRun(wfRunId: string): { result: string } {
  const row = outputStore.getRun(wfRunId);
  if (!row) return { result: "unknown-run" };
  stopWatching(wfRunId);
  outputStore.saveRun({
    id: wfRunId,
    graphId: String(row.graphId ?? PENGUIN_GRAPH_ID),
    graphVersion: Number(row.graphVersion ?? 1),
    status: "cancelled",
    startedAt: String(row.startedAt ?? new Date().toISOString()),
    finishedAt: new Date().toISOString(),
    detail: row.detail,
  });
  bus.publish("wf.run.finished", { status: "cancelled" }, { wfRunId });
  return { result: "cancelled" };
}

/** 这次运行的工作区（审计端点要拿它去读磁盘产物）。 */
export function workspaceOf(wfRunId: string): string {
  const detail = (outputStore.getRun(wfRunId)?.detail ?? {}) as {
    penguin?: { workspace?: string };
  };
  return detail.penguin?.workspace ?? defaultWorkspace();
}

/** 直接读磁盘产物（不经过库）。审计端点用它——scans/gold 那几条不该依赖复核入过库没有。 */
export function productsOf(wfRunId: string): RunProducts | undefined {
  try {
    return readRun(workspaceOf(wfRunId), wfRunId);
  } catch {
    return undefined;
  }
}

/**
 * 网关重启后，把还在跑的 Penguin 运行重新接上。
 *
 * 看门狗活在**这个进程**的内存里（一个 `setInterval`），而 session 活在 `:7364` 上——
 * 两者寿命不同。dev 模式下改一行代码就重启一次网关，此前的后果是：session 照跑、
 * 产物照落盘，而**没有人再去读它**。那次运行于是永远停在 `running`，
 * `/api/review/<runId>` 永远 404，界面上一批花了十分钟和真金白银产出的用例凭空消失。
 *
 * 这和 `graphs.ts::reconcileOrphanedRuns` 是同一个问题的同一个答案，只是那边靠产物反推，
 * 这边靠运行记录里存着的 `sessionId / workspace / outDir` 重新起一个看门狗。
 * `replay: false`：已经发过的节点事件在 `events.db` 里，重连的客户端自己会重放。
 */
export function reconcilePenguinRuns(log: (msg: string) => void = () => {}): void {
  for (const row of outputStore.listRuns(200)) {
    /*
     * `interrupted` 也要接。
     *
     * 启动顺序是 `reconcileOrphanedRuns` 在前——那是图运行时那条路的收尾，它看到一条
     * `running` 的运行、而 agent 进程里没有它，就判定「被重启打断了」并改写成 `interrupted`。
     * 可 Penguin 的 session 根本不在 agent 进程里，它在 `:7364` 上好好跑着。
     * 实测：重启后这条运行被标成 `interrupted`，而它十秒后就写出了 gate.json。
     * 所以两种状态都接，接上之后由这一路自己改写终态。
     */
    const st = String(row.status);
    if (st !== "running" && st !== "interrupted") continue;
    const detail = (outputStore.getRun(String(row.id))?.detail ?? {}) as {
      runtime?: string;
      target?: PenguinRunTarget;
      penguin?: { sessionId?: string; workspace?: string; outDir?: string };
    };
    if (detail.runtime !== "penguin" || !detail.penguin?.sessionId) continue;
    const wfRunId = String(row.id);
    const p = detail.penguin;
    log(`接回 Penguin 运行 ${wfRunId}（${p.sessionId}）`);
    // 立刻把状态改回 running：接回来了就不是「被打断」了。留着那个字样，
    // 界面上一条正在跑的运行会有八分钟显示成失败，而人据此做的第一件事是重跑它。
    if (st === "interrupted")
      outputStore.saveRun({
        id: wfRunId,
        graphId: String(row.graphId ?? PENGUIN_GRAPH_ID),
        graphVersion: Number(row.graphVersion ?? 1),
        status: "running",
        startedAt: String(row.startedAt ?? new Date().toISOString()),
        detail: { ...detail, error: undefined },
      });
    watchRun({
      runId: wfRunId,
      sessionId: p.sessionId!,
      workspace: p.workspace ?? defaultWorkspace(),
      outDir: p.outDir ?? join(p.workspace ?? defaultWorkspace(), "runs", wfRunId),
      ...(detail.target?.projectId ? { scopeProjectId: detail.target.projectId } : {}),
      replay: false,
      onEvent: (e) => publishBoth(e, wfRunId, detail.target?.projectId),
      onDone: (r) => void finish(wfRunId, String(row.startedAt ?? new Date().toISOString()), detail.target ?? {}, r),
    });
  }
}
