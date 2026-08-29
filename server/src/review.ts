import {
  clearReviewEdit,
  createCase,
  listReviewDecisions,
  listReviewEdits,
  recordReviewDecision,
  saveReviewEdit,
  type CaseType,
  type Priority,
  type ReviewEdit,
  type TestCase,
} from "./db.js";
import { getGraphVersion, nodeOutput, outputStore } from "./graphs.js";
import { computeGaps, shortTarget, stoppedBecause, type Gap } from "./gaps.js";
import { readMutationReport } from "./mutation.js";
import { ABLATABLE, gated, modelFromEnv } from "@testpilot/harness-core";
import {
  reviseCase,
  runGate,
  type Action,
  type CaseBundle,
  type MachineOracle,
  type TextCase,
} from "@testpilot/harness-testing";

/**
 * The review queue: what a workflow produced, before anyone has agreed to keep it.
 *
 * Generated cases do NOT land on the board. The board is "the suite I stand behind" — a
 * meaning worth protecting, and one that dissolves the moment twenty-five machine-written
 * cases appear in it unasked. So the products stay in the workflow run, the queue shows
 * them with what the gates thought, and approving is what creates a case.
 *
 * Rejections are recorded too, so the queue stops offering them: a queue that keeps
 * showing what you already declined is a queue people stop opening.
 */

export interface ReviewItem {
  caseId: string;
  title: string;
  storyId: string;
  designMethod: string;
  tier: number;
  precondition: string[];
  steps: string[];
  expected: string;
  /** What gate ① said about this specific case. */
  findings: Array<{ rule: string; severity: string; message: string }>;
  /** The machine-checkable form of the outcome, when stage one produced one. */
  oracle?: MachineOracle;
  /** Present once stage two has run. */
  code?: string;
  /**
   * 阶段二真的跑过的那串动作，展开共享前置之后。
   *
   * 批准时它取代阶段一的 `steps`：修复循环改的就是这里，而看板此前拿的是修复之前的版本。
   */
  codeSteps?: string[];
  codeBlocked?: boolean;
  codeFindings?: Array<{ rule: string; severity: string; message: string }>;
  /** Set if this case only went green after its assertion was weakened. */
  degraded?: boolean;
  decision?: "approved" | "rejected";
  createdCaseId?: string;
  /**
   * The case as the harness produced it, when an edit has been made on top.
   *
   * Kept beside the edited version rather than replaced by it: the product is evidence —
   * it is what the gate scored and what the next version will be compared against — and a
   * review that quietly overwrites it destroys the comparison it exists to inform.
   */
  original?: {
    title: string;
    steps: string[];
    expected: string;
    precondition: string[];
    tier: number;
    designMethod: string;
  };
  edit?: ReviewEdit;
  /** What gate ① says about the edited case. Absent when nothing was edited. */
  editedFindings?: Array<{ rule: string; severity: string; message: string }>;
}

/** 复核界面画故事地图需要的那一份故事。 */
export interface ReviewStory {
  id: string;
  title: string;
  activity?: string;
  flowId?: string;
  role?: string;
  benefit?: string;
  acceptance: string[];
}

/**
 * 只留画图要用的字段。
 *
 * 边上的一句话在这里就拼好，而不是丢给界面拼：这句话（「走到 /vets」「点『Find Owner』」）
 * 已经在 `gaps.ts` 的 `describeEdge` 里定过一次，两处各拼一遍迟早会不一致，
 * 而**同一条边在图上和在缺口清单里叫不同的名字**，是最伤信任的那种不一致。
 */
function trimGraph(g: {
  entry?: string;
  abstraction?: string;
  states?: Array<{ id: string; route?: string; title?: string; controls?: string[] }>;
  transitions?: Array<{
    from: string;
    to?: string;
    walked?: boolean;
    ok?: boolean;
    action?: { kind?: string; target?: string };
  }>;
  unvisited?: string[];
  stoppedBecause?: string;
  stopped?: { kind: string; n?: number };
}): ReviewGraph {
  return {
    entry: g.entry,
    abstraction: g.abstraction,
    states: (g.states ?? []).map((s) => ({
      id: s.id,
      route: s.route,
      title: s.title,
      controls: s.controls,
    })),
    transitions: (g.transitions ?? []).map((t) => ({
      from: t.from,
      to: t.to,
      walked: t.walked,
      ok: t.ok,
      kind: t.action?.kind,
      // 跟 gaps.ts 的 describeEdge 用同一个收短规则：同一条边在图上和在缺口清单里
      // 必须读起来是同一句话。
      label:
        t.action?.kind === "goto"
          ? `走到 ${shortTarget(t.action.target)}`
          : `点「${t.action?.target ?? "?"}」`,
    })),
    unvisited: g.unvisited,
    stoppedBecause: g.stoppedBecause,
    stopped: g.stopped,
  };
}

