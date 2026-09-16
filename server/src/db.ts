import { DATA_DIR } from "./datadir.js";
import type { RunSpend } from "@testpilot/harness-testing";
import type {
  ChainAssertion,
  MachineOracle,
  OracleCheck,
  StorageState,
  VisualDiff,
  VisualStatus,
} from "@testpilot/harness-testing";
// These types describe what crosses the process boundary to the runner, so the domain
// package owns them; re-exported here because the whole gateway imports them from db.
export type { ChainAssertion, OracleCheck, StorageState, VisualDiff, VisualStatus };

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { encryptSecret, decryptSecret } from "./vault.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(resolve(DATA_DIR, "testpilot.db"));
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS model_profiles (
  projectId TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('planner', 'executor')),
  version INTEGER NOT NULL, profileJson TEXT NOT NULL, keyEnc TEXT,
  createdAt TEXT NOT NULL, PRIMARY KEY(projectId, role, version)
);
CREATE TABLE IF NOT EXISTS run_model_snapshots (
  runId TEXT PRIMARY KEY, projectId TEXT, bindingJson TEXT NOT NULL,
  connectionsEnc TEXT NOT NULL, createdAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, targetUrl TEXT NOT NULL, createdAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS test_cases (
  id TEXT PRIMARY KEY,
  projectId TEXT NOT NULL,
  title TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'P1',
  priorityReason TEXT DEFAULT '',
  runStatus TEXT NOT NULL DEFAULT 'notRun',
  hasCode INTEGER NOT NULL DEFAULT 0,
  precondition TEXT DEFAULT '',
  steps TEXT NOT NULL DEFAULT '[]',
  code TEXT DEFAULT '',
  createdAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  caseId TEXT NOT NULL,
  caseTitle TEXT NOT NULL,
  priority TEXT NOT NULL,
  status TEXT NOT NULL,
  durationMs INTEGER NOT NULL,
  startedAt TEXT NOT NULL,
  failureReason TEXT,
  logs TEXT NOT NULL DEFAULT '[]',
  screenshots TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_cases_project ON test_cases(projectId);
CREATE INDEX IF NOT EXISTS idx_runs_case ON runs(caseId);

-- Visual baseline: one approved reference image per (case, step).
CREATE TABLE IF NOT EXISTS baselines (
  id TEXT PRIMARY KEY,
  caseId TEXT NOT NULL,
  stepIdx INTEGER NOT NULL,
  imgPath TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  UNIQUE(caseId, stepIdx)
);
CREATE INDEX IF NOT EXISTS idx_baselines_case ON baselines(caseId);

-- Performance baseline: one metrics snapshot per case.
CREATE TABLE IF NOT EXISTS perf_baselines (
  caseId TEXT PRIMARY KEY,
  metricsJson TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

-- Environments: per-project target + non-secret variables + a central login flow
-- (login state) reused across cases. varsJson holds env.* placeholder values;
-- loginJson = { authRequired: bool, steps: string[] } (steps may reference env/secret vars).
CREATE TABLE IF NOT EXISTS environments (
  id TEXT PRIMARY KEY,
  projectId TEXT NOT NULL,
  name TEXT NOT NULL,
  baseUrl TEXT NOT NULL DEFAULT '',
  varsJson TEXT NOT NULL DEFAULT '{}',
  loginJson TEXT NOT NULL DEFAULT '{}',
  headersJson TEXT NOT NULL DEFAULT '{}',   -- fixed request headers (may hold secret refs)
  queryJson TEXT NOT NULL DEFAULT '{}',     -- fixed query-string params appended to navigations
  sessionEnc TEXT NOT NULL DEFAULT '',      -- captured login state (storageState), AES-encrypted
  viewportJson TEXT NOT NULL DEFAULT '{}',   -- 这个被测对象要多大的视口（见 U-69）
  visualThresholdPct REAL,                   -- 这个被测对象的视觉差异阈值；空=用默认 0.5
  isDefault INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL,
  UNIQUE(projectId, name)
);
CREATE INDEX IF NOT EXISTS idx_env_project ON environments(projectId);

-- Secrets vault: value stored ONLY as AES-256-GCM ciphertext (see vault.ts).
-- The plaintext never touches this DB. Scoped per project (envId optional override).
CREATE TABLE IF NOT EXISTS secrets (
  id TEXT PRIMARY KEY,
  projectId TEXT NOT NULL,
  envId TEXT,
  key TEXT NOT NULL,
  valueEnc TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  UNIQUE(projectId, envId, key)
);
CREATE INDEX IF NOT EXISTS idx_secrets_project ON secrets(projectId);

-- Suite/batch runs: a fan-out of cases through the concurrency queue, with a
-- CI gate (pass/fail) and flake accounting. One batches row per suite run.
CREATE TABLE IF NOT EXISTS batches (
  id TEXT PRIMARY KEY,
  projectId TEXT NOT NULL,
  label TEXT NOT NULL,
  status TEXT NOT NULL,                       -- running | done
  total INTEGER NOT NULL DEFAULT 0,
  passed INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  healed INTEGER NOT NULL DEFAULT 0,          -- passed only after a self-heal retry
  flaky INTEGER NOT NULL DEFAULT 0,
  quarantined INTEGER NOT NULL DEFAULT 0,     -- ran but excluded from the gate
  errored INTEGER NOT NULL DEFAULT 0,         -- infra/model errors (no verdict)
  gate TEXT NOT NULL DEFAULT 'pass',          -- pass | fail (CI门禁)
  startedAt TEXT NOT NULL,
  finishedAt TEXT
);
CREATE INDEX IF NOT EXISTS idx_batches_project ON batches(projectId);
CREATE TABLE IF NOT EXISTS batch_runs (
  batchId TEXT NOT NULL,
  caseId TEXT NOT NULL,
  caseTitle TEXT NOT NULL,
  runId TEXT,
  status TEXT NOT NULL,                       -- passed | failed | quarantined
  attempts INTEGER NOT NULL DEFAULT 1,
  healed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (batchId, caseId)
);

-- Per-case flake governance: stability over a rolling window of recent runs.
CREATE TABLE IF NOT EXISTS flakiness (
  caseId TEXT PRIMARY KEY,
  windowSize INTEGER NOT NULL,
  passes INTEGER NOT NULL,
  fails INTEGER NOT NULL,
  healedCount INTEGER NOT NULL,
  failRate REAL NOT NULL,
  verdict TEXT NOT NULL,                      -- stable | flaky | broken | unknown
  updatedAt TEXT NOT NULL
);

-- 隔离台账：谁、什么时候、为什么，以及当时门禁是什么判决。
--
-- 隔离是**唯一一个会改变门禁结论的人工动作**：一条被隔离的用例照跑，但它的红不再拦门禁。
-- 没有台账的话，一个绿灯说不清自己是「真的都过了」还是「挂的那几条被人挪出去了」，
-- 而那正是这套东西最容易被悄悄绕过的地方。所以理由是必填的，记录只增不删。
CREATE TABLE IF NOT EXISTS quarantine_log (
  id TEXT PRIMARY KEY,
  caseId TEXT NOT NULL,
  projectId TEXT NOT NULL,
  on_ INTEGER NOT NULL,                       -- 1 = 隔离，0 = 解除
  reason TEXT NOT NULL,
  by TEXT NOT NULL,
  at TEXT NOT NULL,
  -- 当时最近一次批次的门禁判决。隔离影响的就是它——写下来，事后能对上。
  gateAtTime TEXT
);
CREATE INDEX IF NOT EXISTS idx_qlog_project ON quarantine_log(projectId);
CREATE INDEX IF NOT EXISTS idx_qlog_case ON quarantine_log(caseId);

-- 基线待办的裁决。
--
-- 「接受为新基线」此前是**唯一一个出口**——于是一次真回归和一次改版走同一个按钮，
-- 而按下去之后回归就变成了新的正确答案。三个出口：接受 / 判为回归 / 承认是环境噪声。
-- 后两个都不动基线：回归要让这条用例继续红，噪声只是把这一条从待办里划掉。
CREATE TABLE IF NOT EXISTS baseline_verdicts (
  id TEXT PRIMARY KEY,
  caseId TEXT NOT NULL,
  projectId TEXT NOT NULL,
  kind TEXT NOT NULL,                         -- visual | perf
  stepIdx INTEGER,
  runId TEXT NOT NULL,
  verdict TEXT NOT NULL,                      -- regression | noise
  note TEXT NOT NULL DEFAULT '',
  by TEXT NOT NULL DEFAULT 'unknown',
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bverdict_case ON baseline_verdicts(caseId);
`);

// Migrations: add columns if missing (DB may predate them).
const runCols = new Set(
  (db.prepare("PRAGMA table_info(runs)").all() as { name: string }[]).map((r) => r.name),
);
if (!runCols.has("reportPath")) db.exec("ALTER TABLE runs ADD COLUMN reportPath TEXT");
if (!runCols.has("visualJson"))
  db.exec("ALTER TABLE runs ADD COLUMN visualJson TEXT NOT NULL DEFAULT '[]'");
if (!runCols.has("tokens")) db.exec("ALTER TABLE runs ADD COLUMN tokens INTEGER");
// 一次运行的账（模型调用数/毫秒/缓存三态），见 harness-testing `RunSpend`。tokens 单列保留，spendJson 是它的展开。
if (!runCols.has("spendJson")) db.exec("ALTER TABLE runs ADD COLUMN spendJson TEXT");
if (!runCols.has("perfJson")) db.exec("ALTER TABLE runs ADD COLUMN perfJson TEXT");
if (!runCols.has("oracleJson"))
  db.exec("ALTER TABLE runs ADD COLUMN oracleJson TEXT NOT NULL DEFAULT '[]'");
// Flake governance: how many attempts a run took, and whether it only passed after a self-heal.
if (!runCols.has("attempts"))
  db.exec("ALTER TABLE runs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 1");
if (!runCols.has("healed"))
  db.exec("ALTER TABLE runs ADD COLUMN healed INTEGER NOT NULL DEFAULT 0");
// Infra/model error (couldn't get a verdict) vs a real test failure — kept out of flake/MTTR.
if (!runCols.has("infraError")) {
  db.exec("ALTER TABLE runs ADD COLUMN infraError INTEGER NOT NULL DEFAULT 0");
  // Backfill: reclassify historical model/network failures so old flake stats self-correct.
  db.exec(
    "UPDATE runs SET infraError=1 WHERE status='failed' AND (" +
      "failureReason LIKE '%AI model service%' OR failureReason LIKE '%terminated%' OR " +
      "failureReason LIKE '%ECONNREFUSED%' OR failureReason LIKE '%502%' OR failureReason LIKE '%timeout%')",
  );
}
// Structured failure attribution (docs/archive/spec/06). `infraError` stays for compatibility;
// these two say WHICH kind of failure it was, which is what the statistics bucket by.
if (!runCols.has("failCode")) db.exec("ALTER TABLE runs ADD COLUMN failCode TEXT");
if (!runCols.has("failKind")) db.exec("ALTER TABLE runs ADD COLUMN failKind TEXT");

// A case executed inside a workflow run is still an execution.
//
// 执行记录 used to list only suite batches, and product runs were the only thing written
// here at all — so a project whose cases were exercised by the repair loop showed an empty
// execution page. An empty page reads as "never ran", which was false: those cases had run,
// passed, and their timings were sitting in the workflow's repair report where the board
// could not see them.
//
// `projectId` is stored rather than joined because a workflow execution has no board case
// to join through: it runs a candidate (`S-01-1-…`) that only becomes `tc-…` if someone
// approves it later, and may never. `origin` is what keeps the two readable apart.
if (!runCols.has("origin"))
  db.exec("ALTER TABLE runs ADD COLUMN origin TEXT NOT NULL DEFAULT 'board'");
if (!runCols.has("wfRunId")) db.exec("ALTER TABLE runs ADD COLUMN wfRunId TEXT");
if (!runCols.has("projectId")) {
  db.exec("ALTER TABLE runs ADD COLUMN projectId TEXT");
  // Backfill once, from the join the page used to do at read time. Rows whose case has
  // since been deleted stay null and simply do not appear under any project.
  db.exec(
    `UPDATE runs SET projectId =
       (SELECT c.projectId FROM test_cases c WHERE c.id = runs.caseId)
     WHERE projectId IS NULL`,
  );
}

// Which end the project is tested on. It decides what the rest of the UI may offer: web3
// and chain configuration are web-only capabilities, and leaving them visible on an iOS
// project would be offering a control that cannot do anything. Defaults to 'web' so every
// project that predates the column keeps behaving exactly as it did.
const projCols = new Set(
  (db.prepare("PRAGMA table_info(projects)").all() as { name: string }[]).map((r) => r.name),
);
if (!projCols.has("targetPlatform"))
  db.exec("ALTER TABLE projects ADD COLUMN targetPlatform TEXT NOT NULL DEFAULT 'web'");
/**
 * 这个项目的规格来自哪几份文档。
 *
 * 建项目时只有名称、URL、目标端三格——没有地方交材料。可是 `spec.compose` 明确认两种
 * 来源，而它们**能说明的事完全不同**：文档表达意图，所以对着它写的用例可能发现「产品错了」；
 * 探索表达现状，对着它写的用例只可能发现「产品变了」，永远不可能发现「产品错了」
 * ——观察不可能反驳被观察者。
 *
 * 一个从不交材料的项目，它的整套用例都只是回归网。这一列存在，是为了让这件事在建项目
 * 那一刻就被问一次。
 */
if (!projCols.has("materialsJson"))
  db.exec("ALTER TABLE projects ADD COLUMN materialsJson TEXT NOT NULL DEFAULT '[]'");

// Where a generated case came from and what the harness thought of it. A case that entered
// the board through review should still be able to answer "which run made me, from which
// story, by which design method" — otherwise the board loses the traceability that gate ①
// spent its effort establishing.
const genCols = new Set(
  (db.prepare("PRAGMA table_info(test_cases)").all() as { name: string }[]).map((r) => r.name),
);
if (!genCols.has("storyId")) db.exec("ALTER TABLE test_cases ADD COLUMN storyId TEXT");
if (!genCols.has("designMethod")) db.exec("ALTER TABLE test_cases ADD COLUMN designMethod TEXT");
if (!genCols.has("tier")) db.exec("ALTER TABLE test_cases ADD COLUMN tier INTEGER");
if (!genCols.has("gateScore")) db.exec("ALTER TABLE test_cases ADD COLUMN gateScore REAL");
if (!genCols.has("sourceRunId")) db.exec("ALTER TABLE test_cases ADD COLUMN sourceRunId TEXT");
// The machine-checkable form of the case's outcome, when stage one produced one. Stored
// with the case because the board runs cases too, and a verdict that only the workflow
// path could settle deterministically would make the two paths disagree.
if (!genCols.has("oracleJson")) db.exec("ALTER TABLE test_cases ADD COLUMN oracleJson TEXT");
// Whether this case only went green after its assertion was weakened during repair. It is
// the one mark on the board that says "this pass is worth less than it looks".
if (!genCols.has("degraded")) db.exec("ALTER TABLE test_cases ADD COLUMN degraded INTEGER NOT NULL DEFAULT 0");
/**
 * 模块与覆盖的转移：批准这一步此前把它们丢在门外。
 *
 * `activity` 在规格里是**算出来的**（`computeModules` 按路由聚类，模型只贡献名字），
 * 故事的 activity 还被约束成模块名的枚举——一等实体，做得相当讲究。可是看板没有这一列，
 * 于是它活不过 `approve()`：批准之后再也没人说得出这条用例属于哪个模块，
 * 看板没法按模块分组，导出也没法按模块建目录。
 *
 * `covers` 同理：它是唯一一根**来自产品本身**的追溯线（一共 M 条转移，覆盖了几条），
 * 丢掉之后结构覆盖率只能一批一批地算，没法在项目层累计。
 */
if (!genCols.has("activity")) db.exec("ALTER TABLE test_cases ADD COLUMN activity TEXT DEFAULT ''");
if (!genCols.has("coversJson"))
  db.exec("ALTER TABLE test_cases ADD COLUMN coversJson TEXT NOT NULL DEFAULT '[]'");
/**
 * `acRefs` 同理，而且是这三根线里最直接的一根：**这条用例了结的是哪条验收准则**。
 *
 * 2026-09-14 之后它才真正值钱——那天起 `acRefs` 从自由文本变成了稳定编号
 * （`S-05/AC-2`，见 `acceptanceIndex.ts`），95 条引用里 0 条是模型自己编的。
 * 而它到看板这一步就被丢掉了，于是导出的 spec 只说得出 `@story:S-MB-01`，
 * 说不出是哪条准则——一条测试红了，人还是得回平台去猜它本来想证明什么。
 */
if (!genCols.has("acRefsJson"))
  db.exec("ALTER TABLE test_cases ADD COLUMN acRefsJson TEXT NOT NULL DEFAULT '[]'");

/**
 * 抽取层的记忆：这个项目里曾经被命名过的步骤与共享前置。
 *
 * 见 `exportLayers.ts` 的 `LayerMemory`——门槛（至少两条用例用它）会让成员资格随
 * 用例增删而变，于是加一条用例会把一批不相干的 spec 一起改。记住命名过的内容，
 * 让这一层只增不减；导出对增量就没有多余的 diff。
 *
 * 按**内容**记，不按名字：名字本来就是内容的函数（slug 化的原文）。
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS export_layer_memory (
    projectId TEXT NOT NULL,
    kind TEXT NOT NULL,
    key TEXT NOT NULL,
    PRIMARY KEY (projectId, kind, key))`);

// Review decisions live apart from the cases, because a rejection has no case to hang on:
// the point of recording it is that the queue stops offering it again.
db.exec(`
  CREATE TABLE IF NOT EXISTS review_decisions (
    wfRunId TEXT NOT NULL,
    caseId TEXT NOT NULL,
    decision TEXT NOT NULL,
    note TEXT,
    createdCaseId TEXT,
    at TEXT NOT NULL,
    PRIMARY KEY (wfRunId, caseId)
  );
`);
// Edits made in the review queue, kept apart from both the product and the board: the
// workflow's output is what the harness produced and must stay as it was (it is evidence
// in every later comparison), while the board only ever sees a case that was approved. An
// edit is the third thing — a proposal, waiting on the same decision as the case itself.
db.exec(`
  CREATE TABLE IF NOT EXISTS review_edits (
    wfRunId TEXT NOT NULL,
    caseId TEXT NOT NULL,
    json TEXT NOT NULL,
    at TEXT NOT NULL,
    PRIMARY KEY (wfRunId, caseId)
  );
`);

/**
 * 从一条缺口补出来的用例。
 *
 * 缺口分析（`gaps.ts`）能把缺口分成三类、算得出、显示得出——**然后停在那里**：
 * 没有任何一条代码路径把一条缺口变回一条用例。「这套 harness 会把自己漏掉的东西
 * 补回来」这句话今天说不出口，缺的就是这张表。
 *
 * 为什么不写进那次运行的产出：运行的产出是**证据**，它必须保持原样，
 * 否则以后每一次对比都在跟一个被后来改过的东西比。补出来的用例是第三样东西——
 * 一份提案，和复核队列里的编辑一样，等的是同一个决定。
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS gap_cases (
    id TEXT PRIMARY KEY,
    wfRunId TEXT NOT NULL,
    projectId TEXT NOT NULL,
    gapWhat TEXT NOT NULL,
    gapKind TEXT NOT NULL,
    anchorJson TEXT NOT NULL DEFAULT '{}',
    caseJson TEXT NOT NULL,
    at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_gapcase_run ON gap_cases(wfRunId);
`);

const caseCols = new Set(
  (db.prepare("PRAGMA table_info(test_cases)").all() as { name: string }[]).map((r) => r.name),
);
if (!caseCols.has("expected"))
  db.exec("ALTER TABLE test_cases ADD COLUMN expected TEXT DEFAULT ''");
// Case spec upgrade (§3.2 gold-standard): design type, requirement trace, env binding, cleanup.
if (!caseCols.has("type"))
  db.exec("ALTER TABLE test_cases ADD COLUMN type TEXT NOT NULL DEFAULT 'functional'");
if (!caseCols.has("requirementId"))
  db.exec("ALTER TABLE test_cases ADD COLUMN requirementId TEXT DEFAULT ''");
if (!caseCols.has("envRef"))
  db.exec("ALTER TABLE test_cases ADD COLUMN envRef TEXT DEFAULT ''");
if (!caseCols.has("postSteps"))
  db.exec("ALTER TABLE test_cases ADD COLUMN postSteps TEXT NOT NULL DEFAULT '[]'");
if (!caseCols.has("quarantined"))
  db.exec("ALTER TABLE test_cases ADD COLUMN quarantined INTEGER NOT NULL DEFAULT 0");
if (!caseCols.has("dataKey"))
  db.exec("ALTER TABLE test_cases ADD COLUMN dataKey TEXT DEFAULT ''");
if (!caseCols.has("web3Mode"))
  db.exec("ALTER TABLE test_cases ADD COLUMN web3Mode TEXT DEFAULT ''");
if (!caseCols.has("chainAssertionsJson"))
  db.exec("ALTER TABLE test_cases ADD COLUMN chainAssertionsJson TEXT NOT NULL DEFAULT '[]'");
const batchCols = new Set(
  (db.prepare("PRAGMA table_info(batches)").all() as { name: string }[]).map((r) => r.name),
);
if (batchCols.size && !batchCols.has("errored"))
  db.exec("ALTER TABLE batches ADD COLUMN errored INTEGER NOT NULL DEFAULT 0");
// Data-binding upgrade: fixed request headers, query params, and captured login state.
const envCols = new Set(
  (db.prepare("PRAGMA table_info(environments)").all() as { name: string }[]).map((r) => r.name),
);
if (envCols.size && !envCols.has("headersJson"))
  db.exec("ALTER TABLE environments ADD COLUMN headersJson TEXT NOT NULL DEFAULT '{}'");
if (envCols.size && !envCols.has("queryJson"))
  db.exec("ALTER TABLE environments ADD COLUMN queryJson TEXT NOT NULL DEFAULT '{}'");
if (envCols.size && !envCols.has("sessionEnc"))
  db.exec("ALTER TABLE environments ADD COLUMN sessionEnc TEXT NOT NULL DEFAULT ''");
if (envCols.size && !envCols.has("viewportJson"))
  db.exec("ALTER TABLE environments ADD COLUMN viewportJson TEXT NOT NULL DEFAULT '{}'");
if (envCols.size && !envCols.has("visualThresholdPct"))
  db.exec("ALTER TABLE environments ADD COLUMN visualThresholdPct REAL");
// 环境画像：前提名、默认注入钱包。（`allowIrreversible` 列是遗留的：2026-09-16 起不可逆步骤默认放行。）
if (envCols.size && !envCols.has("capabilitiesJson"))
  db.exec("ALTER TABLE environments ADD COLUMN capabilitiesJson TEXT NOT NULL DEFAULT '[]'");
if (envCols.size && !envCols.has("injectWallet"))
  db.exec("ALTER TABLE environments ADD COLUMN injectWallet INTEGER NOT NULL DEFAULT 0");
if (envCols.size && !envCols.has("allowIrreversible"))
  db.exec("ALTER TABLE environments ADD COLUMN allowIrreversible INTEGER NOT NULL DEFAULT 0");

export type Priority = "P0" | "P1" | "P2";
/** `unobservable`：判据没量到——没有判决，不是通过也不是失败（harness-testing/exec/oracle.ts）。 */
export type RunStatus = "passed" | "failed" | "unobservable" | "notRun" | "running";

export type TargetPlatform = "web" | "ios" | "android";
export interface Project {
  id: string;
  name: string;
  targetUrl: string;
  /** web | ios | android — web3 and chain assertions exist only on web. */
  targetPlatform: TargetPlatform;
  createdAt: string;
  /**
   * 这个项目的规格来自哪几份文档（相对仓库根的路径）。
   *
   * 空数组不是「还没填」，它是一个结论：这个项目的规格只能从**观察**里来，
   * 于是它的整套用例只可能发现「产品变了」，永远不可能发现「产品错了」。
   */
  materials: string[];
}
export interface Step {
  order: number;
  text: string;
}
export type CaseType = "functional" | "negative" | "boundary" | "e2e";
export type Web3Mode = "" | "injected" | "metamask"; // "" = no wallet
// An on-chain assertion checked against the RPC after the case's steps run — verifies the
// real chain state, not just the UI (e.g. a token balance rose after a swap).
export interface ReviewDecision {
  wfRunId: string;
  caseId: string;
  decision: "approved" | "rejected";
  note?: string;
  createdCaseId?: string;
  at: string;
}

export function recordReviewDecision(d: ReviewDecision): void {
  db.prepare(
    `INSERT INTO review_decisions (wfRunId, caseId, decision, note, createdCaseId, at)
     VALUES (@wfRunId, @caseId, @decision, @note, @createdCaseId, @at)
     ON CONFLICT(wfRunId, caseId) DO UPDATE SET decision=excluded.decision, note=excluded.note,
       createdCaseId=excluded.createdCaseId, at=excluded.at`,
  ).run({ ...d, note: d.note ?? null, createdCaseId: d.createdCaseId ?? null });
}

export const listReviewDecisions = (wfRunId: string): ReviewDecision[] =>
  db.prepare("SELECT * FROM review_decisions WHERE wfRunId=?").all(wfRunId) as ReviewDecision[];

/** One reviewer's (or the model's) proposed replacement for a generated case. */
export interface ReviewEdit {
  title?: string;
  expected?: string;
  steps?: string[];
  precondition?: string[];
  tier?: number;
  designMethod?: string;
  priority?: Priority;
  /** Who proposed it: a person in the queue, or a regeneration. */
  by?: "human" | "model";
  note?: string;
}

export interface GapCase {
  id: string;
  wfRunId: string;
  projectId: string;
  gapWhat: string;
  gapKind: string;
  anchor?: unknown;
  kase: Record<string, unknown>;
  at: string;
}

/** 把一条从缺口补出来的用例记下来。它进的是复核队列，不是看板——它还没被人看过。 */
export function saveGapCase(input: Omit<GapCase, "id" | "at">): GapCase {
  const row: GapCase = { ...input, id: newId("gapc"), at: new Date().toISOString() };
  db.prepare(
    "INSERT INTO gap_cases (id,wfRunId,projectId,gapWhat,gapKind,anchorJson,caseJson,at) VALUES (?,?,?,?,?,?,?,?)",
  ).run(
    row.id,
    row.wfRunId,
    row.projectId,
    row.gapWhat,
    row.gapKind,
    JSON.stringify(row.anchor ?? {}),
    JSON.stringify(row.kase),
    row.at,
  );
  return row;
}

/** 这次运行补出来的那些。它们会和原生的那一批一起进复核队列。 */
export function listGapCases(wfRunId: string): GapCase[] {
  const rows = db
    .prepare("SELECT * FROM gap_cases WHERE wfRunId=? ORDER BY at")
    .all(wfRunId) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r.id),
    wfRunId: String(r.wfRunId),
    projectId: String(r.projectId),
    gapWhat: String(r.gapWhat),
    gapKind: String(r.gapKind),
    anchor: JSON.parse(String(r.anchorJson || "{}")),
    kase: JSON.parse(String(r.caseJson)) as Record<string, unknown>,
    at: String(r.at),
  }));
}

