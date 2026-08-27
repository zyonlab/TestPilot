import {
  decisionForCreatedCase,
  getCase,
  listAllReviewEdits,
  listCases,
  type TestCase,
} from "./db.js";
import { nodeOutput, outputStore } from "./graphs.js";

/**
 * The code line: what a run generated, what the board actually stands behind, and the gap.
 *
 * These are two different objects and the UI kept showing only one of them. **The generated
 * code belongs to a run** — it is a product of that pipeline, scored by gate ② and possibly
 * rewritten a few times by the repair loop. **The code on a case is the version that batch
 * arrived with**, and someone may have edited it since approval. Collapsing the two makes
 * "the harness produced this" and "this is what runs" look like one fact, which is exactly
 * the confusion an audit has to be able to resolve.
 *
 * 一句必须说准的话：**看板执行的不是这段源码本身，而是从它解析出来的动作表**——批准时
 * 阶段二真的跑过的那串动作被写进用例的 `steps`（`review.ts` 的 `stepsFromActions`），
 * 执行走的是那条路。这与「保留含义而不是信任文本」是同一个决定：执行、门禁、修复三方
 * 对同一份动作表说话。这段源码留在这里是给人读、给人 diff 的证据，不是执行体。
 * 此前这段注释写的是「it is what will execute tonight」，而代码里没有任何一处会执行它。
 *
 * Nothing here is recomputed: every number is read back out of the run that produced it, so
 * a page cannot report a gate score the run never got.
 */

interface CodeBundle {
  code?: Array<{ caseId: string; code: string; uses?: string[]; actions?: unknown[] }>;
  fragments?: Array<{ id?: string; name?: string }>;
  gate?: { score?: number; findings?: Array<{ caseId?: string; rule: string; severity: string; message: string }> };
  repair?: {
    rounds?: Array<{ caseId: string; round: number; changes: string[] }>;
    outcomes?: Array<{ caseId: string; status?: string; kind?: string; ms?: number }>;
    degraded?: string[];
    loosePassRate?: number;
    strictPassRate?: number;
  };
}

/** The stage-two products of a run, whichever node carried them. */
async function codeBundle(wfRunId: string): Promise<CodeBundle | undefined> {
  for (const node of ["repair", "codegate", "codegen"]) {
    const out = (await nodeOutput(wfRunId, node).catch(() => undefined)) as CodeBundle | undefined;
    if (out?.code) return out;
  }
  return undefined;
}

export interface CodeProvenance {
  caseId: string;
  title: string;
  /** What runs tonight. Empty when the case has no code yet. */
  current: string;
  /** What the run generated for it, when the case came from a run that generated code. */
  generated?: string;
  /** True when the two differ — the case has been edited since it was approved. */
  drifted: boolean;
  sourceRunId?: string;
  /** The id this case had inside the run, which is not the board id. */
  sourceCaseId?: string;
  gate2?: number;
  /** Gate ② findings against this case specifically. */
  findings: Array<{ rule: string; severity: string; message: string }>;
  /** What the repair loop changed, round by round. */
  rounds: Array<{ round: number; changes: string[] }>;
  /** Whether it only went green after its assertion was weakened. */
  degraded: boolean;
  /** Its last outcome inside the run that produced it. */
  outcome?: { status?: string; kind?: string; ms?: number };
  /** Shared fragments this case pulls in. */
  uses: string[];
}

/**
 * Trace one board case back to the run that generated its code.
 *
 * The link is the review decision, not a title match: the two sides use different ids
 * (`US-02-1-…` inside a run, `tc-…` on the board), and matching on text would silently pair
 * the wrong case the first time two cases were named alike.
 */
export async function codeProvenance(caseId: string): Promise<CodeProvenance> {
  const kase = getCase(caseId);
  if (!kase) throw new Error(`unknown case: ${caseId}`);

  const base: CodeProvenance = {
    caseId: kase.id,
    title: kase.title,
    current: kase.code ?? "",
    drifted: false,
    findings: [],
    rounds: [],
    degraded: false,
    uses: [],
  };

  const sourceRunId = kase.sourceRunId;
  if (!sourceRunId || !outputStore.getRun(sourceRunId)) return base;
  const decision = decisionForCreatedCase(kase.id);
  const sourceCaseId = decision?.caseId;
  if (!sourceCaseId) return { ...base, sourceRunId };

  const bundle = await codeBundle(sourceRunId);
  if (!bundle) return { ...base, sourceRunId, sourceCaseId };

  const gen = bundle.code?.find((c) => c.caseId === sourceCaseId);
  const generated = gen?.code;
  return {
    ...base,
    sourceRunId,
    sourceCaseId,
    generated,
    // A case with no stored code has not drifted from anything; it simply never landed.
    drifted: !!generated && !!kase.code && generated.trim() !== kase.code.trim(),
    gate2: bundle.gate?.score,
    findings: (bundle.gate?.findings ?? [])
      .filter((f) => f.caseId === sourceCaseId)
      .map(({ rule, severity, message }) => ({ rule, severity, message })),
    rounds: (bundle.repair?.rounds ?? [])
      .filter((r) => r.caseId === sourceCaseId)
      .map((r) => ({ round: r.round, changes: r.changes })),
    degraded: (bundle.repair?.degraded ?? []).includes(sourceCaseId),
    outcome: bundle.repair?.outcomes?.find((o) => o.caseId === sourceCaseId),
    uses: gen?.uses ?? [],
  };
}