/** 画状态流图要用的最小形状。 */
export interface ReviewGraph {
  entry?: string;
  abstraction?: string;
  states: Array<{ id: string; route?: string; title?: string; controls?: string[] }>;
  transitions: Array<{
    from: string;
    to?: string;
    walked?: boolean;
    ok?: boolean;
    kind?: string;
    label?: string;
  }>;
  unvisited?: string[];
  stoppedBecause?: string;
  stopped?: { kind: string; n?: number };
}

export interface ReviewBatch {
  wfRunId: string;
  projectId?: string;
  gateScore?: number;
  /** Gate ① over the batch as edited. Only present once something has been edited. */
  editedGateScore?: number;
  edited: number;
  stats?: Record<string, unknown>;
  /**
   * 这批用例背后的故事。
   *
   * 复核 80 条扁平条目，人只能一条条看——那是**粒度**问题，不只是界面问题。
   * 有了故事与它们的骨架位置，复核单位才能从「一条断言」变成「一条流程」。
   */
  stories: ReviewStory[];
  items: ReviewItem[];
  pending: number;
  /**
   * **这个产品有、而这批用例没有的东西。**
   *
   * 复核的目的是判断「哪些有效、缺了什么」，而故事图此前只画得出前半句。
   * 这些数据一直都在（图里的未走链接、走不通的路、没人覆盖的转移、规格的疑问），
   * 只是从没送到人眼前。见 `gaps.ts`。
   */
  gaps: Gap[];
  /** 探索为什么停下来——它决定「没看到」那一类该不该怪探索，还是这个产品就这么大。 */
  exploreStoppedBecause?: string;
  /** 同一件事的结构化版本，界面靠它翻译。旧运行没有，就回落到上面那句原文。 */
  exploreStopped?: { kind: string; n?: number };
  /**
   * 探索画出来的状态流图，原样给界面画。
   *
   * 此前复核只拿到 `stoppedBecause` 一句话，于是缺口里那句
   * 「/owners 走到 … → /owners/find」在界面上是一串没有落点的字符串——
   * **人读到它，没有任何地图可以把它放上去**。整条链的地基是这张图，
   * 而要复核的人从头到尾看不见它。
   *
   * 只送画图要用的字段：控件文案留着（点开某一屏要看它上面有什么），
   * 其余（选择器、截图路径之类）不送——它们对读图的人没有意义，只是体积。
   */
  graph?: ReviewGraph;
  /**
   * 变异实验的结果——**没跑过时是 undefined，不是 0 分**。
   *
   * 这两者在界面上必须分得开：没跑过意味着「不知道这套用例验不验得住」，
   * 0 分意味着「知道，而且它一个都拦不住」。
   */
  mutation?: {
    score: number;
    killed: number;
    survived: number;
    inconclusive: number;
    notApplied: number;
    cases: number;
  };
}

const METHOD_TO_TYPE: Record<string, CaseType> = {
  equivalence: "functional",
  negative: "negative",
  boundary: "boundary",
  "state-transition": "e2e",
  "decision-table": "functional",
};

interface GatedBundleShape {
  stories?: Array<{
    id: string;
    title: string;
    acceptance?: string[];
    /** 骨架位置、流程归属、角色与价值——故事地图的横轴与「凭什么值得测」都靠它们。 */
    activity?: string;
    flowId?: string;
    role?: string;
    benefit?: string;
  }>;
  cases?: Array<{
    oracle?: MachineOracle;
    id: string;
    storyId: string;
    title: string;
    designMethod: string;
    precondition?: string[];
    steps: string[];
    expected: string;
    tier: number;
    /** 这条用例走了哪些转移。重写时要带上，否则它挂在产品模型上的那根线会断。 */
    covers?: string[];
  }>;
  gate?: { score?: number; stats?: Record<string, unknown>; findings?: Array<{ caseId?: string; rule: string; severity: string; message: string }> };
}