export function saveReviewEdit(wfRunId: string, caseId: string, edit: ReviewEdit): void {
  db.prepare(
    `INSERT INTO review_edits (wfRunId, caseId, json, at) VALUES (?,?,?,?)
     ON CONFLICT(wfRunId, caseId) DO UPDATE SET json=excluded.json, at=excluded.at`,
  ).run(wfRunId, caseId, JSON.stringify(edit), new Date().toISOString());
}

export function clearReviewEdit(wfRunId: string, caseId: string): void {
  db.prepare("DELETE FROM review_edits WHERE wfRunId=? AND caseId=?").run(wfRunId, caseId);
}

export const listReviewEdits = (wfRunId: string): Record<string, ReviewEdit> =>
  Object.fromEntries(
    (db.prepare("SELECT caseId, json FROM review_edits WHERE wfRunId=?").all(wfRunId) as Array<{
      caseId: string;
      json: string;
    }>).map((r) => [r.caseId, JSON.parse(r.json) as ReviewEdit]),
  );

/**
 * Every edit ever made in the review queue, newest first.
 *
 * The per-run lookup answers "what was changed in this batch"; the code line needs the
 * other question — "what has been rewritten in this project, by whom" — and that one
 * cannot be assembled from per-run calls without knowing every run id first.
 */
