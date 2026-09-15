/**
 * G1 as a straight line of code.
 *
 * v3 §3 P1: 九步整体是**一个**工具，不是 agent 可以挑选的步骤。所以这里没有图、没有调度器、
 * 没有可配置的拓扑——只有一个写死顺序的 for 循环。Agent 能改的只有 `stage` 之外的那几个
 * 无关紧要的参数（材料在哪、结果写哪、要几条故事）。
 *
 * 它**不用** harness-core 的图运行时：那一层（`runGraph`）在 v3 里退役。节点本身留着，
 * 因为节点是领域知识；驱动节点的那套调度是 harness 的活，交给 Penguin。
 *
 * Phase 1A 在它之上加了三样，都是契约 §1 要的：
 *
 * - **`meta.json`**（`RunMeta`）：P3 的来源印记。没有它，一次运行的分数只是一个数字，
 *   说不清它出自哪一版 skill、哪一份提示词、哪一份材料——而说不清就没法比。
 * - **`events.jsonl`**（`NodeEvent`）：画布（US-14）与断点续跑（US-16.4）都读它。
 *   每个节点起止各一行，`end` 那行带 `wrote`——续跑靠这个字段找上游产物，不靠猜文件名。
 * - **`stopAfter` / `from` / `ablate`**：前两个是 US-16.4 的补回，第三个把消融开关接上。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { NodeContext, NodeDef } from "@testpilot/harness-core";
import { digestTexts, plannerModel, plannerConnectionFromEnv, parseAblation } from "@testpilot/harness-core";
import { RunModelsSchema, ModelConfigError, type RoleModelConnection, type RunModels } from "@testpilot/harness-core/model-profiles";
import {
  CASES_STABLE,
  CASES_STABLE_NO_CLEANUP,
  CASES_STABLE_NO_PRIORITY,
  CASES_STABLE_PLAIN,
  COMPOSE_STABLE,
  domainReferenceBlock,
  ORACLE_STRICT,
  STORIES_STABLE,
  composeSpecNode,
  designCasesNode,
  gateTextCaseNode,
  planStoriesNode,
  sourceSpecNode,
  type CaseGenNodeOptions,
  type GatedBundle,
} from "@testpilot/harness-testing/casegen";
import { hashMaterials } from "@testpilot/harness-testing/retrieve";
import { ABLATABLE } from "@testpilot/harness-core";
import { inputHashOf, type NodeEvent, type RunMeta } from "./contracts.js";

/** 一条进度。写 stderr（stdout 是 MCP 的 JSON-RPC 通道，写不得）。 */
export interface ProgressEvent {
  ts: string;
  runId: string;
  kind: string;
  nodeId: string;
  payload?: unknown;
}

export type Emit = (e: ProgressEvent) => void;

/**
 * 最薄的 `ctx` 桩。
 *
 * `NodeContext` 一共五个成员，节点真正用到的也就这五个：`nodeId` / `emit` / `spend` /
 * `signal` / `ablated`。没有一处需要图运行时——节点对运行时的依赖只有这个接口的形状，
 * 不是运行时的行为。所以桩就是一个对象字面量，不是一个假的运行时。
 */
function makeCtx(
  nodeId: string,
  runId: string,
  emit: Emit,
  signal: AbortSignal,
  spend: Spend,
  ablated: Set<string>,
): NodeContext {
  return {
    nodeId,
    emit: (kind, payload) => emit({ ts: new Date().toISOString(), runId, kind, nodeId, payload }),
    spend: (delta) => {
      spend.calls += delta.calls ?? 0;
      spend.tokens += delta.tokens ?? 0;
    },
    signal,
    ablated,
  };
}

interface Spend {
  calls: number;
  tokens: number;
}

/** 顺序写死的一步。 */
interface Step {
  id: string;
  // 节点的形状按步骤各不相同，串起来只能在这一层擦掉类型；每一步的 payload 由节点自己的
  // zod schema 在运行时校验，保证不比图运行时弱。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  node: NodeDef<any, any, any>;
  params: Record<string, unknown>;
}

/** 默认的 skill 版本。调用方（skill）应当传自己的那个——见 `skillVersion` 的注释。 */
export const DEFAULT_SKILL_VERSION = "2026-09-03.1";