interface CodeBundleShape {
  code?: Array<{ caseId: string; code: string; uses?: string[]; actions?: Action[] }>;
  fragments?: Array<{ name: string; actions: Action[] }>;
  gate?: { findings?: Array<{ caseId?: string; rule: string; severity: string; message: string }> };
  repair?: { degraded?: string[] };
}

/**
 * 阶段二真的跑过的那串动作，写成看板认得的步骤。
 *
 * 这是「修复循环的成果到不了看板」的修法。此前批准写进看板的 `steps` 一律取自**阶段一**的
 * 文本用例，于是修复循环加的等待、改的措辞一条都传不下去——看板今晚仍然按原始步骤跑，
 * 而且可能因为修复循环**已经修好的那个理由**而挂。
 *
 * 共享前置在这里展开：看板没有片段这个概念，一条用例要能独立跑起来。
 * 断言不进步骤——它是判决，看板用 `expected` 与 `oracle` 表达。
 */
function stepsFromActions(
  kase: { uses?: string[]; actions?: Action[] },
  fragments: Array<{ name: string; actions: Action[] }>,
): string[] | undefined {
  if (!kase.actions?.length) return undefined;
  const prologue = (kase.uses ?? []).flatMap((n) => fragments.find((f) => f.name === n)?.actions ?? []);
  const steps = [...prologue, ...kase.actions]
    .filter((a) => a.kind !== "assert")
    .map((a) =>
      a.kind === "input" && a.field ? `在「${a.field}」输入 ${a.text}` : a.text,
    )
    .filter((t) => t.trim());
  return steps.length ? steps : undefined;
}