export const listAllReviewEdits = (limit = 200): Array<{ wfRunId: string; caseId: string; at: string; edit: ReviewEdit }> =>
  (db.prepare("SELECT wfRunId, caseId, json, at FROM review_edits ORDER BY at DESC LIMIT ?").all(limit) as Array<{
    wfRunId: string; caseId: string; json: string; at: string;
  }>).map((r) => ({ wfRunId: r.wfRunId, caseId: r.caseId, at: r.at, edit: JSON.parse(r.json) as ReviewEdit }));

/** The decision that created a given board case, if it came through review at all. */
export const decisionForCreatedCase = (caseId: string): ReviewDecision | undefined =>
  db.prepare("SELECT * FROM review_decisions WHERE createdCaseId=?").get(caseId) as ReviewDecision | undefined;

export interface TestCase {
  id: string;
  projectId: string;
  title: string;
  priority: Priority;
  priorityReason: string;
  runStatus: RunStatus;
  hasCode: boolean;
  precondition?: string;
  expected?: string; // the functional oracle: what "passed" means for this case
  type: CaseType; // test-design category (equivalence/boundary/negative/e2e)
  requirementId?: string; // trace back to a requirement/PRD item
  envRef?: string; // environment name this case binds to ("" = project default)
  dataKey?: string; // env array var to iterate — data-driven: one run per row (${row}/${row.col})
  web3Mode?: Web3Mode; // wallet to inject for dapp runs ("" = none)
  chainAssertions?: ChainAssertion[]; // on-chain checks evaluated after the steps
  postSteps: Step[]; // cleanup / teardown actions
  quarantined: boolean; // flaky → runs but excluded from the CI gate
  steps: Step[];
  code?: string;
  createdAt: string;
  /* ---- provenance, for a case that came out of a workflow ---- */
  storyId?: string; // the user story it was designed from
  activity?: string; // 所属模块。规格里算出来的路由聚类，故事地图的横轴
  covers?: string[]; // 走了哪些状态转移（`from->to`）——唯一来自产品本身的追溯线
  acRefs?: string[]; // 了结了哪几条验收准则（`S-05/AC-2`）——用例与用户故事之间那根线
  designMethod?: string; // equivalence / boundary / state-transition / decision-table / negative
  tier?: number; // how hard its verdict is: 1 assert, 2 invariant, 3 judge
  gateScore?: number; // what gate ① thought of the batch it arrived in
  sourceRunId?: string; // the workflow run that produced it
  /** The outcome in a form a program settles — no model, no screenshot, no wobble. */
  oracle?: MachineOracle;
  /** Its assertion was weakened (or the case rebuilt) during stage-two repair. */
  degraded?: boolean;
}