export interface CodeLineRow {
  caseId: string;
  title: string;
  hasCode: boolean;
  drifted: boolean;
  degraded: boolean;
  gate2?: number;
  rounds: number;
  sourceRunId?: string;
  outcome?: { status?: string; kind?: string };
  uses: string[];
}

/**
 * The code line for a whole project.
 *
 * Every case is listed, including the ones with no code: "which of my cases can actually
 * run" is the first question this page has to answer, and a table that quietly omits the
 * ones without code answers it wrongly by making the suite look complete.
 */
export async function codeLine(projectId: string): Promise<{ rows: CodeLineRow[]; fragments: number }> {
  const cases: TestCase[] = listCases(projectId);
  const bundles = new Map<string, CodeBundle | undefined>();
  const rows: CodeLineRow[] = [];
  let fragments = 0;

  for (const kase of cases) {
    const p = await codeProvenance(kase.id).catch(() => undefined);
    if (p?.sourceRunId && !bundles.has(p.sourceRunId)) {
      const b = await codeBundle(p.sourceRunId);
      bundles.set(p.sourceRunId, b);
      fragments += b?.fragments?.length ?? 0;
    }
    rows.push({
      caseId: kase.id,
      title: kase.title,
      hasCode: !!kase.code,
      drifted: p?.drifted ?? false,
      degraded: p?.degraded ?? kase.degraded ?? false,
      gate2: p?.gate2,
      rounds: p?.rounds.length ?? 0,
      sourceRunId: p?.sourceRunId,
      outcome: p?.outcome,
      uses: p?.uses ?? [],
    });
  }
  return { rows, fragments };
}

export interface ChangeRow {
  kind: "review-edit" | "code-drift";
  at?: string;
  caseId: string;
  title: string;
  /** Which fields moved — the point of the row, not a diff of every character. */
  fields: string[];
  by: "human" | "model";
  wfRunId?: string;
  note?: string;
}

const FIELD_LABELS: Record<string, string> = {
  title: "标题",
  expected: "期望",
  steps: "步骤",
  precondition: "前置",
  tier: "判定层级",
  designMethod: "设计方法",
};

/**
 * Not a change to the case.
 *
 * `priority` is a decision about the board and `by`/`note` are metadata about the edit
 * itself. Counting any of them here makes every batch-prioritised case look rewritten — the
 * first screen of this list was four rows of "优先级 · 人改的", which is the review queue's
 * bulk-priority button, not anyone rewriting anything. `review.ts` already refuses to call
 * these edits for the same reason; the two now agree.
 */
const NOT_A_REWRITE = new Set(["priority", "by", "note"]);

/**
 * What has been rewritten, and by whom.
 *
 * Two kinds of change, kept apart because they mean different things. A **review edit**
 * happened before anything was approved — the generated batch was wrong and someone (or a
 * regeneration) fixed it, and the gate was re-scored on the result. A **code drift** happened
 * after: the board case no longer matches what its run produced, which is legitimate but has
 * to be visible, because from then on the run's gate ② score is no longer a statement about
 * the code that will execute.
 */
export async function changes(projectId: string, limit = 100): Promise<ChangeRow[]> {
  const rows: ChangeRow[] = [];

  // Only the runs that produced this project's cases: a global edit list would show a
  // reviewer changes made in someone else's project.
  const mine = new Set(
    listCases(projectId)
      .map((c) => c.sourceRunId)
      .filter(Boolean) as string[],
  );
  for (const { wfRunId, caseId, at, edit } of listAllReviewEdits(limit * 2)) {
    if (!mine.has(wfRunId)) continue;
    const fields = Object.keys(edit)
      .filter((k) => !NOT_A_REWRITE.has(k))
      .map((k) => FIELD_LABELS[k] ?? k);
    if (!fields.length) continue;
    rows.push({
      kind: "review-edit",
      at,
      caseId,
      title: edit.title ?? caseId,
      fields,
      by: edit.by ?? "human",
      wfRunId,
      note: edit.note,
    });
  }

  for (const kase of listCases(projectId)) {
    if (!kase.code) continue;
    const p = await codeProvenance(kase.id).catch(() => undefined);
    if (p?.drifted)
      rows.push({
        kind: "code-drift",
        caseId: kase.id,
        title: kase.title,
        fields: ["代码"],
        by: "human",
        wfRunId: p.sourceRunId,
      });
  }

  return rows.slice(0, limit);
}