/** Read a run's products and pair them with the decisions already made. */
export async function reviewBatch(wfRunId: string): Promise<ReviewBatch> {
  const run = outputStore.getRun(wfRunId);
  if (!run) throw new Error(`unknown run: ${wfRunId}`);

  // Stage one is what defines the items; stage two, when present, adds the code.
  const gated = ((await nodeOutput(wfRunId, "gate").catch(() => undefined)) ??
    (await nodeOutput(wfRunId, "codegen").catch(() => undefined))) as GatedBundleShape | undefined;
  const coded = ((await nodeOutput(wfRunId, "repair").catch(() => undefined)) ??
    (await nodeOutput(wfRunId, "codegate").catch(() => undefined))) as CodeBundleShape | undefined;

  // 缺口要从**探索的图**和**规格**里算，而这两样此前复核根本没读过——
  // 于是「缺了什么」这半个问题在界面上是不存在的。
  const explore = (await nodeOutput(wfRunId, "explore").catch(() => undefined)) as
    | { graph?: Parameters<typeof computeGaps>[0]["graph"] }
    | undefined;
  const spec = (await nodeOutput(wfRunId, "spec").catch(() => undefined)) as
    | Parameters<typeof computeGaps>[0]["spec"]
    | undefined;

  /**
   * 变异实验是对着**已经生成好的那批用例**跑的，所以它挂在哪一次运行上，
   * 要看用例是哪一次产的。这里先按本次运行找；找不到就没有——不编一个 0 分出来。
   */
  const mutation = readMutationReport(wfRunId);

  const decisions = new Map(listReviewDecisions(wfRunId).map((d) => [d.caseId, d]));
  const edits = listReviewEdits(wfRunId);
  const gateFindings = gated?.gate?.findings ?? [];
  const codeFindings = coded?.gate?.findings ?? [];
  const degraded = new Set(coded?.repair?.degraded ?? []);

  // Score the edited batch as gate ① would have, with the same rules the run used —
  // otherwise "your edit raised the score" would sometimes only mean "this was scored by a
  // different gate".
  const anyEdits = Object.keys(edits).length > 0;
  const rescored = anyEdits ? rescore(run, gated, edits) : undefined;

  const items: ReviewItem[] = (gated?.cases ?? []).map((c) => {
    const mine = codeFindings.filter((f) => f.caseId === c.id);
    const mineCode = coded?.code?.find((x) => x.caseId === c.id);
    const edit = edits[c.id];
    const shown = applyEdit(c, edit);
    return {
      caseId: c.id,
      title: shown.title,
      storyId: c.storyId,
      designMethod: shown.designMethod,
      tier: shown.tier,
      precondition: shown.precondition ?? [],
      steps: shown.steps,
      expected: shown.expected,
      oracle: c.oracle,
      findings: gateFindings.filter((f) => f.caseId === c.id).map(({ rule, severity, message }) => ({ rule, severity, message })),
      code: mineCode?.code,
      codeSteps: mineCode ? stepsFromActions(mineCode, coded?.fragments ?? []) : undefined,
      codeBlocked: mine.some((f) => f.severity === "block"),
      codeFindings: mine.map(({ rule, severity, message }) => ({ rule, severity, message })),
      degraded: degraded.has(c.id),
      decision: decisions.get(c.id)?.decision,
      createdCaseId: decisions.get(c.id)?.createdCaseId,
      ...(edit
        ? {
            edit,
            // Present only when the text actually differs, so "original" answers "what did
            // this look like before" rather than "was anything stored against it".
            ...(contentChanged(c, shown) ? { original: {
              title: c.title,
              steps: c.steps,
              expected: c.expected,
              precondition: c.precondition ?? [],
              tier: c.tier,
              designMethod: c.designMethod,
            } } : {}),
            editedFindings: (rescored?.findings ?? [])
              .filter((f) => f.caseId === c.id)
              .map(({ rule, severity, message }) => ({ rule, severity, message })),
          }
        : {}),
    };
  });

  const target = (run.detail as { target?: { projectId?: string } } | undefined)?.target;
  return {
    wfRunId,
    stories: (gated?.stories ?? []).map((st) => ({
      id: st.id,
      title: st.title,
      activity: st.activity,
      flowId: st.flowId,
      role: st.role,
      benefit: st.benefit,
      acceptance: st.acceptance ?? [],
    })),
    projectId: target?.projectId,
    gateScore: gated?.gate?.score,
    editedGateScore: rescored?.score,
    edited: Object.keys(edits).length,
    stats: gated?.gate?.stats,
    items,
    pending: items.filter((i) => !i.decision).length,
    gaps: computeGaps({
      graph: explore?.graph,
      spec,
      cases: gated?.cases ?? [],
      stories: gated?.stories ?? [],
      // 活下来的变异体是第三类缺口：不是「没测到」，是**测了但验不住**。
      survivors: mutation?.survivors ?? [],
    }),
    ...(mutation
      ? {
          mutation: {
            score: mutation.score,
            killed: mutation.killed,
            survived: mutation.survived,
            // 老报告里没有这个字段，缺了当 0——它只会让分数显得更可信，不会更不可信。
            inconclusive: mutation.inconclusive ?? 0,
            notApplied: mutation.notApplied,
            cases: mutation.cases,
          },
        }
      : {}),
    exploreStoppedBecause: stoppedBecause(explore?.graph),
    ...(explore?.graph?.stopped ? { exploreStopped: explore.graph.stopped } : {}),
    ...(explore?.graph ? { graph: trimGraph(explore.graph) } : {}),
  };
}

type ProductCase = NonNullable<GatedBundleShape["cases"]>[number];

/** Did the edit change the case itself, or only how it should land on the board? */
function contentChanged(a: ProductCase, b: ProductCase): boolean {
  const shape = (c: ProductCase) =>
    JSON.stringify([c.title, c.steps, c.expected, c.precondition ?? [], c.tier, c.designMethod]);
  return shape(a) !== shape(b);
}

/** The case as it stands: what the harness wrote, with the reviewer's replacement on top. */
function applyEdit(c: ProductCase, edit?: ReviewEdit): ProductCase {
  if (!edit) return c;
  return {
    ...c,
    title: edit.title ?? c.title,
    steps: edit.steps ?? c.steps,
    expected: edit.expected ?? c.expected,
    precondition: edit.precondition ?? c.precondition,
    tier: edit.tier ?? c.tier,
    designMethod: edit.designMethod ?? c.designMethod,
  };
}