// A captured browser session (Playwright-compatible storageState shape) — cookies plus
// per-origin localStorage. Injected before navigation so runs start authenticated.
// API-style login (method C): call the site's login endpoint directly, capture the
// session cookie and/or a token from the response — no UI driving. Body/url may hold
// ${env.KEY}/${secret.KEY} placeholders.
export interface ApiLoginConfig {
  url: string; // login endpoint
  method?: string; // default POST
  contentType?: string; // default application/json
  body?: string; // request body template
  headers?: Record<string, string>; // extra request headers for the login call
  tokenPath?: string; // dot-path into the JSON response to the token (e.g. "data.token")
  tokenHeader?: string; // header to inject the token into (default Authorization)
  tokenPrefix?: string; // token value prefix (default "Bearer ")
}
// Environment: per-project target + non-secret vars + a reusable login flow.
export interface LoginFlow {
  authRequired?: boolean; // when true, cases run the login steps first
  steps?: string[]; // login actions; may reference env/secret placeholders
  apiLogin?: ApiLoginConfig; // API-style login config (alternative to UI steps)
  session?: StorageState | null; // captured login state — when present, injected + login SKIPPED
  capturedAt?: string; // when the session was captured (for staleness display)
}
export interface Environment {
  id: string;
  projectId: string;
  name: string;
  baseUrl: string;
  // Value may be an array (data-driven / multi-value); ${env.KEY.N} picks an element.
  vars: Record<string, string | string[]>;
  headers: Record<string, string>; // fixed request headers (may hold ${env}/${secret} refs)
  query: Record<string, string>; // fixed query-string params appended to navigations
  /**
   * 这个被测对象要多大的视口。
   *
   * 默认 1024×720 是为压小视觉模型的图定的，而它对一部分真实界面撑不开——
   * Binance 期货在这个宽度下下单面板整块不渲染，探索器只看得到图表和订单簿，
   * 而它不报错，它只是看不见半个产品。
   *
   * 放在环境上而不是做成全局环境变量：把默认调大，所有 SUT 的每一次模型调用
   * 都跟着变贵，而大多数界面在 1024 下是完整的。不配就沿用默认。
   */
  viewport?: { width?: number; height?: number };
  /**
   * 这个被测对象的视觉差异阈值（百分比）。不配就用默认的 0.5。
   *
   * 放在环境上，和视口同一个理由：**它是被测对象的属性，不是全局口味**。
   * 2026-09-11 在 Hyperliquid 主网上实测：130 个可比步骤里 40 步逐像素相同，
   * 其余 90 步的差异中位数 1.21%、最大 3.27%——价格区每秒都在动，而 0.5%
   * 这个默认值是给静态界面定的。结果是 90 条待审批差异里没有一条是真回归，
   * 全是行情在跳。把阈值调成全局的会让静态应用跟着变迟钝；不给出口则这一页没法用。
   */
  visualThresholdPct?: number;
  /**
   * 这个环境提供的前提名（规则包目标的 `requires` 对照它），例如 `session`、`wallet-session`。
   * 由人在环境设置里填；不填时探索按老规矩：配了登录步骤就提供 `session`。
   */
  capabilities?: string[];
  /** 探索时默认注入本机钱包（运行参数可以覆盖）。 */
  injectWallet?: boolean;
  login: LoginFlow;
  isDefault: boolean;
  createdAt: string;
}
// Secret: metadata only — the plaintext value is never returned to the client.
export interface SecretMeta {
  id: string;
  projectId: string;
  envId?: string;
  key: string;
  updatedAt: string;
}
export interface Baseline {
  id: string;
  caseId: string;
  stepIdx: number;
  imgPath: string;
  updatedAt: string;
}
export interface RunRecord {
  id: string;
  caseId: string;
  caseTitle: string;
  priority: Priority;
  status: Exclude<RunStatus, "notRun">;
  durationMs: number;
  startedAt: string;
  failureReason?: string;
  logs: string[];
  screenshots?: string[];
  reportPath?: string;
  tokens?: number;
  /** 一次运行的账：`RunSpend`（模型调用数、毫秒、缓存命中/未命中/失效）。 */
  spend?: RunSpend;
  visual?: VisualDiff[];
  perf?: unknown; // PerfResult from perf.ts (stored opaque to avoid coupling)
  oracle?: OracleCheck[];
  attempts?: number; // how many tries this run took (1 = passed first time)
  healed?: boolean; // passed only after a self-heal retry → a flake signal
  infraError?: boolean; // model/network failure — not a real test failure; excluded from flake/MTTR
  failCode?: string; // wire code, e.g. EXEC_TIMEOUT / EXEC_LOCATE / EXEC_ASSERT
  failKind?: "infra" | "locate" | "assert"; // which bucket the statistics should count it in
  /**
   * Which project this execution belongs to.
   *
   * Stored, not joined: a workflow execution runs a candidate case that has no board row
   * to join through, and may never get one.
   */
  projectId?: string;
  /** The workflow run that executed it, when it came from one. */
  wfRunId?: string;
  /**
   * Where the execution came from — the reader needs this to know what a green row means.
   *
   * `suite` and `case` both ran a case the board already accepted; `workflow` ran a
   * candidate during generation, before anyone approved it. Reported by the ledger query;
   * only `board` vs `workflow` is stored (suite-vs-case is a batch membership question).
   */
  origin?: "suite" | "case" | "workflow";
}

export type FlakeVerdict = "stable" | "flaky" | "broken" | "unknown";
export interface Flakiness {
  caseId: string;
  windowSize: number;
  passes: number;
  fails: number;
  healedCount: number;
  failRate: number;
  verdict: FlakeVerdict;
  updatedAt: string;
}
export interface Batch {
  id: string;
  projectId: string;
  label: string;
  status: "running" | "done";
  total: number;
  passed: number;
  failed: number;
  healed: number;
  flaky: number;
  quarantined: number;
  errored: number; // infra/model errors — no verdict, not counted as test failures
  gate: "pass" | "fail";
  startedAt: string;
  finishedAt?: string;
}
export interface BatchRun {
  batchId: string;
  caseId: string;
  caseTitle: string;
  runId?: string;
  status: "passed" | "failed" | "quarantined" | "error";
  attempts: number;
  healed: boolean;
}

/* ---- serialization ---- */
type CaseRow = Omit<
  TestCase,
  "steps" | "postSteps" | "hasCode" | "quarantined" | "chainAssertions" | "oracle" | "degraded" | "covers" | "acRefs"
