import { dataPath } from "./datadir.js";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import {
  ALL_ABLATABLE,
  comparePaired,
  gated,
  mcnemar,
  modelFromEnv,
  methodMix,
  parseAblation,
  scoreCoverage,
  adjudicateMisses,
  digestDiff,
  type TextDigest,
  type CandidateCase,
  type CoverageResult,
  type GoldChecklist,
  type PairedBinary,
} from "@testpilot/harness-core";
import { collectEvidence, critique } from "@testpilot/harness-testing";
import { allOutputs, getGraph, nodeOutput, outputStore, runPromptDigest, startRun, type RunTarget } from "./graphs.js";
import { bus } from "./procs.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");

/**
 * Paired evaluation: run the same work two ways and subtract.
 *
 * Not two separate runs compared by eye, and not two random halves of the batch — the
 * variation between items is far larger than the effect of any harness change, so the only
 * comparison that means anything is the one where every item is scored under both arms.
 *
 * The arms differ by exactly one thing (an ablation switch, or one parameter). Changing two
 * things and reading one number is how a project convinces itself of something false.
 */

export interface EvalArm {
  label: string;
  ablate?: string[];
  /** Per-node parameter overrides, e.g. { gate: { minNegativeRatio: 0.5 } }. */
  params?: Record<string, Record<string, unknown>>;
  /** Or run a saved version of the graph as it was. */
  graphVersion?: number;
}

/**
 * 这次评测出自仓库里的哪份定义，以及它跑之前写下的预判。
 *
 * 记进结果里，因为报告要能自己说清它在回答什么问题。一个只有两组数字的结果，
 * 三个月后没有人还记得当初为什么要比这两样。
 */
export interface EvalSpecRef {
  id: string;
  title: string;
  why: string;
  path: string;
  expect?: { direction: "a-better" | "b-better" | "no-difference" | "unknown"; note: string };
}

export interface PairedEvalRequest {
  graphId: string;
  goldPath?: string;
  target?: RunTarget;
  seed?: unknown;
  /** Which node's output holds the cases to score. */
  casesNode?: string;
  a: EvalArm;
  b: EvalArm;
  /** 来自 `evals/*.json` 时带上它；界面上临时拼的一次评测没有。 */
  spec?: EvalSpecRef;
}

export interface ArmResult {
  label: string;
  wfRunId: string;
  ablate: string[];
  /** What made this arm different, echoed back so the report is readable on its own. */
  params?: Record<string, Record<string, unknown>>;
  graphVersion?: number;
  /** Fingerprint of the instructions this arm ran under. */
  prompts?: TextDigest;
  status: string;
  coverage: number;
  heldOutCoverage: number;
  covered: string[];
  cases: number;
  spend: { calls: number; tokens: number; ms: number };
  gateScore?: number;
}

export interface PairedEvalResult {
  id: string;
  graphId: string;
  gold: string;
  a: ArmResult;
  b: ArmResult;
  /** Per gold item: covered by A, covered by B. This is the paired unit. */
  mcnemar: ReturnType<typeof mcnemar>;
  coverageDelta: ReturnType<typeof comparePaired>;
  costDelta: { calls: number; tokens: number; ms: number };
  methodMix: { a: Record<string, { expected: number; covered: number }>; b: Record<string, { expected: number; covered: number }> };
  startedAt: string;
  finishedAt?: string;
  note: string;
  /** 出自仓库里的哪份定义。界面上临时拼的一次评测没有。 */
  spec?: EvalSpecRef;
  /**
   * 跑之前写下的预判，对上了没有。
   *
   * **它不是一个通过/失败**。一个会红的评测会被人调到绿为止，而那正是评测本该防住的事。
   * 它只被记下来并显示——预判错了是这份评测最有价值的一次输出。
   */
  prediction?: {
    expected: "a-better" | "b-better" | "no-difference" | "unknown";
    observed: "a-better" | "b-better" | "no-difference";
    /** 观察到的方向是否达到显著。不显著时"对上了"说明不了什么，所以一并给出。 */
    significant: boolean;
    matched: boolean | undefined;
  };
}

/**
 * 实际结果指向哪边。
 *
 * 只看方向，不看显著性——显著性单独给。把两者合成一个"是否达标"的布尔值，
 * 就等于替读的人把统计判断做掉了，而那正是他该自己做的那一步。
 */