/**
 * Gate ① over the edited batch.
 *
 * The gate's parameters come from the graph version the run used, and the components it
 * had switched off stay switched off: a re-score is meant to answer "did my edit help",
 * and that question only has an answer if both numbers came out of the same gate.
 */
function rescore(
  run: Record<string, unknown>,
  gated: GatedBundleShape | undefined,
  edits: Record<string, ReviewEdit>,
): ReturnType<typeof runGate> | undefined {
  if (!gated?.cases?.length) return undefined;
  const def = getGraphVersion(String(run.graphId), Number(run.graphVersion ?? 1));
  const gateNode = def?.nodes.find((n) => n.type === "gate.textcase");
  const params = (gateNode?.params ?? {}) as { minNegativeRatio?: number; maxSteps?: number };
  const ablate = new Set(((run.detail as { ablate?: string[] } | undefined)?.ablate ?? []) as string[]);
  const bundle = {
    origin: "review",
    stories: (gated as unknown as CaseBundle).stories ?? [],
    cases: gated.cases.map((c) => applyEdit(c, edits[c.id])) as unknown as TextCase[],
  } as CaseBundle;
  return runGate(bundle, {
    ...params,
    gradeOracles: !ablate.has(ABLATABLE.oracleGrading),
    dedupe: !ablate.has(ABLATABLE.dedupe),
  });
}

export interface ApproveInput {
  wfRunId: string;
  caseIds: string[];
  projectId?: string;
  /** Per-case edits made in the queue before approving. */
  edits?: Record<string, { title?: string; expected?: string; steps?: string[]; priority?: Priority }>;
  note?: string;
}

/**
 * Approve: this is where a product artefact becomes a case in the board.
 *
 * The provenance goes with it — which run, which story, which design method, how hard the
 * verdict is, what the gate scored the batch. Without that, a board full of generated cases
 * cannot answer the first question anyone asks of one: where did this come from?
 */
export async function approve(input: ApproveInput): Promise<TestCase[]> {
  const batch = await reviewBatch(input.wfRunId);
  const projectId = input.projectId ?? batch.projectId;
  if (!projectId)
    throw new Error("this run was not bound to a project, so there is no board to approve into");

  const created: TestCase[] = [];
  for (const caseId of input.caseIds) {
    const item = batch.items.find((i) => i.caseId === caseId);
    if (!item) continue;
    // `item` already reads as edited; what is left to take from the stored edit is the
    // priority, which is a decision about the board rather than about the case.
    const edit = { ...(item.edit ?? {}), ...(input.edits?.[caseId] ?? {}) };
    const kase = createCase({
      projectId,
      title: edit.title ?? item.title,
      priority: edit.priority ?? "P1",
      priorityReason: `approved from ${input.wfRunId}${item.findings.length ? ` (${item.findings.length} gate findings)` : ""}${
        // Only content edits are worth saying: setting a priority in the queue is a
        // decision about the board, not a change to the case, and reporting it as one
        // makes every batch-prioritised case look rewritten.
        item.original ? `, edited in review${item.edit?.by === "model" ? " (regenerated)" : ""}` : ""
      }`,
      expected: edit.expected ?? item.expected,
      precondition: item.precondition.join("; "),
      type: METHOD_TO_TYPE[item.designMethod] ?? "functional",
      /**
       * 步骤的来源，按优先级：人在队列里的编辑 → **阶段二真的跑过的动作** → 阶段一的文本。
       *
       * 中间那一档是补上的。此前它不存在，于是修复循环加的等待、改的措辞一条都到不了看板，
       * 而看板正是这条用例今晚要跑的地方——它会带着修复循环已经修好的那个毛病重跑一遍。
       * 人的编辑仍然排在最前：那是唯一一次有人看过这条用例并且表过态。
       */
      steps: (edit.steps ?? item.codeSteps ?? item.steps).map((text, i) => ({ order: i + 1, text })),
      // Stage-two code rides along when it exists, so an approved case is runnable at once.
      code: item.code,
      hasCode: !!item.code,
      storyId: item.storyId,
      designMethod: item.designMethod,
      tier: item.tier,
      // Without this the board keeps the tier label and loses the thing that backs it.
      oracle: item.oracle,
      // A case that only went green after its assertion was weakened arrives marked.
      degraded: item.degraded,
      gateScore: batch.gateScore,
      sourceRunId: input.wfRunId,
    });
    recordReviewDecision({
      wfRunId: input.wfRunId,
      caseId,
      decision: "approved",
      note: input.note,
      createdCaseId: kase.id,
      at: new Date().toISOString(),
    });
    created.push(kase);
  }
  return created;
}