> & {
  steps: string;
  postSteps: string;
  coversJson: string;
  acRefsJson: string;
  hasCode: number;
  quarantined: number;
  chainAssertionsJson: string;
  oracleJson: string | null;
  degraded: number;
};
const rowToCase = (r: CaseRow): TestCase => ({
  ...r,
  oracle: r.oracleJson ? (JSON.parse(r.oracleJson) as MachineOracle) : undefined,
  covers: JSON.parse(r.coversJson || "[]"),
  acRefs: JSON.parse(r.acRefsJson || "[]"),
  degraded: !!r.degraded,
  hasCode: !!r.hasCode,
  quarantined: !!r.quarantined,
  type: r.type || "functional",
  postSteps: JSON.parse(r.postSteps || "[]"),
  steps: JSON.parse(r.steps || "[]"),
  chainAssertions: JSON.parse(r.chainAssertionsJson || "[]"),
});
type RunRow = Omit<
  RunRecord,
  "logs" | "screenshots" | "visual" | "perf" | "oracle" | "healed" | "infraError" | "origin" | "spend"
> & {
  spendJson?: string | null;
  /** As stored: 'board' or 'workflow'. The ledger refines 'board' into suite/case. */
  origin?: string;
  logs: string;
  screenshots: string;
  visualJson: string | null;
  perfJson: string | null;
  oracleJson: string | null;
  healed: number;
  infraError: number;
};
const rowToRun = (r: RunRow): RunRecord => ({
  ...r,
  logs: JSON.parse(r.logs || "[]"),
  screenshots: JSON.parse(r.screenshots || "[]"),
  visual: JSON.parse(r.visualJson || "[]"),
  perf: r.perfJson ? JSON.parse(r.perfJson) : undefined,
  spend: r.spendJson ? JSON.parse(r.spendJson) : undefined,
  oracle: JSON.parse(r.oracleJson || "[]"),
  healed: !!r.healed,
  infraError: !!r.infraError,
  // 'board' is left undefined here rather than guessed: telling suite from ad-hoc needs
  // batch membership, which only the ledger query looks up.
  origin: r.origin === "workflow" ? "workflow" : undefined,
});

let seq = 1000;
export const newId = (p: string) => `${p}-${Date.now().toString(36)}-${++seq}`;

/* ---- projects ---- */
type ProjectRow = Omit<Project, "materials"> & { materialsJson: string };
const rowToProject = (r: ProjectRow): Project => ({
  ...r,
  materials: JSON.parse(r.materialsJson || "[]") as string[],
});
export const listProjects = (): Project[] =>
  (db.prepare("SELECT * FROM projects ORDER BY createdAt").all() as ProjectRow[]).map(rowToProject);
export const getProject = (id: string): Project | undefined => {
  const r = db.prepare("SELECT * FROM projects WHERE id=?").get(id) as ProjectRow | undefined;
  return r ? rowToProject(r) : undefined;
};
export function createProject(
  name: string,
  targetUrl: string,
  targetPlatform: TargetPlatform = "web",
  materials: string[] = [],
): Project {
  const p: Project = {
    id: newId("prj"),
    name,
    targetUrl,
    targetPlatform,
    createdAt: new Date().toISOString(),
    materials,
  };
  db.prepare(
    "INSERT INTO projects (id,name,targetUrl,targetPlatform,createdAt,materialsJson) VALUES (?,?,?,?,?,?)",
  ).run(p.id, p.name, p.targetUrl, p.targetPlatform, p.createdAt, JSON.stringify(p.materials));
  return p;
}
export function updateProject(
  id: string,
  patch: Partial<Pick<Project, "name" | "targetUrl" | "targetPlatform" | "materials">>,
): Project | undefined {
  const cur = getProject(id);
  if (!cur) return undefined;
  const next = { ...cur, ...patch };
  db.prepare(
    "UPDATE projects SET name=?, targetUrl=?, targetPlatform=?, materialsJson=? WHERE id=?",
  ).run(next.name, next.targetUrl, next.targetPlatform, JSON.stringify(next.materials ?? []), id);
  return next;
}
// Delete a project and everything under it (cases, runs, baselines, envs, secrets, batches).
export function deleteProject(id: string): void {
  const caseIds = (db.prepare("SELECT id FROM test_cases WHERE projectId=?").all(id) as { id: string }[]).map((r) => r.id);
  const batchIds = (db.prepare("SELECT id FROM batches WHERE projectId=?").all(id) as { id: string }[]).map((r) => r.id);
  db.transaction(() => {
    for (const cid of caseIds) {
      db.prepare("DELETE FROM runs WHERE caseId=?").run(cid);
      db.prepare("DELETE FROM baselines WHERE caseId=?").run(cid);
      db.prepare("DELETE FROM perf_baselines WHERE caseId=?").run(cid);
      db.prepare("DELETE FROM flakiness WHERE caseId=?").run(cid);
      db.prepare("DELETE FROM batch_runs WHERE caseId=?").run(cid);
    }
    for (const bid of batchIds) db.prepare("DELETE FROM batch_runs WHERE batchId=?").run(bid);
    db.prepare("DELETE FROM batches WHERE projectId=?").run(id);
    db.prepare("DELETE FROM environments WHERE projectId=?").run(id);
    db.prepare("DELETE FROM secrets WHERE projectId=?").run(id);
    db.prepare("DELETE FROM test_cases WHERE projectId=?").run(id);
    db.prepare("DELETE FROM projects WHERE id=?").run(id);
  })();
}

/* ---- cases ---- */
export const listCases = (projectId?: string): TestCase[] =>
  (
    projectId
      ? (db.prepare("SELECT * FROM test_cases WHERE projectId=? ORDER BY createdAt").all(projectId) as CaseRow[])
      : (db.prepare("SELECT * FROM test_cases ORDER BY createdAt").all() as CaseRow[])
  ).map(rowToCase);
export const getCase = (id: string): TestCase | undefined => {
  const r = db.prepare("SELECT * FROM test_cases WHERE id=?").get(id) as CaseRow | undefined;
  return r ? rowToCase(r) : undefined;
};
export function createCase(input: Partial<TestCase> & { projectId: string; title: string }): TestCase {
  const c: TestCase = {
    id: input.id || newId("tc"),
    projectId: input.projectId,
    title: input.title,
    priority: input.priority || "P1",
    priorityReason: input.priorityReason || "",
    runStatus: input.runStatus || "notRun",
    hasCode: input.hasCode ?? !!input.code,
    precondition: input.precondition || "",
    expected: input.expected || "",
    type: input.type || "functional",
    requirementId: input.requirementId || "",
    envRef: input.envRef || "",
    dataKey: input.dataKey || "",
    web3Mode: input.web3Mode || "",
    chainAssertions: input.chainAssertions || [],
    postSteps: input.postSteps || [],
    quarantined: input.quarantined ?? false,
    steps: input.steps || [],
    code: input.code || "",
    createdAt: input.createdAt || new Date().toISOString(),
    // Provenance travels with the case, or the board cannot answer the first question
    // anyone asks of a generated case: where did this come from?
    storyId: input.storyId,
    activity: input.activity,
    covers: input.covers ?? [],
    acRefs: input.acRefs ?? [],
    designMethod: input.designMethod,
    tier: input.tier,
    gateScore: input.gateScore,
    sourceRunId: input.sourceRunId,
    oracle: input.oracle,
    degraded: input.degraded,
  };
  db.prepare(
    `INSERT INTO test_cases (id,projectId,title,priority,priorityReason,runStatus,hasCode,precondition,expected,type,requirementId,envRef,dataKey,web3Mode,chainAssertionsJson,postSteps,quarantined,steps,code,createdAt,storyId,designMethod,tier,gateScore,sourceRunId,oracleJson,degraded,activity,coversJson,acRefsJson)
     VALUES (@id,@projectId,@title,@priority,@priorityReason,@runStatus,@hasCode,@precondition,@expected,@type,@requirementId,@envRef,@dataKey,@web3Mode,@chainAssertionsJson,@postSteps,@quarantined,@steps,@code,@createdAt,@storyId,@designMethod,@tier,@gateScore,@sourceRunId,@oracleJson,@degraded,@activity,@coversJson,@acRefsJson)`,
  ).run({
    ...c,
    storyId: c.storyId ?? null,
    activity: c.activity ?? "",
    coversJson: JSON.stringify(c.covers ?? []),
    acRefsJson: JSON.stringify(c.acRefs ?? []),
    designMethod: c.designMethod ?? null,
    tier: c.tier ?? null,
    gateScore: c.gateScore ?? null,
    sourceRunId: c.sourceRunId ?? null,
    oracleJson: c.oracle ? JSON.stringify(c.oracle) : null,
    degraded: c.degraded ? 1 : 0,
    hasCode: c.hasCode ? 1 : 0,
    quarantined: c.quarantined ? 1 : 0,
    web3Mode: c.web3Mode || "",
    chainAssertionsJson: JSON.stringify(c.chainAssertions ?? []),
    postSteps: JSON.stringify(c.postSteps),
    steps: JSON.stringify(c.steps),
  });
  return c;
}
export function updateCase(id: string, patch: Partial<TestCase>): TestCase | undefined {
  const cur = getCase(id);
  if (!cur) return undefined;
  const next: TestCase = {
    ...cur,
    ...patch,
    steps: patch.steps ?? cur.steps,
    postSteps: patch.postSteps ?? cur.postSteps,
    hasCode: patch.hasCode ?? (patch.code !== undefined ? !!patch.code : cur.hasCode),
  };
  db.prepare(
    `UPDATE test_cases SET title=@title,priority=@priority,priorityReason=@priorityReason,
     runStatus=@runStatus,hasCode=@hasCode,precondition=@precondition,expected=@expected,
     type=@type,requirementId=@requirementId,envRef=@envRef,dataKey=@dataKey,web3Mode=@web3Mode,chainAssertionsJson=@chainAssertionsJson,postSteps=@postSteps,quarantined=@quarantined,steps=@steps,code=@code,
     oracleJson=@oracleJson,degraded=@degraded,coversJson=@coversJson,acRefsJson=@acRefsJson WHERE id=@id`,
  ).run({
    ...next,
    /**
     * 判据、降级标记、覆盖点三列此前**不在这条 UPDATE 里**：看板或 API 改了判据，
     * 返回值回显的是合并后的对象，库里还是旧的——下一次运行照旧判。2026-09-07 在
     * hyperliquid 基准上把限价从 10000 改成 40000，运行仍报「要求 eq 10000」才发现。
     * 一个回显成功、落库失败的更新，比一个报错的更新糟。写法照 createCase。
     */
    oracleJson: next.oracle ? JSON.stringify(next.oracle) : null,
    degraded: next.degraded ? 1 : 0,
    coversJson: JSON.stringify(next.covers ?? []),
    acRefsJson: JSON.stringify(next.acRefs ?? []),
    web3Mode: next.web3Mode ?? "",
    chainAssertionsJson: JSON.stringify(next.chainAssertions ?? []),
    expected: next.expected ?? "",
    requirementId: next.requirementId ?? "",
    envRef: next.envRef ?? "",
    dataKey: next.dataKey ?? "",
    hasCode: next.hasCode ? 1 : 0,
    quarantined: next.quarantined ? 1 : 0,
    postSteps: JSON.stringify(next.postSteps ?? []),
    steps: JSON.stringify(next.steps),
  });
  return next;
}
export const deleteCase = (id: string): void => {
  db.prepare("DELETE FROM test_cases WHERE id=?").run(id);
};

