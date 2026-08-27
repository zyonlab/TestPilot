export type Priority = "P0" | "P1" | "P2";
export type RunStatus = "passed" | "failed" | "notRun" | "running";
export type CaseType = "functional" | "negative" | "boundary" | "e2e";

export interface ApiLoginConfig {
  url: string;
  method?: string;
  contentType?: string;
  body?: string;
  headers?: Record<string, string>;
  tokenPath?: string;
  tokenHeader?: string;
  tokenPrefix?: string;
}

export interface LoginFlow {
  authRequired?: boolean;
  steps?: string[];
  apiLogin?: ApiLoginConfig | null; // API-style login config (no UI driving)
  // Captured-session summary (the blob itself never leaves the server).
  capturedAt?: string;
  hasSession?: boolean;
  sessionCookies?: number;
  sessionOrigins?: number;
  sessionHeaders?: number;
}

export interface Environment {
  id: string;
  projectId: string;
  name: string;
  baseUrl: string;
  vars: Record<string, string | string[]>; // value may be an array (data-driven)
  headers: Record<string, string>; // fixed request headers
  query: Record<string, string>; // fixed query-string params
  login: LoginFlow;
  isDefault: boolean;
  createdAt: string;
}

export interface SecretMeta {
  id: string;
  projectId: string;
  envId?: string;
  key: string;
  updatedAt: string;
}
export type ConnectionState =
  | "idle"
  | "testing"
  | "ok"
  | "fail"
  | "notMultimodal";

export interface Step {
  order: number;
  text: string;
}

/** Which end this project is tested on. web3 and chain assertions are web-only (US-01). */
export type TargetPlatform = "web" | "ios" | "android";
export interface Project {
  id: string;
  name: string;
  targetUrl: string;
  targetPlatform: TargetPlatform;
  createdAt: string;
  /** 看板上有多少条用例。列表接口填，单个项目的接口没有。 */
  cases?: number;
}

export type Web3Mode = "" | "injected" | "metamask";
export interface ChainAssertion {
  kind: "erc20Balance" | "nativeBalance" | "txSubmitted";
  account?: string;
  token?: string;
  decimals?: number;
  op: "increased" | "decreased" | "changed" | "gte" | "lte" | "eq";
  value?: string; // balance threshold, or (for txSubmitted) the tx count
  label?: string;
}

export interface TestCase {
  id: string;
  projectId?: string;
  title: string;
  priority: Priority;
  priorityReason: string;
  runStatus: RunStatus;
  hasCode: boolean;
  precondition?: string;
  expected?: string;
  steps: Step[];
  code?: string;
  type: CaseType;
  requirementId?: string;
  envRef?: string;
  dataKey?: string; // env array var to iterate — data-driven: one run per row
  web3Mode?: Web3Mode; // wallet to inject for dapp runs
  chainAssertions?: ChainAssertion[]; // on-chain checks after the steps
  postSteps?: Step[];
  quarantined?: boolean;
  // Provenance for a case that came out of a workflow.
  storyId?: string;
  designMethod?: string;
  tier?: number;
  gateScore?: number;
  sourceRunId?: string;
  /** The outcome in a form a program settles, when stage one produced one. */
  oracle?: { kind: string; value: string; op?: string; n?: number; direction?: string; by?: number };
  /** Its assertion was weakened (or the case rebuilt) during stage-two repair. */
  degraded?: boolean;
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
  gate: "pass" | "fail";
  startedAt: string;
  finishedAt?: string;
}
export interface BatchRun {
  batchId: string;
  caseId: string;
  caseTitle: string;
  runId?: string;
  status: "passed" | "failed" | "quarantined";
  attempts: number;
  healed: boolean;
}

export interface PerfVerdict {
  metric: string;
  current: number;
  baseline?: number;
  budgetMs?: number;
  deltaPct?: number;
  status: "ok" | "regression" | "new_baseline";
}
export interface PerfResult {
  status: "new_baseline" | "ok" | "regression";
  metrics: Record<string, number>;
  baseline?: Record<string, number>;
  verdicts: PerfVerdict[];
}
export interface OracleCheck {
  assertion: string;
  status: "pass" | "fail";
  detail?: string;
  /** What settled it: a program, or a model looking at a screenshot. */
  decidedBy?: "machine" | "judge";
}