function observedDirection(m: ReturnType<typeof mcnemar>): "a-better" | "b-better" | "no-difference" {
  if (m.bOnly > m.aOnly) return "b-better";
  if (m.aOnly > m.bOnly) return "a-better";
  return "no-difference";
}

const db = new Database(dataPath("evals.db"));
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS critiques (
    id TEXT PRIMARY KEY,
    at TEXT NOT NULL,
    runs INTEGER NOT NULL,
    testable INTEGER NOT NULL,
    json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS evals (
    id TEXT PRIMARY KEY,
    graphId TEXT NOT NULL,
    startedAt TEXT NOT NULL,
    finishedAt TEXT,
    status TEXT NOT NULL,
    json TEXT NOT NULL
  );
`);

const save = (row: { id: string; graphId: string; startedAt: string; finishedAt?: string; status: string; detail: unknown }) =>
  db
    .prepare(
      `INSERT INTO evals (id, graphId, startedAt, finishedAt, status, json)
       VALUES (@id, @graphId, @startedAt, @finishedAt, @status, @json)
       ON CONFLICT(id) DO UPDATE SET finishedAt=excluded.finishedAt, status=excluded.status, json=excluded.json`,
    )
    .run({ ...row, finishedAt: row.finishedAt ?? null, json: JSON.stringify(row.detail) });

export const listEvals = (limit = 30): Array<Record<string, unknown>> =>
  db.prepare("SELECT id, graphId, startedAt, finishedAt, status FROM evals ORDER BY startedAt DESC LIMIT ?").all(limit) as Array<
    Record<string, unknown>
  >;

export function getEval(id: string): Record<string, unknown> | undefined {
  const row = db.prepare("SELECT * FROM evals WHERE id=?").get(id) as { json: string } | undefined;
  return row ? (JSON.parse(row.json) as Record<string, unknown>) : undefined;
}

/**
 * Which checklist a graph is scored against.
 *
 * A graph that reads a different specification has to be scored against a different
 * checklist, and getting this wrong is silent: the mock checklist against the self-test
 * run would simply read 0% and look like a regression rather than a mix-up.
 */
const GRAPH_GOLD: Record<string, string> = {
  "selftest-g1": "fixtures/self-test/gold-checklist.json",
};

/**
 * What an evaluation of this graph would be scored against, before running one.
 *
 * The page used to name the arms and the switch but not the subject: which graph version,
 * produced by which prompts, judged against which checklist. Those three decide whether two
 * results are comparable at all, and a report six weeks old with none of them attached is a
 * pair of numbers.
 */
export function evalSubject(graphId: string): {
  graphId: string;
  version?: number;
  gold?: { path: string; items: number; heldOut: number };
  goldMissing?: string;
  /** The fingerprint of the instructions an evaluation started now would run under. */
  prompts?: string;
} {
  const def = getGraph(graphId);
  const prompts = runPromptDigest()?.combined;
  try {
    const { gold, path } = loadGold(undefined, graphId);
    return {
      graphId,
      version: def?.version,
      prompts,
      gold: { path, items: gold.items.length, heldOut: gold.items.filter((i) => i.heldOut).length },
    };
  } catch (e) {
    // A checklist that cannot be read is stated, not defaulted to: scoring against the
    // wrong checklist reads as a regression rather than a mix-up.
    return { graphId, version: def?.version, prompts, goldMissing: (e as Error).message };
  }
}

function loadGold(goldPath?: string, graphId?: string): { gold: GoldChecklist; path: string } {
  const path = goldPath ?? (graphId && GRAPH_GOLD[graphId]) ?? "fixtures/mock-spec/gold-checklist.json";
  const full = path.startsWith("/") ? path : resolve(REPO_ROOT, path);
  return { gold: JSON.parse(readFileSync(full, "utf8")) as GoldChecklist, path };
}

/** Cases out of whatever the scoring node produced, whichever stage it belongs to. */
/**
 * Score one finished run against a checklist.
 *
 * The paired evaluation answers "is B better than A". This answers the plainer question
 * that comes first — "did this decomposition find the things a person said mattered" —
 * which is the only question the bootstrap's first milestone asks.
 */
export async function scoreRun(req: {
  wfRunId: string;
  goldPath?: string;
  nodeId?: string;
  /** Also ask the model about the items the keyword rules missed. Slower, not comparable. */
  semantic?: boolean;
}): Promise<Record<string, unknown>> {
  const run = outputStore.getRun(req.wfRunId) as { graphId?: string } | undefined;
  if (!run) throw new Error(`no such run: ${req.wfRunId}`);
  const { gold, path } = loadGold(req.goldPath, run.graphId);

  const outputs = await allOutputs(req.wfRunId);
  const nodeId =
    req.nodeId ?? ["gate", "dedupe", "cases", "stories"].find((n) => casesOf(outputs[n]).length > 0);
  const cases = casesOf(nodeId ? outputs[nodeId] : undefined);
  if (!cases.length) throw new Error(`run ${req.wfRunId} produced no cases to score`);

  const coverage = scoreCoverage(gold, cases);

  // The keyword rules are a lower bound by construction: a case that checks the right thing
  // in words the checklist did not anticipate reads as a miss. Asking the model about the
  // misses says which of them are real gaps — a second number, deliberately not the main
  // one, because a model in the measurement makes runs no longer comparable to each other.
  const semantic = req.semantic
    ? await adjudicateMisses(gold, cases, coverage, gated(modelFromEnv()))
    : undefined;

  return {
    wfRunId: req.wfRunId,
    graphId: run.graphId,
    gold: path,
    nodeId,
    coverage: coverage.coverage,
    heldOut: coverage.heldOut,
    cases: cases.length,
    hits: coverage.hits.map((h) => h.goldId),
    misses: coverage.misses.map((m) => ({ id: m.id, title: m.title, heldOut: !!m.heldOut })),
    extras: coverage.extras.length,
    semantic,
    methodMix: methodMix(gold, coverage),
  };
}

function casesOf(output: unknown): CandidateCase[] {
  const bundle = output as { cases?: Array<{ id?: string; title: string; steps: string[]; expected: string }> };
  return (bundle?.cases ?? []).map((c) => ({
    id: c.id,
    title: c.title,
    steps: c.steps ?? [],
    expected: c.expected ?? "",
  }));
}

/**
 * Did the instructions move between the arms?
 *
 * The arms run one after the other and a run takes tens of minutes, which is plenty of
 * time to edit a prompt — in source, or from the Model config page. When that happens the
 * subtraction is between two different harnesses and the number belongs to neither. Said
 * loudly rather than adjusted for: there is no honest way to correct it after the fact.
 */
function promptDrift(a: ArmResult, b: ArmResult): string | undefined {
  if (!a.prompts || !b.prompts) return undefined;
  if (a.prompts.combined === b.prompts.combined) return undefined;
  const moved = digestDiff(a.prompts, b.prompts);
  return `the prompts changed between the arms (${moved.join(", ")}) — this comparison is between two different harnesses, not two arms`;
}

/**
 * Are the two arms actually different?/**
 * Are the two arms actually different?
 *
 * Worth checking rather than assuming: an arm that differs by a parameter the graph does
 * not have, or by nothing at all, produces a perfectly formatted report of noise — and the
 * report reads exactly like a real effect.
 */
function sameConfiguration(a: EvalArm, b: EvalArm): boolean {
  const key = (arm: EvalArm) =>
    JSON.stringify({
      ablate: [...(arm.ablate ?? [])].sort(),
      params: arm.params ?? {},
      graphVersion: arm.graphVersion ?? null,
    });
  return key(a) === key(b);
}

async function runArm(req: PairedEvalRequest, arm: EvalArm, gold: GoldChecklist): Promise<ArmResult> {
  const { on, unknown } = parseAblation(arm.ablate);
  // A typo in an ablation name would otherwise produce a run that changed nothing and a
  // report claiming it did.
  if (unknown.length) throw new Error(`unknown ablation switch(es): ${unknown.join(", ")}`);

  const started = await startRun({
    graphId: req.graphId,
    target: req.target,
    seed: req.seed,
    ablate: on,
    params: arm.params,
    graphVersion: arm.graphVersion,
  });
  const detail = await waitForRun(started.wfRunId);
  const nodeId = req.casesNode ?? "gate";
  const output = await nodeOutput(started.wfRunId, nodeId).catch(() => undefined);
  const cases = casesOf(output);
  const coverage = scoreCoverage(gold, cases);

  return {
    label: arm.label,
    wfRunId: started.wfRunId,
    ablate: on,
    params: arm.params,
    graphVersion: started.graph.version,
    prompts: (detail as { prompts?: TextDigest }).prompts,
    status: String(detail.status ?? "unknown"),
    coverage: coverage.coverage,
    heldOutCoverage: coverage.heldOut.coverage,
    covered: coverage.hits.map((h) => h.goldId),
    cases: cases.length,
    spend: (detail.spend as ArmResult["spend"]) ?? { calls: 0, tokens: 0, ms: 0 },
    gateScore: (output as { gate?: { score?: number } })?.gate?.score,
  };
}

/** Poll the run record until the run finishes. Runs are minutes long; events drive the UI. */
async function waitForRun(wfRunId: string): Promise<Record<string, unknown>> {
  for (;;) {
    const row = outputStore.getRun(wfRunId);
    if (row && row.status !== "running")
      return { status: row.status, ...((row.detail as Record<string, unknown>) ?? {}) };
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/**
 * Run both arms and subtract. Sequential, not parallel: the model admits one call at a
 * time anyway, and overlapping the arms would make each one's duration meaningless.
 */
export async function runPairedEval(req: PairedEvalRequest): Promise<PairedEvalResult> {
  const { gold, path } = loadGold(req.goldPath, req.graphId);
  const id = `eval-${Date.now().toString(36)}`;
  const startedAt = new Date().toISOString();
  save({ id, graphId: req.graphId, startedAt, status: "running", detail: { a: req.a, b: req.b } });
  bus.publish("eval.started", { id, graphId: req.graphId, arms: [req.a.label, req.b.label] }, {});

  try {
    const a = await runArm(req, req.a, gold);
    const b = await runArm(req, req.b, gold);

    // The paired unit is a gold item, not a case: "did each arm cover this requirement".
    const pairs: PairedBinary[] = gold.items.map((item) => ({
      id: item.id,
      a: a.covered.includes(item.id),
      b: b.covered.includes(item.id),
    }));

    const result: PairedEvalResult = {
      id,
      graphId: req.graphId,
      gold: path,
      a,
      b,
      mcnemar: mcnemar(pairs),
      coverageDelta: comparePaired([
        { id: "coverage", a: a.coverage, b: b.coverage },
        { id: "heldOut", a: a.heldOutCoverage, b: b.heldOutCoverage },
      ]),
      costDelta: {
        calls: b.spend.calls - a.spend.calls,
        tokens: b.spend.tokens - a.spend.tokens,
        ms: b.spend.ms - a.spend.ms,
      },
      methodMix: {
        a: methodMix(gold, scoreCoverageFor(gold, a.covered)),
        b: methodMix(gold, scoreCoverageFor(gold, b.covered)),
      },
      startedAt,
      finishedAt: new Date().toISOString(),
      spec: req.spec,
      prediction: req.spec?.expect
        ? (() => {
            const observed = observedDirection(mcnemar(pairs));
            const expected = req.spec!.expect!.direction;
            return {
              expected,
              observed,
              significant: mcnemar(pairs).p < 0.05,
              // `unknown` 是一个诚实的答案，不是一次错误的预判——所以它既不算对也不算错。
              matched: expected === "unknown" ? undefined : expected === observed,
            };
          })()
        : undefined,
      note: promptDrift(a, b) ?? (sameConfiguration(req.a, req.b)
        ? "both arms ran the same configuration — this measures run-to-run variation, not a change"
        : ""),
    };

    save({ id, graphId: req.graphId, startedAt, finishedAt: result.finishedAt, status: "done", detail: result });
    bus.publish("eval.finished", { id, reading: result.mcnemar.reading }, {});
    return result;
  } catch (e) {
    save({
      id,
      graphId: req.graphId,
      startedAt,
      finishedAt: new Date().toISOString(),
      status: "failed",
      detail: { error: (e as Error).message },
    });
    bus.publish("eval.finished", { id, error: (e as Error).message }, {});
    throw e;
  }
}

/* ---- the harness critic ---- */

export interface CritiqueRequest {
  /** Runs to learn from. Empty means the most recent finished ones. */
  wfRunIds?: string[];
  limit?: number;
}

/**
 * Gather what recent runs revealed and ask the critic what to change about the harness.
 *
 * The suggestions are stored as *proposals*. Nothing here adopts one: a suggestion that
 * names an ablation switch can be handed to a paired evaluation, and that evaluation is
 * what decides. The critic is a model reviewing a model's work — the only thing keeping
 * that honest is that it does not get to score itself.
 */
export async function runCritique(req: CritiqueRequest): Promise<Record<string, unknown>> {
  const ids = req.wfRunIds?.length
    ? req.wfRunIds
    : outputStore
        .listRuns(req.limit ?? 8)
        .filter((r) => r.status === "done")
        .map((r) => String(r.id));

  const gateFindings: Array<{ rule: string; message: string; severity?: string }> = [];
  const coverageMisses: string[] = [];
  const outcomes: Array<{ status: string; failKind?: string }> = [];
  const degraded: string[] = [];
  const repairRounds: Array<{ changes: string[] }> = [];
  const spend = { calls: 0, tokens: 0 };

  for (const id of ids) {
    const row = outputStore.getRun(id);
    const detail = row?.detail as { spend?: { calls?: number; tokens?: number } } | undefined;
    spend.calls += detail?.spend?.calls ?? 0;
    spend.tokens += detail?.spend?.tokens ?? 0;

    // A requirement nothing covered is a decomposition problem, and it is invisible in the
    // gate findings — the gate judges the cases that exist, never the ones that do not.
    try {
      const scored = (await scoreRun({ wfRunId: id })) as { misses?: Array<{ title: string }> };
      coverageMisses.push(...(scored.misses ?? []).map((m) => m.title));
    } catch {
      /* a run with no cases or no checklist simply contributes no misses */
    }

    for (const node of ["gate", "codegate", "repair"]) {
      const out = (await nodeOutput(id, node).catch(() => undefined)) as
        | {
            gate?: { findings?: Array<{ rule: string; message: string; severity?: string }> };
            repair?: { degraded?: string[]; rounds?: Array<{ changes: string[] }>; outcomes?: Array<{ status: string; failKind?: string }> };
          }
        | undefined;
      if (!out) continue;
      gateFindings.push(...(out.gate?.findings ?? []));
      degraded.push(...(out.repair?.degraded ?? []));
      repairRounds.push(...(out.repair?.rounds ?? []));
      outcomes.push(...(out.repair?.outcomes ?? []));
    }
  }

  const evidence = collectEvidence({
    runs: ids.length,
    gateFindings,
    coverageMisses: [...new Set(coverageMisses)],
    outcomes,
    degraded,
    repairRounds,
    spend,
  });
  const result = await critique(evidence, gated(modelFromEnv()), { ablatable: ALL_ABLATABLE });

  const id = `crit-${Date.now().toString(36)}`;
  const detail = { id, runs: ids, ...result, at: new Date().toISOString() };
  db.prepare(
    `INSERT INTO critiques (id, at, runs, testable, json) VALUES (?, ?, ?, ?, ?)`,
  ).run(id, detail.at, ids.length, result.testable, JSON.stringify(detail));
  bus.publish("critic.finished", { id, suggestions: result.suggestions.length, testable: result.testable }, {});
  return detail;
}

export const listCritiques = (limit = 20): Array<Record<string, unknown>> =>
  (db.prepare("SELECT json FROM critiques ORDER BY at DESC LIMIT ?").all(limit) as Array<{ json: string }>).map(
    (r) => JSON.parse(r.json) as Record<string, unknown>,
  );

/* ---- detection power: how much of a real fault does this suite catch? ---- */

export interface DetectionEvalRequest {
  /** Where the executable cases come from. */
  wfRunId: string;
  node?: string;
  /** Which injected faults to try. Empty means all of them. */
  defects?: string[];
  target?: RunTarget;
  /** Cases to run per build. Each one costs a browser session and model time. */
  limit?: number;
}

export interface DetectionEvalResult {
  id: string;
  wfRunId: string;
  /** Cases that failed on the healthy build. Every one of them is a false alarm. */
  falseAlarms: string[];
  falseAlarmRate: number;
  /** One row per injected fault: did any case notice? */
  mutants: Array<{ defect: string; title: string; killed: boolean; killedBy: string[]; ran: number }>;
  mutationScore: number;
  cases: number;
  note: string;
  startedAt: string;
  finishedAt: string;
}

/**
 * Fault injection, scored the way mutation testing scores it.
 *
 * Deliberately NOT per-case precision/recall: that needs a label saying "this case should
 * have caught this fault", and inventing those labels would make the metric a measure of
 * my labelling rather than of the suite. What can be known without inventing anything is:
 *
 *   healthy build → every failure is a false alarm (nothing is wrong, so nothing should fail)
 *   faulty build  → was the fault noticed by anyone at all (killed), or did it slip through
 *
 * `scoreDetection` (with real per-case labels) stays available for when a labelled dataset
 * exists — this is the version that is honest with the data actually on hand.
 */
export async function runDetectionEval(req: DetectionEvalRequest): Promise<DetectionEvalResult> {
  const id = `det-${Date.now().toString(36)}`;
  const startedAt = new Date().toISOString();
  // Recorded before the work starts: an evaluation that only appears when it finishes
  // vanishes entirely if anything restarts, and then nobody knows it ever ran.
  save({ id, graphId: req.wfRunId, startedAt, status: "running", detail: { request: req } });
  const bundle = (await nodeOutput(req.wfRunId, req.node ?? "repair")) as
    | { code?: Array<{ caseId: string; title: string; actions: unknown[]; uses: string[] }>; fragments?: unknown[] }
    | undefined;
  const code = (bundle?.code ?? []).slice(0, req.limit ?? 3);
  if (!code.length) throw new Error(`run ${req.wfRunId} has no executable cases at node ${req.node ?? "repair"}`);

  const baseUrl = req.target?.url ?? "http://localhost:5301/testlogin";
  const run = async (caseEntry: (typeof code)[number], url: string) =>
    executeCase({ ...req.target, url }, caseEntry, (bundle?.fragments ?? []) as never);

  // 1. The healthy build. A failure here says nothing about the product.
  const falseAlarms: string[] = [];
  for (const c of code) {
    const outcome = await run(c, baseUrl);
    if (outcome.status === "failed" && outcome.failKind !== "infra") falseAlarms.push(c.caseId);
  }

  // 2. Each fault in turn.
  const wanted = req.defects?.length ? req.defects : Object.keys(DEFECT_TITLES);
  const mutants: DetectionEvalResult["mutants"] = [];
  for (const defect of wanted) {
    const killedBy: string[] = [];
    let ran = 0;
    for (const c of code) {
      // A case that already cries wolf on the healthy build cannot be credited with a kill.
      if (falseAlarms.includes(c.caseId)) continue;
      ran += 1;
      const outcome = await run(c, `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}defect=${defect}`);
      if (outcome.status === "failed" && outcome.failKind !== "infra") killedBy.push(c.caseId);
    }
    mutants.push({ defect, title: DEFECT_TITLES[defect] ?? defect, killed: killedBy.length > 0, killedBy, ran });
    bus.publish("eval.mutant", { id, defect, killed: killedBy.length > 0 }, {});
  }

  const result: DetectionEvalResult = {
    id,
    wfRunId: req.wfRunId,
    falseAlarms,
    falseAlarmRate: code.length ? Number((falseAlarms.length / code.length).toFixed(3)) : 0,
    mutants,
    mutationScore: mutants.length
      ? Number((mutants.filter((m) => m.killed).length / mutants.length).toFixed(3))
      : 0,
    cases: code.length,
    note:
      "mutation score is a suite-level number: a fault counts as caught if any case notices it. " +
      "Per-case precision/recall would need labels that do not exist for these cases.",
    startedAt,
    finishedAt: new Date().toISOString(),
  };
  save({ id, graphId: req.wfRunId, startedAt, finishedAt: result.finishedAt, status: "done", detail: result });
  return result;
}

/** Same treatment as workflow runs: an evaluation cannot stay "running" across a restart. */
export function reconcileOrphanedEvals(log: (msg: string) => void): void {
  const stuck = db.prepare("SELECT id FROM evals WHERE status='running'").all() as Array<{ id: string }>;
  for (const row of stuck) {
    db.prepare("UPDATE evals SET status='interrupted', finishedAt=? WHERE id=?").run(
      new Date().toISOString(),
      row.id,
    );
    log(`eval ${row.id} was interrupted by a restart`);
  }
}

/** Titles for the faults the fixture can inject; filled by the gateway at startup. */
export const DEFECT_TITLES: Record<string, string> = {};

/** Wired by the gateway: executing a case needs the environment bindings and a runner. */
let executeCase: (
  target: RunTarget,
  kase: { caseId: string; title: string; actions: unknown[]; uses: string[] },
  fragments: never,
) => Promise<{ status: string; failKind?: string }>;
export const setCaseExecutor = (fn: typeof executeCase): void => {
  executeCase = fn;
};

/** methodMix wants a CoverageResult; only the hit list matters here. */
function scoreCoverageFor(gold: GoldChecklist, covered: string[]): CoverageResult {
  return {
    coverage: 0,
    hits: covered.map((goldId) => ({ goldId, by: [] })),
    misses: gold.items.filter((i) => !covered.includes(i.id)),
    extras: [],
    heldOut: { coverage: 0, hits: [], misses: [] },
    totals: { gold: gold.items.length, heldOut: 0, cases: 0 },
  };
}