/* ---- runs ---- */
export const getRun = (id: string): RunRecord | undefined => {
  const r = db.prepare("SELECT * FROM runs WHERE id=?").get(id) as RunRow | undefined;
  return r ? rowToRun(r) : undefined;
};
/** 成本账要的原始行（07 T-21）：不解析，交给 `scripts/lib/cost-aggregate.mjs`——脚本读的也是这几列。 */
export const listProjectRunRows = (projectId: string, limit = 2000): Array<Record<string, unknown>> =>
  db
    .prepare(
      `SELECT id, caseId, caseTitle, priority, status, durationMs, startedAt, tokens, spendJson, oracleJson, infraError, failKind, healed, attempts
         FROM runs WHERE projectId = ? ORDER BY startedAt DESC LIMIT ?`,
    )
    .all(projectId, limit) as Array<Record<string, unknown>>;

export const listRuns = (caseId?: string): RunRecord[] =>
  (
    caseId
      ? (db.prepare("SELECT * FROM runs WHERE caseId=? ORDER BY startedAt DESC").all(caseId) as RunRow[])
      : (db.prepare("SELECT * FROM runs ORDER BY startedAt DESC LIMIT 200").all() as RunRow[])
  ).map(rowToRun);
/**
 * Every execution this project has had — the ledger the Runs page is named after.
 *
 * It used to list only suite batches, which made the page a batch ledger wearing an
 * execution ledger's name: a project whose cases had only ever been exercised by the
 * repair loop showed nothing at all, and nothing reads as "never ran".
 *
 * Three origins, told apart rather than merged, because a green row means a different
 * thing in each: `suite` and `case` ran a case the board accepted, `workflow` ran a
 * candidate during generation that nobody had approved yet. The LEFT JOIN is what lets
 * the last kind appear — it has no board row to join through.
 */
export const listRunsByProject = (projectId: string): RunRecord[] =>
  (
    db
      .prepare(
        `SELECT r.*,
                (r.id IN (SELECT runId FROM batch_runs WHERE runId IS NOT NULL)) AS inBatch
         FROM runs r
         LEFT JOIN test_cases c ON c.id = r.caseId
         WHERE r.projectId = ? OR c.projectId = ?
         ORDER BY r.startedAt DESC LIMIT 200`,
      )
      .all(projectId, projectId) as Array<RunRow & { inBatch: number }>
  ).map((r) => ({
    ...rowToRun(r),
    origin: r.origin === "workflow" ? ("workflow" as const) : r.inBatch ? ("suite" as const) : ("case" as const),
  }));
export function createRun(r: Omit<RunRecord, "id">): RunRecord {
  const run: RunRecord = { ...r, id: newId("run") };
  db.prepare(
    `INSERT INTO runs (id,caseId,caseTitle,priority,status,durationMs,startedAt,failureReason,logs,screenshots,reportPath,tokens,visualJson,perfJson,oracleJson,attempts,healed,infraError,failCode,failKind,origin,projectId,wfRunId)
     VALUES (@id,@caseId,@caseTitle,@priority,@status,@durationMs,@startedAt,@failureReason,@logs,@screenshots,@reportPath,@tokens,@visualJson,@perfJson,@oracleJson,@attempts,@healed,@infraError,@failCode,@failKind,@origin,@projectId,@wfRunId)`,
  ).run({
    ...run,
    failureReason: run.failureReason ?? null,
    logs: JSON.stringify(run.logs),
    screenshots: JSON.stringify(run.screenshots ?? []),
    reportPath: run.reportPath ?? null,
    tokens: run.tokens ?? null,
    visualJson: JSON.stringify(run.visual ?? []),
    perfJson: run.perf ? JSON.stringify(run.perf) : null,
    oracleJson: JSON.stringify(run.oracle ?? []),
    attempts: run.attempts ?? 1,
    healed: run.healed ? 1 : 0,
    infraError: run.infraError ? 1 : 0,
    failCode: run.failCode ?? null,
    failKind: run.failKind ?? null,
    // Only the two stored values; the ledger derives suite-vs-case from batch membership.
    origin: run.origin === "workflow" ? "workflow" : "board",
    projectId: run.projectId ?? null,
    wfRunId: run.wfRunId ?? null,
  });
  return run;
}

/* ---- artifacts + visual baselines ---- */
export const ARTIFACT_DIR = resolve(DATA_DIR, "artifacts");
for (const sub of ["reports", "baselines", "current", "diff"])
  mkdirSync(resolve(ARTIFACT_DIR, sub), { recursive: true });

export const getBaseline = (caseId: string, stepIdx: number): Baseline | undefined =>
  db.prepare("SELECT * FROM baselines WHERE caseId=? AND stepIdx=?").get(caseId, stepIdx) as
    | Baseline
    | undefined;
export const listBaselines = (caseId: string): Baseline[] =>
  db.prepare("SELECT * FROM baselines WHERE caseId=? ORDER BY stepIdx").all(caseId) as Baseline[];
export function upsertBaseline(caseId: string, stepIdx: number, imgPath: string): Baseline {
  const now = new Date().toISOString();
  const existing = getBaseline(caseId, stepIdx);
  if (existing) {
    db.prepare("UPDATE baselines SET imgPath=?, updatedAt=? WHERE id=?").run(imgPath, now, existing.id);
    return { ...existing, imgPath, updatedAt: now };
  }
  const b: Baseline = { id: newId("bl"), caseId, stepIdx, imgPath, updatedAt: now };
  db.prepare(
    "INSERT INTO baselines (id,caseId,stepIdx,imgPath,updatedAt) VALUES (?,?,?,?,?)",
  ).run(b.id, b.caseId, b.stepIdx, b.imgPath, b.updatedAt);
  return b;
}

// Attach report / tokens / visual / perf / oracle results to a run after processing.
export function updateRunResults(
  id: string,
  patch: {
    reportPath?: string;
    tokens?: number;
    spend?: RunSpend;
    visual?: VisualDiff[];
    perf?: unknown;
    oracle?: OracleCheck[];
  },
): void {
  const cur = db
    .prepare("SELECT reportPath, tokens, spendJson, visualJson, perfJson, oracleJson FROM runs WHERE id=?")
    .get(id) as
    | { reportPath: string | null; tokens: number | null; spendJson: string | null; visualJson: string | null; perfJson: string | null; oracleJson: string | null }
    | undefined;
  if (!cur) return;
  db.prepare(
    "UPDATE runs SET reportPath=?, tokens=?, spendJson=?, visualJson=?, perfJson=?, oracleJson=? WHERE id=?",
  ).run(
    patch.reportPath ?? cur.reportPath ?? null,
    patch.tokens ?? cur.tokens ?? null,
    patch.spend !== undefined ? JSON.stringify(patch.spend) : cur.spendJson,
    JSON.stringify(patch.visual ?? JSON.parse(cur.visualJson || "[]")),
    patch.perf !== undefined ? JSON.stringify(patch.perf) : cur.perfJson,
    JSON.stringify(patch.oracle ?? JSON.parse(cur.oracleJson || "[]")),
    id,
  );
}

/* ---- performance baselines ---- */
export const getPerfBaseline = (caseId: string): Record<string, number> | undefined => {
  const r = db.prepare("SELECT metricsJson FROM perf_baselines WHERE caseId=?").get(caseId) as
    | { metricsJson: string }
    | undefined;
  return r ? (JSON.parse(r.metricsJson) as Record<string, number>) : undefined;
};
/** When this case's performance baseline was last accepted. */
export const perfBaselineUpdatedAt = (caseId: string): string | undefined =>
  (db.prepare("SELECT updatedAt FROM perf_baselines WHERE caseId=?").get(caseId) as
    | { updatedAt: string }
    | undefined)?.updatedAt;