export type VisualStatus = "new_baseline" | "match" | "diff";
export interface VisualDiff {
  stepIdx: number;
  status: VisualStatus;
  mismatchPct: number;
  baselineRef?: string; // artifact filename served by /api/artifacts/:name
  currentRef?: string;
  diffRef?: string;
}

export interface RunRecord {
  id: string;
  caseId: string;
  caseTitle: string;
  priority: Priority;
  status: Exclude<RunStatus, "notRun">;
  durationMs: number;
  startedAt: string; // ISO
  failureReason?: string;
  logs: string[];
  screenshots?: string[]; // data URLs from real Midscene runs
  reportPath?: string; // present → Midscene full report available at /api/runs/:id/report
  tokens?: number;
  visual?: VisualDiff[];
  perf?: PerfResult;
  oracle?: OracleCheck[];
  attempts?: number;
  healed?: boolean;
  failCode?: string; // EXEC_TIMEOUT / EXEC_LOCATE / EXEC_ASSERT / MODEL_UNAVAILABLE …
  failKind?: "infra" | "locate" | "assert"; // infra failures are NOT product defects
  /**
   * Where the execution came from — a green row means a different thing in each.
   *
   * `suite` and `case` ran a case the board had accepted; `workflow` ran a candidate
   * during generation, before anyone approved it. Mixing them into one pass rate produces
   * a number nobody can say what it measures, which is why the page filters on it.
   */
  origin?: "suite" | "case" | "workflow";
  /** The workflow run that executed it, when `origin` is `workflow`. */
  wfRunId?: string;
}

export interface TrendsKpis {
  passRate: number; // 0..1 over recent runs
  flakeRate: number; // 0..1, flaky cases / cases-with-runs; TARGET < 0.02
  mttrMs: number | null; // mean time to recovery, ms
  coverage: number; // 0..1, cases with >=1 passing run / total cases
  healRate: number; // 0..1, healed / (healed+failed) runs
  totalCases: number;
  casesWithRuns: number;
  totalRuns: number;
  runsWindow: number;
}
export interface TrendsBatch {
  id: string;
  label: string;
  startedAt: string;
  passed: number;
  failed: number;
  healed: number;
  flaky: number;
  quarantined: number;
  passRate: number;
  gate: "pass" | "fail";
}
export interface TrendsDay {
  day: string;
  passed: number;
  failed: number;
  passRate: number;
}
export interface Trends {
  kpis: TrendsKpis;
  batches: TrendsBatch[]; // chronological oldest→newest
  days: TrendsDay[];
}

export interface ModelConfig {
  baseUrl: string;
  apiKey: string;
  modelName: string;
  modelFamily: string;
}

export interface ExploreLog {
  id: string;
  ts: string;
  message: string;
  kind: "info" | "found" | "warn";
}

/* ---- processes (mirrors @testpilot/harness-core's ProcStatus; the UI stays a plain
   web app and does not import the node-side package) ---- */
export type ProcState =
  | "idle"
  | "spawning"
  | "alive"
  | "draining"
  | "exited"
  | "crashed"
  | "restarting";

export interface Spend {
  calls: number;
  tokens: number;
  usd: number;
  ms: number;
}

export interface ProcStatus {
  id: string;
  kind: "node" | "exec";
  state: ProcState;
  pid?: number;
  startedAt?: string;
  restarts: number;
  lastHeartbeat?: string;
  currentTask?: string;
  rssMb?: number;
  cpuPct?: number;
  spend: Spend;
  exitCode?: number | null;
  exitSignal?: string | null;
  lastError?: string;
}

/* ---- event stream (/ws) ---- */
export interface EventEnvelope<T = unknown> {
  v: 1;
  id: number;
  ts: string;
  scope: {
    projectId?: string;
    wfRunId?: string;
    nodeRunId?: string;
    runId?: string;
    caseId?: string;
    processId?: string;
  };
  kind: string;
  payload: T;
}

export interface LogLine {
  id: number;
  ts: string;
  processId: string;
  stream: string;
  text: string;
}