export interface RunPipelineOptions {
  approvedRunId?: string;
  approvedRevisionIds?: string[];
  modelRoles?: RunModels;
  /** Server-injected planner snapshot; MCP callers configure TP_PLANNER_* explicitly. */
  planner?: RoleModelConnection;
  stage: "g1" | "g2";
  materialsDir: string;
  outDir: string;
  limit?: number;
  lang?: string;
  /** 跑完这个节点就停。留下的 `events.jsonl` 可以被 `from` 接着跑。 */
  stopAfter?: string;
  /** 从这个节点接着跑，上游产物从 `events.jsonl` 里前一个节点的 `wrote` 读。 */
  from?: string;
  /**
   * 从**一份冻结的上游产物**起跑：给了它，`from` 那一步的上游产物从这个目录的
   * `nodes/*.json` 读，而不是从 `outDir`。这样一份冻结的 `nodes/spec.json` +
   * `nodes/stories.json` 能喂给多个 design 候选，候选之间的分差就归到 design 那一版
   * 改动身上（单条 skill 进化）。只在 `from` 指定了从哪步续跑时有意义——没有 `from`
   * 却给了它是一次配置错误，当场停。算出的 `inputHash` 与本目录一并记进 `meta.json`。
   */
  frozenInputsDir?: string;
  /** 关掉哪些组件。名字必须是 `ABLATABLE` 里有的——拼错的开关会产生一次什么都没改的运行。 */
  ablate?: string[];
  /**
   * 这次运行绑定的领域参考（项目数据）。正文或文件路径二选一；都不给时读 `TP_DOMAIN_REFERENCE_FILE`
   * （起跑器按项目当前那一版写的），再没有就没有领域段——流水线不替任何产品补一段。
   */
  domainReference?: string;
  domainReferencePath?: string;
  /**
   * 调用方是哪一版 skill。
   *
   * **工具自己编不出这个数。** 编出来的版本号是一个看起来合法的印记，比没有印记更坏：
   * 它会让两次不同 skill 产出的分数被当成同一版的重复测量。默认值只是让 Phase 1 的
   * 手工调用跑得起来，真上线时 skill 必须传自己的。
   */
  skillVersion?: string;
  emit?: Emit;
  signal?: AbortSignal;
}

/** 一个节点跑完之后能说清的事：产出了什么文件、花了多少、成没成。 */
export interface NodeSummary {
  node: string;
  type: string;
  status: "done" | "failed";
  /** 相对 outDir 的产物路径（成功才有）。 */
  wrote?: string;
  tokens: number;
  ms: number;
  error?: string;
}

export interface RunPipelineResult {
  runId: string;
  stories: number;
  cases: number;
  gateScore: number | null;
  outDir: string;
  ran: string[];
  /** 逐节点小结：UI 展开这张卡就能看到「哪一步产出了什么」，而不只是五个总数。 */
  nodes: NodeSummary[];
  stoppedAfter?: string;
  resumedFrom?: string;
  meta: RunMeta;
}

/** 材料目录里所有像文档的文件。规格是几份文档，不是一份——见 `source.spec`。 */
export function collectMaterials(dir: string): string[] {
  const root = resolve(dir);
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      if (name.startsWith(".")) continue;
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(md|markdown|txt)$/i.test(name)) out.push(full);
    }
  };
  walk(root);
  return out;
}

/**
 * 这次运行实际用到的提示词的指纹。
 *
 * 只算**真的会被送出去的那几段**：消融开关会换掉 `design.cases` 的 stable 段，
 * 而换掉之后仍然报同一个指纹，等于让配对评测在两份不同的指令上做减法却以为只差一个开关。
 * 那是 `digest.ts` 开头说的「唯一一种每个数都对、结论却是假的」情形。
 */
/**
 * 消融开关的兜底来源（07 T-12，2026-09-08）。
 *
 * 经运行时跑的消融臂，`ablate` 写在给 agent 的起跑话术里，而 skill 说「不要改参数」——两次真跑 agent 都把它丢了，
 * 六次「消融臂」meta 里 `ablated: []`。一件确定的事不该交给一个不确定的东西：网关把它写进 MCP 子进程的 env
 * （`TP_ABLATE=domain-perp,…`），调用方没给 `ablate` 时从这里取。给了就以调用方为准。
 */