export function upsertPerfBaseline(caseId: string, metrics: Record<string, number>): void {
  db.prepare(
    "INSERT INTO perf_baselines (caseId,metricsJson,updatedAt) VALUES (?,?,?) " +
      "ON CONFLICT(caseId) DO UPDATE SET metricsJson=excluded.metricsJson, updatedAt=excluded.updatedAt",
  ).run(caseId, JSON.stringify(metrics), new Date().toISOString());
}

/* ---- environments ---- */
type EnvRow = {
  id: string;
  projectId: string;
  name: string;
  baseUrl: string;
  varsJson: string;
  loginJson: string;
  headersJson: string;
  queryJson: string;
  viewportJson: string;
  visualThresholdPct: number | null;
  sessionEnc: string;
  isDefault: number;
  createdAt: string;
  capabilitiesJson?: string;
  injectWallet?: number;
};
const rowToEnv = (r: EnvRow): Environment => {
  const login: LoginFlow = JSON.parse(r.loginJson || "{}");
  // The session blob is stored encrypted in its own column, not in loginJson.
  if (r.sessionEnc) {
    try {
      login.session = JSON.parse(decryptSecret(r.sessionEnc)) as StorageState;
    } catch {
      login.session = null;
    }
  }
  return {
    id: r.id,
    projectId: r.projectId,
    name: r.name,
    baseUrl: r.baseUrl,
    vars: JSON.parse(r.varsJson || "{}"),
    headers: JSON.parse(r.headersJson || "{}"),
    query: JSON.parse(r.queryJson || "{}"),
    ...(() => {
      const vp = JSON.parse(r.viewportJson || "{}") as { width?: number; height?: number };
      // 空对象不发：一个 `viewport: {}` 在界面上看起来像"配过了"，而它什么都没说。
      return vp.width || vp.height ? { viewport: vp } : {};
    })(),
    ...(typeof r.visualThresholdPct === "number" ? { visualThresholdPct: r.visualThresholdPct } : {}),
    ...(() => {
      const caps = JSON.parse(r.capabilitiesJson || "[]") as string[];
      return caps.length ? { capabilities: caps } : {};
    })(),
    injectWallet: !!r.injectWallet,
    login,
    isDefault: !!r.isDefault,
    createdAt: r.createdAt,
  };
};
export const listEnvironments = (projectId: string): Environment[] =>
  (db.prepare("SELECT * FROM environments WHERE projectId=? ORDER BY createdAt").all(projectId) as EnvRow[]).map(rowToEnv);
export const getEnvironment = (id: string): Environment | undefined => {
  const r = db.prepare("SELECT * FROM environments WHERE id=?").get(id) as EnvRow | undefined;
  return r ? rowToEnv(r) : undefined;
};
// Resolve which environment a case runs in: explicit name → that env; else the project default.
export function resolveEnvironment(projectId: string, envRef?: string): Environment | undefined {
  const envs = listEnvironments(projectId);
  if (envRef) {
    const byName = envs.find((e) => e.name === envRef || e.id === envRef);
    if (byName) return byName;
  }
  return envs.find((e) => e.isDefault) ?? envs[0];
}
export function upsertEnvironment(
  input: Partial<Environment> & { projectId: string; name: string },
): Environment {
  const existing = listEnvironments(input.projectId).find(
    (e) => e.id === input.id || e.name === input.name,
  );
  const env: Environment = {
    id: existing?.id || input.id || newId("env"),
    projectId: input.projectId,
    name: input.name,
    baseUrl: input.baseUrl ?? existing?.baseUrl ?? "",
    vars: input.vars ?? existing?.vars ?? {},
    headers: input.headers ?? existing?.headers ?? {},
    query: input.query ?? existing?.query ?? {},
    ...(input.viewport ?? existing?.viewport ? { viewport: input.viewport ?? existing?.viewport } : {}),
    ...(input.visualThresholdPct ?? existing?.visualThresholdPct ? { visualThresholdPct: input.visualThresholdPct ?? existing?.visualThresholdPct } : {}),
    // Preserve the captured session across saves: the UI never round-trips the blob, so
    // only overwrite it when the caller explicitly provides `session` (object or null).
    login: input.login
      ? {
          ...input.login,
          session:
            input.login.session !== undefined
              ? input.login.session
              : existing?.login?.session ?? null,
        }
      : existing?.login ?? {},
    ...(input.capabilities ?? existing?.capabilities ? { capabilities: input.capabilities ?? existing?.capabilities } : {}),
    injectWallet: input.injectWallet ?? existing?.injectWallet ?? false,
    isDefault: input.isDefault ?? existing?.isDefault ?? false,
    createdAt: existing?.createdAt || new Date().toISOString(),
  };
  // Session lives in its own encrypted column, not in loginJson.
  const { session, ...loginRest } = env.login;
  const sessionEnc = session ? encryptSecret(JSON.stringify(session)) : "";
  // Only one default per project.
  if (env.isDefault)
    db.prepare("UPDATE environments SET isDefault=0 WHERE projectId=?").run(env.projectId);
  db.prepare(
    `INSERT INTO environments (id,projectId,name,baseUrl,varsJson,loginJson,headersJson,queryJson,viewportJson,visualThresholdPct,capabilitiesJson,injectWallet,sessionEnc,isDefault,createdAt)
     VALUES (@id,@projectId,@name,@baseUrl,@varsJson,@loginJson,@headersJson,@queryJson,@viewportJson,@visualThresholdPct,@capabilitiesJson,@injectWallet,@sessionEnc,@isDefault,@createdAt)
     ON CONFLICT(id) DO UPDATE SET name=@name,baseUrl=@baseUrl,varsJson=@varsJson,loginJson=@loginJson,headersJson=@headersJson,queryJson=@queryJson,viewportJson=@viewportJson,visualThresholdPct=@visualThresholdPct,capabilitiesJson=@capabilitiesJson,injectWallet=@injectWallet,sessionEnc=@sessionEnc,isDefault=@isDefault`,
  ).run({
    id: env.id,
    projectId: env.projectId,
    name: env.name,
    baseUrl: env.baseUrl,
    varsJson: JSON.stringify(env.vars),
    loginJson: JSON.stringify(loginRest),
    headersJson: JSON.stringify(env.headers),
    queryJson: JSON.stringify(env.query),
    viewportJson: JSON.stringify(env.viewport ?? {}),
    visualThresholdPct: env.visualThresholdPct ?? null,
    capabilitiesJson: JSON.stringify(env.capabilities ?? []),
    injectWallet: env.injectWallet ? 1 : 0,
    sessionEnc,
    isDefault: env.isDefault ? 1 : 0,
    createdAt: env.createdAt,
  });
  return env;
}
export const deleteEnvironment = (id: string): void => {
  db.prepare("DELETE FROM environments WHERE id=?").run(id);
};

/* ---- secrets vault (values stored encrypted; only metadata leaves the server) ---- */
export const listSecretMeta = (projectId: string): SecretMeta[] =>
  db
    .prepare("SELECT id,projectId,envId,key,updatedAt FROM secrets WHERE projectId=? ORDER BY key")
    .all(projectId) as SecretMeta[];
// Returns { KEY: plaintext } for a project (server-only; used at run/export time).
export function getSecretValues(projectId: string): Record<string, string> {
  const rows = db
    .prepare("SELECT key,valueEnc FROM secrets WHERE projectId=?")
    .all(projectId) as { key: string; valueEnc: string }[];
  const out: Record<string, string> = {};
  for (const r of rows) {
    try {
      out[r.key] = decryptSecret(r.valueEnc);
    } catch {
      /* skip corrupt entry */
    }
  }
  return out;
}
export function setSecret(projectId: string, key: string, value: string): SecretMeta {
  const now = new Date().toISOString();
  const id = newId("sec");
  db.prepare(
    `INSERT INTO secrets (id,projectId,envId,key,valueEnc,updatedAt) VALUES (?,?,?,?,?,?)
     ON CONFLICT(projectId,envId,key) DO UPDATE SET valueEnc=excluded.valueEnc, updatedAt=excluded.updatedAt`,
  ).run(id, projectId, null, key, encryptSecret(value), now);
  return { id, projectId, key, updatedAt: now };
}
export function deleteSecret(projectId: string, key: string): void {
  db.prepare("DELETE FROM secrets WHERE projectId=? AND key=? AND envId IS NULL").run(projectId, key);
}

/* ---- flake governance ---- */
// Recompute a case's stability from its last `windowSize` runs and persist the verdict.
// broken = every run in the window failed; flaky = mixed pass/fail OR any self-heal;
// stable = all passed with no heals.
export function computeFlakiness(caseId: string, windowSize = 10): Flakiness {
  // Infra/model errors are excluded — they mean "no verdict", not a flaky test.
  const recent = (
    db
      .prepare(
        "SELECT status, healed FROM runs WHERE caseId=? AND infraError=0 ORDER BY startedAt DESC LIMIT ?",
      )
      .all(caseId, windowSize) as { status: string; healed: number }[]
  );
  const total = recent.length;
  const fails = recent.filter((r) => r.status === "failed").length;
  const passes = total - fails;
  const healedCount = recent.filter((r) => !!r.healed).length;
  const failRate = total ? fails / total : 0;
  let verdict: FlakeVerdict = "unknown";
  if (total > 0) {
    if (fails === total) verdict = "broken";
    else if (fails > 0 || healedCount > 0) verdict = "flaky";
    else verdict = "stable";
  }
  const f: Flakiness = {
    caseId,
    windowSize,
    passes,
    fails,
    healedCount,
    failRate: Math.round(failRate * 100) / 100,
    verdict,
    updatedAt: new Date().toISOString(),
  };
  db.prepare(
    `INSERT INTO flakiness (caseId,windowSize,passes,fails,healedCount,failRate,verdict,updatedAt)
     VALUES (@caseId,@windowSize,@passes,@fails,@healedCount,@failRate,@verdict,@updatedAt)
     ON CONFLICT(caseId) DO UPDATE SET windowSize=@windowSize,passes=@passes,fails=@fails,
       healedCount=@healedCount,failRate=@failRate,verdict=@verdict,updatedAt=@updatedAt`,
  ).run(f);
  return f;
}
export interface QuarantineEntry {
  id: string;
  caseId: string;
  projectId: string;
  on: boolean;
  reason: string;
  by: string;
  at: string;
  gateAtTime?: string;
}