export function reject(input: { wfRunId: string; caseIds: string[]; note?: string }): number {
  for (const caseId of input.caseIds)
    recordReviewDecision({
      wfRunId: input.wfRunId,
      caseId,
      decision: "rejected",
      note: input.note,
      at: new Date().toISOString(),
    });
  return input.caseIds.length;
}

/* ---- adjusting what is in the queue ---- */

/**
 * Edit one case in place.
 *
 * The edit is stored against the run rather than applied to the product for the reason
 * given on the table itself: the product is evidence. Everything downstream — the diff, the
 * re-score, the approval — reads the pair.
 */
export async function editCase(
  wfRunId: string,
  caseId: string,
  edit: ReviewEdit,
): Promise<ReviewBatch> {
  const batch = await reviewBatch(wfRunId);
  const item = batch.items.find((i) => i.caseId === caseId);
  if (!item) throw new Error(`${caseId} is not in this batch`);
  if (item.decision) throw new Error(`${caseId} has already been ${item.decision}`);
  saveReviewEdit(wfRunId, caseId, { by: "human", ...edit });
  return reviewBatch(wfRunId);
}

export type BatchOp =
  /** Find and replace across the case's text. The credential fix, mostly. */
  | { kind: "replace"; find: string; with: string }
  /** What priority these should land on the board with. */
  | { kind: "priority"; priority: Priority }
  /** A shared precondition the generator kept leaving out. */
  | { kind: "precondition"; text: string }
  /** Undo: back to what the harness produced. */
  | { kind: "revert" };

/**
 * One change, applied to everything selected.
 *
 * These are the adjustments that are actually made in bulk. Find-and-replace earns its
 * place from history: the recurring defect in this project is a generated case inventing a
 * credential, and the fix is the same substitution across every case that did it.
 */
export async function batchAdjust(
  wfRunId: string,
  caseIds: string[],
  op: BatchOp,
): Promise<{ changed: string[]; batch: ReviewBatch }> {
  const batch = await reviewBatch(wfRunId);
  const changed: string[] = [];

  for (const caseId of caseIds) {
    const item = batch.items.find((i) => i.caseId === caseId);
    // A decided case is out of the queue's reach: editing what is already on the board
    // from here would change a case nobody would think to look at again.
    if (!item || item.decision) continue;
    const current: ReviewEdit = item.edit ?? {};

    if (op.kind === "revert") {
      if (!item.edit) continue;
      clearReviewEdit(wfRunId, caseId);
      changed.push(caseId);
      continue;
    }

    let next: ReviewEdit | undefined;
    if (op.kind === "priority") next = { ...current, priority: op.priority };
    else if (op.kind === "precondition") {
      const pre = item.precondition;
      if (pre.includes(op.text)) continue;
      next = { ...current, precondition: [...pre, op.text] };
    } else {
      if (!op.find) continue;
      const swap = (text: string) => text.split(op.find).join(op.with);
      const title = swap(item.title);
      const expected = swap(item.expected);
      const steps = item.steps.map(swap);
      // Nothing matched: recording an edit that changes nothing would show the case as
      // edited and make the diff panel open on two identical columns.
      if (title === item.title && expected === item.expected && steps.join("\u0000") === item.steps.join("\u0000"))
        continue;
      next = { ...current, title, expected, steps };
    }

    if (!next) continue;
    saveReviewEdit(wfRunId, caseId, { by: "human", ...next });
    changed.push(caseId);
  }

  return { changed, batch: await reviewBatch(wfRunId) };
}

/**
 * Ask the model to write one of these again, given what was objected to.
 *
 * Costs a model call per case and takes tens of seconds on a local model, so it is done on
 * an explicit selection rather than offered for the whole batch. The result arrives as an
 * edit like any other — it is a proposal, and the reviewer still decides.
 */