export function ablateFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.TP_ABLATE ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

export function promptsDigestFor(ablated: Set<string>, oracleGuidance: "default" | "strict" = "default", domainReference = "") {
  const designStable = ablated.has(ABLATABLE.designMethods)
    ? CASES_STABLE_PLAIN
    : ablated.has(ABLATABLE.casePriority)
      ? CASES_STABLE_NO_PRIORITY
      : ablated.has(ABLATABLE.caseCleanup)
        ? CASES_STABLE_NO_CLEANUP
        : CASES_STABLE;
  return digestTexts({
    "spec.compose": COMPOSE_STABLE,
    "plan.stories": STORIES_STABLE,
    // 领域 REFERENCE 臂（07 T-10）也是提示词的一部分：装 / 卸它，指纹必须不同——
    // 2026-09-08 两臂 `ablated` 一个有一个没有，`promptsDigest.combined` 却都是 556e2d1d。
    "design.cases":
      designStable + (oracleGuidance === "strict" ? ORACLE_STRICT : "") + (ablated.has(ABLATABLE.domainReference) ? "" : domainReferenceBlock(domainReference)),
  });
}

/** Legacy metadata shape, now sourced exclusively from the explicit planner role. */
export function modelBindingFromEnv(env: NodeJS.ProcessEnv = process.env): RunMeta["model"] {
  const c = plannerConnectionFromEnv(env);
  return {
    baseUrl: c.endpoint, model: c.model, thinking: c.thinking,
  };
}

/** 一个节点的产物落在哪。续跑读的就是这个文件。 */
const nodeArtifact = (outDir: string, id: string): string => join(outDir, "nodes", `${id}.json`);

/** 读回 `events.jsonl`：每个节点最后一次 `end` 写了哪个文件。 */
export function wroteByNode(outDir: string): Map<string, string> {
  const path = join(outDir, "events.jsonl");
  const map = new Map<string, string>();
  if (!existsSync(path)) return map;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as NodeEvent;
      if (e.phase === "end" && e.wrote) map.set(e.node, e.wrote);
    } catch {
      // 一行坏掉的事件不该让整次续跑失败：它只是少了一个可续跑的点。
    }
  }
  return map;
}