/**
 * 记一次隔离或解除。
 *
 * 理由是必填的，而且在这一层就拦——不是在界面上提示一句。隔离会让一条红用例
 * 不再拦门禁，一个没有理由的隔离等于把门禁悄悄调松，而且事后查不出是谁调的。
 */
export function logQuarantine(e: Omit<QuarantineEntry, "id" | "at">): QuarantineEntry {
  const reason = e.reason.trim();
  if (!reason) throw new Error("隔离要写理由——它会让这条用例的红不再拦门禁");
  const row: QuarantineEntry = { ...e, reason, id: newId("qlog"), at: new Date().toISOString() };
  db.prepare(
    "INSERT INTO quarantine_log (id,caseId,projectId,on_,reason,by,at,gateAtTime) VALUES (?,?,?,?,?,?,?,?)",
  ).run(row.id, row.caseId, row.projectId, row.on ? 1 : 0, row.reason, row.by, row.at, row.gateAtTime ?? null);
  return row;
}

/**
 * 一个项目（或一条用例）的隔离台账，新的在前。
 *
 * **按 `at` 排序不够**：`at` 是毫秒精度的 ISO 串，同一毫秒里写进来的两条会并列，
 * SQLite 于是按 rowid 升序返回——**老的排到了前面**，而「新的在前」正是这张台账的全部意义
 * （「这条用例现在到底是隔离着还是解除了」看的就是第一条）。用 rowid 兜底：它单调递增，
 * 表达的正是写入顺序。2026-09-11：全量测试里偶发失败过两次，单跑必过——就是这个。
 */
export function listQuarantineLog(projectId: string, caseId?: string): QuarantineEntry[] {
  const rows = (
    caseId
      ? db
          .prepare("SELECT * FROM quarantine_log WHERE projectId=? AND caseId=? ORDER BY at DESC, rowid DESC")
          .all(projectId, caseId)
      : db.prepare("SELECT * FROM quarantine_log WHERE projectId=? ORDER BY at DESC, rowid DESC LIMIT 200").all(projectId)
  ) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r.id),
    caseId: String(r.caseId),
    projectId: String(r.projectId),
    on: !!r.on_,
    reason: String(r.reason),
    by: String(r.by),
    at: String(r.at),
    ...(r.gateAtTime ? { gateAtTime: String(r.gateAtTime) } : {}),
  }));
}

export interface BaselineVerdict {
  id: string;
  caseId: string;
  projectId: string;
  kind: "visual" | "perf";
  stepIdx?: number;
  runId: string;
  verdict: "regression" | "noise";
  note: string;
  by: string;
  at: string;
}

/**
 * 记一次「不是新基线」的裁决。
 *
 * 两种都**不动基线**：判为回归是说「产品错了，这条用例应该继续红」；
 * 承认是噪声是说「这次的数字不算数」。把它们混进「接受」那一个按钮里，
 * 等于让一次回归自己变成新的正确答案——那是这套东西最贵的一种失效。
 */
export function recordBaselineVerdict(v: Omit<BaselineVerdict, "id" | "at">): BaselineVerdict {
  if (v.verdict === "regression" && !v.note.trim())
    throw new Error("判为回归要写一句为什么——这条用例会一直红着，后面的人得知道在等什么");
  const row: BaselineVerdict = { ...v, id: newId("bv"), at: new Date().toISOString() };
  db.prepare(
    "INSERT INTO baseline_verdicts (id,caseId,projectId,kind,stepIdx,runId,verdict,note,by,at) VALUES (?,?,?,?,?,?,?,?,?,?)",
  ).run(row.id, row.caseId, row.projectId, row.kind, row.stepIdx ?? null, row.runId, row.verdict, row.note, row.by, row.at);
  return row;
}

/** 这条用例上已经裁决过的基线待办——用来把它们从待办里划掉。 */
export function listBaselineVerdicts(projectId: string): BaselineVerdict[] {
  const rows = db
    .prepare("SELECT * FROM baseline_verdicts WHERE projectId=? ORDER BY at DESC LIMIT 500")
    .all(projectId) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r.id),
    caseId: String(r.caseId),
    projectId: String(r.projectId),
    kind: r.kind as "visual" | "perf",
    ...(r.stepIdx === null || r.stepIdx === undefined ? {} : { stepIdx: Number(r.stepIdx) }),
    runId: String(r.runId),
    verdict: r.verdict as "regression" | "noise",
    note: String(r.note ?? ""),
    by: String(r.by ?? "unknown"),
    at: String(r.at),
  }));
}

export const getFlakiness = (caseId: string): Flakiness | undefined =>
  db.prepare("SELECT * FROM flakiness WHERE caseId=?").get(caseId) as Flakiness | undefined;
export const listFlakiness = (projectId: string): Flakiness[] =>
  db
    .prepare(
      `SELECT f.* FROM flakiness f JOIN test_cases c ON c.id=f.caseId WHERE c.projectId=?`,
    )
    .all(projectId) as Flakiness[];

/* ---- batches (suite runs) ---- */
export function createBatch(projectId: string, label: string): Batch {
  const b: Batch = {
    id: newId("bat"),
    projectId,
    label,
    status: "running",
    total: 0,
    passed: 0,
    failed: 0,
    healed: 0,
    flaky: 0,
    quarantined: 0,
    errored: 0,
    gate: "pass",
    startedAt: new Date().toISOString(),
  };
  db.prepare(
    `INSERT INTO batches (id,projectId,label,status,total,passed,failed,healed,flaky,quarantined,errored,gate,startedAt)
     VALUES (@id,@projectId,@label,@status,@total,@passed,@failed,@healed,@flaky,@quarantined,@errored,@gate,@startedAt)`,
  ).run(b);
  return b;
}
export function updateBatch(id: string, patch: Partial<Batch>): void {
  const cur = getBatch(id);
  if (!cur) return;
  const next = { ...cur, ...patch };
  db.prepare(
    `UPDATE batches SET status=@status,total=@total,passed=@passed,failed=@failed,healed=@healed,
       flaky=@flaky,quarantined=@quarantined,errored=@errored,gate=@gate,finishedAt=@finishedAt WHERE id=@id`,
  ).run({ ...next, finishedAt: next.finishedAt ?? null });
}
export const getBatch = (id: string): Batch | undefined =>
  db.prepare("SELECT * FROM batches WHERE id=?").get(id) as Batch | undefined;
export const listBatches = (projectId: string): Batch[] =>
  db.prepare("SELECT * FROM batches WHERE projectId=? ORDER BY startedAt DESC LIMIT 50").all(projectId) as Batch[];
export function addBatchRun(r: BatchRun): void {
  db.prepare(
    `INSERT INTO batch_runs (batchId,caseId,caseTitle,runId,status,attempts,healed)
     VALUES (@batchId,@caseId,@caseTitle,@runId,@status,@attempts,@healed)
     ON CONFLICT(batchId,caseId) DO UPDATE SET runId=@runId,status=@status,attempts=@attempts,healed=@healed`,
  ).run({ ...r, runId: r.runId ?? null, healed: r.healed ? 1 : 0 });
}
export function updateRunHealing(id: string, attempts: number, healed: boolean): void {
  db.prepare("UPDATE runs SET attempts=?, healed=? WHERE id=?").run(attempts, healed ? 1 : 0, id);
}
export const getBatchRuns = (batchId: string): BatchRun[] =>
  (db.prepare("SELECT * FROM batch_runs WHERE batchId=?").all(batchId) as (Omit<BatchRun, "healed"> & { healed: number })[]).map(
    (r) => ({ ...r, healed: !!r.healed }),
  );

/** 这个项目曾经命名过的步骤与前置。见 export_layer_memory 的建表注释。 */
export function exportLayerMemory(projectId: string): { actions: Set<string>; flows: Set<string> } {
  const rows = db.prepare("SELECT kind, key FROM export_layer_memory WHERE projectId=?").all(projectId) as Array<{ kind: string; key: string }>;
  return {
    actions: new Set(rows.filter((r) => r.kind === "action").map((r) => r.key)),
    flows: new Set(rows.filter((r) => r.kind === "flow").map((r) => r.key)),
  };
}
/** 记下这一次抽出来的名字。只增不删——忘掉一个名字就等于让下次导出把一批 spec 改回去。 */
export function rememberExportLayers(projectId: string, seen: { actions: readonly string[]; flows: readonly string[] }): void {
  const put = db.prepare("INSERT OR IGNORE INTO export_layer_memory VALUES (?,?,?)");
  db.transaction(() => {
    for (const key of seen.actions) put.run(projectId, "action", key);
    for (const key of seen.flows) put.run(projectId, "flow", key);
  })();
}