export async function regenerate(
  wfRunId: string,
  caseIds: string[],
  opts: { lang?: string; note?: string } = {},
): Promise<{ revised: string[]; failed: Array<{ caseId: string; message: string }>; batch: ReviewBatch }> {
  const batch = await reviewBatch(wfRunId);
  const gatedOut = ((await nodeOutput(wfRunId, "gate").catch(() => undefined)) ??
    (await nodeOutput(wfRunId, "codegen").catch(() => undefined))) as GatedBundleShape | undefined;
  const spec = (await nodeOutput(wfRunId, "spec").catch(() => undefined)) as { text?: string } | undefined;
  const model = gated(modelFromEnv());

  const revised: string[] = [];
  const failed: Array<{ caseId: string; message: string }> = [];

  for (const caseId of caseIds) {
    const item = batch.items.find((i) => i.caseId === caseId);
    if (!item || item.decision) continue;
    const story = gatedOut?.stories?.find((st) => st.id === item.storyId);
    const product = gatedOut?.cases?.find((c) => c.id === caseId);
    // The objections are what makes this different from "generate again and hope": a
    // rewrite with nothing to answer comes back reworded and just as wrong.
    const objections = [
      ...item.findings.map((f) => `[${f.rule}] ${f.message}`),
      ...(item.codeFindings ?? []).map((f) => `[code:${f.rule}] ${f.message}`),
      ...(opts.note ? [`[reviewer] ${opts.note}`] : []),
    ];
    try {
      const out = await reviseCase(model, {
        kase: {
          id: item.caseId,
          storyId: item.storyId,
          title: item.title,
          designMethod: item.designMethod as TextCase["designMethod"],
          // 重写一条用例时，它原本走了哪些转移要带上——否则重写出来的版本会丢掉它挂在
          // 产品模型上的那根线，结构覆盖率上凭空少一条。
          covers: product?.covers ?? [],
          precondition: item.precondition,
          steps: item.steps,
          expected: item.expected,
          tier: item.tier as TextCase["tier"],
          // The dedupe key travels with the case: without it the model is being asked to
          // revise something the gate would no longer recognise as the same case.
          key: (product as { key?: string } | undefined)?.key ?? `${item.storyId}|${item.caseId}`,
        },
        objections,
        story: story ? { id: story.id, title: story.title, acceptance: story.acceptance ?? [] } : undefined,
        // Context, trimmed: the whole specification is not what decides a single rewrite.
        specText: spec?.text?.slice(0, 6000),
        lang: opts.lang,
      });
      saveReviewEdit(wfRunId, caseId, {
        by: "model",
        note: opts.note,
        title: out.kase.title,
        steps: out.kase.steps,
        expected: out.kase.expected,
        precondition: out.kase.precondition,
        tier: out.kase.tier,
        designMethod: out.kase.designMethod,
        ...(item.edit?.priority ? { priority: item.edit.priority } : {}),
      });
      revised.push(caseId);
    } catch (e) {
      failed.push({ caseId, message: (e as Error).message });
    }
  }

  return { revised, failed, batch: await reviewBatch(wfRunId) };
}

/** Runs that still have something waiting for a person. */
/**
 * 可复核的批次。**带上开始时间**——列表里认哪一批，靠的是时间，不是那串哈希。
 */
export async function pendingRuns(
  limit = 20,
): Promise<Array<{ wfRunId: string; graphId: string; pending: number; total: number; startedAt?: string }>> {
  const out: Array<{
    wfRunId: string;
    graphId: string;
    pending: number;
    total: number;
    startedAt?: string;
  }> = [];
  for (const row of outputStore.listRuns(limit)) {
    if (row.status !== "done") continue;
    try {
      const batch = await reviewBatch(String(row.id));
      if (batch.items.length)
        out.push({
          wfRunId: String(row.id),
          graphId: String(row.graphId),
          pending: batch.pending,
          total: batch.items.length,
          startedAt: row.startedAt ? String(row.startedAt) : undefined,
        });
    } catch {
      /* a run whose outputs are gone is not reviewable; skip it rather than fail the list */
    }
  }
  return out;
}