export async function runPipeline(opts: RunPipelineOptions): Promise<RunPipelineResult> {
  if (opts.stage === "g2") return (await import("./g2.js")).runApprovedPipeline(opts);
  if (opts.stage !== "g1") throw new Error(`unknown stage: ${opts.stage}`);

  const outDir = resolve(opts.outDir);
  mkdirSync(join(outDir, "nodes"), { recursive: true });

  // 拼错的消融开关会产生一次什么都没改的运行，外加一份声称改了的报告。宁可当场停。
  const { on: ablatedList, unknown } = parseAblation(opts.ablate?.length ? opts.ablate : ablateFromEnv());
  if (unknown.length) throw new Error(`unknown ablation switch(es): ${unknown.join(", ")} — nothing reads them`);
  const ablated = new Set<string>(ablatedList);

  const emit: Emit = opts.emit ?? (() => {});
  const signal = opts.signal ?? new AbortController().signal;
  const spend: Spend = { calls: 0, tokens: 0 };
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  const paths = collectMaterials(opts.materialsDir);
  if (!paths.length) throw new Error(`no specification documents (*.md/*.txt) under ${opts.materialsDir}`);

  const nodeOpts: CaseGenNodeOptions = { model: { chat: request => plannerModel(plannerConnection).chat(request) }, baseDir: resolve(opts.materialsDir) };
  const domainFile = opts.domainReferencePath ?? process.env.TP_DOMAIN_REFERENCE_FILE;
  const domainReference = opts.domainReference?.trim() ? opts.domainReference : domainFile ? readFileSync(resolve(domainFile), "utf8") : "";
  const lang = opts.lang ?? "zh";

  /** 顺序写死。这一行就是 P1 本身。 */
  const steps: Step[] = [
    { id: "docs", node: sourceSpecNode(nodeOpts), params: { paths } },
    { id: "spec", node: composeSpecNode(nodeOpts), params: { lang } },
    { id: "stories", node: planStoriesNode(nodeOpts), params: { maxStories: opts.limit ?? 12, lang } },
    { id: "design", node: designCasesNode(nodeOpts), params: { lang, ...(domainReference.trim() ? { domainReference } : {}) } },
    { id: "gate", node: gateTextCaseNode(), params: { minNegativeRatio: 0.3, maxSteps: 8 } },
  ];

  const ids = steps.map((s) => s.id);
  if (opts.stopAfter && !ids.includes(opts.stopAfter))
    throw new Error(`stopAfter: no node "${opts.stopAfter}" — the pipeline is ${ids.join(" → ")}`);
  if (opts.from && !ids.includes(opts.from))
    throw new Error(`from: no node "${opts.from}" — the pipeline is ${ids.join(" → ")}`);
  // 冻结输入只在续跑时有意义：没有 `from`，就没有「上游产物从哪读」这个问题。
  if (opts.frozenInputsDir && !opts.from)
    throw new Error(
      `frozenInputsDir was given without from — a frozen upstream input only means something when from says ` +
        `which step to resume at. Set from to the stage being evolved, e.g. { from: "design", frozenInputsDir: … }.`,
    );

  const startIndex = opts.from ? ids.indexOf(opts.from) : 0;
  const stopIndex = opts.stopAfter ? ids.indexOf(opts.stopAfter) : steps.length - 1;
  if (stopIndex < startIndex)
    throw new Error(`stopAfter "${opts.stopAfter}" comes before from "${opts.from}" — that range is empty`);

  /**
   * 续跑复用原来的 runId。
   *
   * 一次运行被分成两段执行，仍然是**一次**运行：分数、印记、事件流都该挂在同一个 id 下。
   * 给续跑发一个新 id，等于把一次运行的证据切成两半，而两半都不完整。
   */
  const priorMetaPath = join(outDir, "meta.json");
  const priorMeta = existsSync(priorMetaPath)
    ? (JSON.parse(readFileSync(priorMetaPath, "utf8")) as Partial<RunMeta>)
    : undefined;
  const managedRunId = process.env.TP_MODEL_RUN_ID;
  if (managedRunId && (!/^[a-zA-Z0-9_-]{1,160}$/.test(managedRunId) || (opts.from && priorMeta?.runId && priorMeta.runId !== managedRunId)))
    throw new ModelConfigError("invalid_binding");
  const runId =
    opts.from && priorMeta?.runId ? priorMeta.runId : managedRunId ?? `run-${Date.now().toString(36)}`;

  const eventsPath = join(outDir, "events.jsonl");
  const writeEvent = (e: NodeEvent) => {
    const line = JSON.stringify(e);
    appendFileSync(eventsPath, line + "\n");
    // stderr 照旧：MCP 客户端从这里看进度，它不读运行目录。
    process.stderr.write(line + "\n");
  };

  const outputs = new Map<string, unknown>();
  let carried: unknown = undefined;

  /**
   * 续跑时上游产物从哪读。
   *
   * 默认是 `outDir`（同一次运行分两段跑，上游是这次自己上一段留下的）；给了
   * `frozenInputsDir` 就从那份**冻结**的产物读——一份输入喂多个候选，这是单条 skill
   * 进化的入口。两种情形都认 `events.jsonl` 里记的 `wrote`；冻结目录常常只带
   * `nodes/*.json` 没有事件流，那就按 `nodeArtifact` 的固定约定 `nodes/<id>.json` 找。
   */
  const upstreamDir = opts.frozenInputsDir ? resolve(opts.frozenInputsDir) : outDir;

  if (startIndex > 0) {
    const prev = ids[startIndex - 1];
    const wrote = wroteByNode(upstreamDir).get(prev) ?? join("nodes", `${prev}.json`);
    const full = resolve(upstreamDir, wrote);
    if (!existsSync(full))
      throw new Error(
        opts.frozenInputsDir
          ? `cannot resume from "${opts.from}": frozenInputsDir ${upstreamDir} has no "${prev}" artefact ` +
            `(looked for ${wrote}). Freeze the upstream first — run { stopAfter: "${prev}" } and copy its nodes/ into that directory.`
          : `cannot resume from "${opts.from}": events.jsonl in ${outDir} has no completed "${prev}" with a recorded artefact. ` +
            `Run the pipeline with { stopAfter: "${prev}" } first.`,
      );
    carried = JSON.parse(readFileSync(full, "utf8"));
    outputs.set(prev, carried);
  }

  const ran: string[] = [];
  // Validate frozen inputs before allocating a model; do not mask an invalid experiment.
  const plannerConnection = opts.planner ?? plannerConnectionFromEnv();
  let modelRoles: RunModels | undefined;
  try {
    const raw = opts.modelRoles ?? (process.env.TP_RUN_MODELS_JSON ? JSON.parse(process.env.TP_RUN_MODELS_JSON) : undefined);
    modelRoles = raw === undefined ? undefined : RunModelsSchema.parse(raw);
    if (modelRoles && (modelRoles.mode !== "pipeline" || modelRoles.planner.source !== "configured" || modelRoles.planner.model !== plannerConnection.model)) throw new Error();
  } catch { throw new ModelConfigError("invalid_binding", "planner"); }
  const nodeSummaries: NodeSummary[] = [];
  for (const step of steps.slice(startIndex, stopIndex + 1)) {
    if (signal.aborted) throw new Error(`run ${runId} aborted before ${step.id}`);
    const started = Date.now();
    const before = { ...spend };
    writeEvent({ runId, node: step.id, phase: "start", at: new Date().toISOString() });
    emit({ ts: new Date().toISOString(), runId, kind: "node.started", nodeId: step.id, payload: { type: step.node.type } });
    try {
      // 两级契约照旧：params 与 input 都过节点自己的 schema。图运行时做的检查这里一样做,
      // 少的只是调度和存储。
      const params = step.node.params.parse(step.params);
      const input = step.node.inKind === null ? undefined : step.node.input.parse(carried);
      const ctx = makeCtx(step.id, runId, emit, signal, spend, ablated);
      const raw = await step.node.run(input, params, ctx);
      const output = step.node.output.parse(raw);
      outputs.set(step.id, output);
      carried = output;
      ran.push(step.id);

      const artefact = nodeArtifact(outDir, step.id);
      writeFileSync(artefact, JSON.stringify(output, null, 2));
      writeEvent({
        runId,
        node: step.id,
        phase: "end",
        at: new Date().toISOString(),
        ms: Date.now() - started,
        calls: spend.calls - before.calls,
        tokens: spend.tokens - before.tokens,
        wrote: relative(outDir, artefact),
      });
      emit({
        ts: new Date().toISOString(),
        runId,
        kind: "node.finished",
        nodeId: step.id,
        payload: {
          type: step.node.type,
          ms: Date.now() - started,
          status: "done",
          tokens: spend.tokens - before.tokens,
          wrote: relative(outDir, artefact),
        },
      });
      nodeSummaries.push({
        node: step.id,
        type: step.node.type,
        status: "done",
        wrote: relative(outDir, artefact),
        tokens: spend.tokens - before.tokens,
        ms: Date.now() - started,
      });
    } catch (e) {
      writeEvent({
        runId,
        node: step.id,
        phase: "error",
        at: new Date().toISOString(),
        ms: Date.now() - started,
        error: (e as Error).message,
      });
      emit({
        ts: new Date().toISOString(),
        runId,
        kind: "node.finished",
        nodeId: step.id,
        payload: { type: step.node.type, ms: Date.now() - started, status: "failed", error: (e as Error).message },
      });
      nodeSummaries.push({
        node: step.id,
        type: step.node.type,
        status: "failed",
        tokens: spend.tokens - before.tokens,
        ms: Date.now() - started,
        error: (e as Error).message,
      });
      throw new Error(`${step.id} (${step.node.type}) failed: ${(e as Error).message}`);
    }
  }

  /**
   * 落盘：能写哪个就写哪个。
   *
   * `stopAfter: "stories"` 停下来时没有用例，也就没有 `cases.json`——那时写一个空的
   * `cases.json` 比不写更坏：下游读到的是「这次跑出零条用例」，而事实是「还没跑到那一步」。
   */
  const gated = outputs.get("gate") as GatedBundle | undefined;
  const designed = outputs.get("design") as { stories?: unknown[]; cases?: unknown[] } | undefined;
  const planned = outputs.get("stories") as { stories?: unknown[] } | undefined;
  const storyList = (gated?.stories ?? designed?.stories ?? planned?.stories ?? []) as unknown[];
  const caseList = (gated?.cases ?? designed?.cases ?? []) as unknown[];

  if (storyList.length) writeFileSync(join(outDir, "stories.json"), JSON.stringify({ runId, stories: storyList }, null, 2));
  if (caseList.length) writeFileSync(join(outDir, "cases.json"), JSON.stringify({ runId, cases: caseList }, null, 2));
  if (gated) writeFileSync(join(outDir, "gate.json"), JSON.stringify({ runId, gate: gated.gate, spend }, null, 2));

  /**
   * `params` 的键序在这里固定下来。
   *
   * `agentState` 用 `JSON.stringify(params)` 算指纹（契约 §2 写死的算法），
   * 而 `JSON.stringify` 的输出跟着插入序走。键序一变，同一份参数会算出不同的 `agentState`，
   * 于是同一版 agent 的两次运行看起来像两版。所以这个对象字面量的顺序是**有意义的**，
   * 不要重排。
   */
  const params: Record<string, unknown> = {
    stage: opts.stage,
    lang,
    limit: opts.limit ?? 12,
    minNegativeRatio: 0.3,
    maxSteps: 8,
    stopAfter: opts.stopAfter ?? null,
    from: opts.from ?? null,
  };

  /**
   * 冻结输入的指纹。**只在从冻结目录起跑时有值**——一次普通的分段续跑（同一 `outDir`）
   * 不是一场进化实验，不带 `inputHash`（缺省即「无冻结输入」）。
   *
   * 哈的是 `from` 之前那几个节点、且**真的躺在冻结目录里**的产物：人冻了 spec + stories，
   * 就只有这两份进指纹；`inputHashOf` 跳过不存在的。`materialsHash` 那套哈希，一处算法。
   */
  const inputHash = opts.frozenInputsDir
    ? inputHashOf(
        upstreamDir,
        ids.slice(0, startIndex).map((id) => join("nodes", `${id}.json`)),
      )
    : undefined;

  const runtime = process.env.TP_RUNTIME;
  const meta: RunMeta = {
    runId,
    stage: opts.stage,
    // 由起跑的接缝通过 env 告诉 MCP 子进程；工具自己不猜。没告诉就不写（旧条目的样子）。
    ...(runtime === "penguin" || runtime === "claude-code" || runtime === "codex" || runtime === "pipeline" ? { runtime } : {}),
    skillVersion: opts.skillVersion ?? DEFAULT_SKILL_VERSION,
    promptsDigest: promptsDigestFor(ablated, "default", domainReference),
    params,
    ablated: [...ablated].sort(),
    model: { baseUrl: modelRoles?.planner.source === "configured" ? modelRoles.planner.endpoint : plannerConnection.endpoint, model: plannerConnection.model, thinking: plannerConnection.thinking },
    ...(modelRoles ? { modelRoles } : {}),
    materialsHash: hashMaterials(opts.materialsDir),
    // 冻结起跑时记下从哪读的与算出的指纹；否则两个键都不写（JSON 里不出现）。
    frozenInputsDir: opts.frozenInputsDir ? upstreamDir : undefined,
    inputHash,
    startedAt: priorMeta?.startedAt && opts.from ? priorMeta.startedAt : startedAt,
    finishedAt: new Date().toISOString(),
    spend: {
      // 续跑时把上一段的花费加回来：一次运行的成本是它全部两段的成本。
      calls: spend.calls + (opts.from ? (priorMeta?.spend?.calls ?? 0) : 0),
      tokens: spend.tokens + (opts.from ? (priorMeta?.spend?.tokens ?? 0) : 0),
      ms: Date.now() - t0 + (opts.from ? (priorMeta?.spend?.ms ?? 0) : 0),
    },
  };
  writeFileSync(join(outDir, "meta.json"), JSON.stringify(meta, null, 2));

  return {
    runId,
    stories: storyList.length,
    cases: caseList.length,
    gateScore: gated ? gated.gate.score : null,
    outDir,
    ran,
    nodes: nodeSummaries,
    stoppedAfter: opts.stopAfter,
    resumedFrom: opts.from,
    meta,
  };
}
