export type Priority = "P0" | "P1" | "P2";
/**
 * `unknown` = 请求没回来，**不是**这条用例失败了。
 *
 * 600 秒超时、网络抖动、网关重启都会走到这里；此前它们一律被写成 `failed`，
 * 于是界面记下了一个它从没收到过的判决。
 */
/** `unobservable`：判据没量到——没有判决，不是通过也不是失败。 */
export type RunStatus = "passed" | "failed" | "unobservable" | "notRun" | "running" | "unknown";
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
  /**
   * 这个被测对象要多大的视口。默认 1024×720 是为压小视觉模型的图定的，
   * 而它对一部分真实界面撑不开（下单面板整块不渲染，探索器不报错、只是看不见）。
   * 不配就沿用默认——把默认调大会让所有 SUT 一起变贵。
   */
  viewport?: { width?: number; height?: number };
  login: LoginFlow;
  isDefault: boolean;
  createdAt: string;
  /** 环境画像（2026-09-15）：这个环境提供的前提名、默认注入钱包、允许不可逆操作。由人在环境设置里填。 */
  capabilities?: string[];
  injectWallet?: boolean;
}

export interface SecretMeta {
  id: string;
  projectId: string;
  envId?: string;
  key: string;
  updatedAt: string;
}
export type ConnectionState = "idle" | "testing" | "ok" | "fail" | "notMultimodal";

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
  /**
   * 规格来自哪几份文档（相对仓库根）。
   *
   * 空数组是一个结论，不是「还没填」：这个项目的规格只能从**观察**里来，
   * 于是它的整套用例只可能发现「产品变了」，永远不可能发现「产品错了」
   * ——观察不可能反驳被观察者。
   */
  materials?: string[];
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
  /** `runStatus` 是 `unknown` 时，为什么没拿到结果。人据此决定重试还是去看代码。 */
  runNote?: string;
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
  /**
   * 没拿到判决的条数（基础设施失败：模型不可达、runner 忙、超时）。
   *
   * 服务端一直在统计并入库 `errored`，而这个类型里没有它——于是六格里的「3 失败」
   * 可能其实是「0 失败 + 3 次模型不可达」。一个把「量不出来」算成「不合格」的统计，
   * 报出来的不是质量，是运气。
   */
  errored?: number;
  gate: "pass" | "fail";
  startedAt: string;
  finishedAt?: string;
}
export interface BatchRun {
  batchId: string;
  caseId: string;
  caseTitle: string;
  runId?: string;
  /**
   * `error` = **没有拿到判决**，与 `failed`（真的没通过）是两回事。
   *
   * 服务端把 infra 失败记成 `status:"error"`，而这个联合里此前没有它，
   * StatusPill 的 if/if/else 于是落到最后一支，把它画成了**「已隔离」**——
   * 一句意思正好相反的话：隔离是人主动做的决定，而这里是机器没能给出答案。
   */
  status: "passed" | "failed" | "quarantined" | "error";
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
export type ProcState = "idle" | "spawning" | "alive" | "draining" | "exited" | "crashed" | "restarting";

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

/**
 * 一个项目此刻有什么，两套账各带各的标签。
 *
 * 候选产物挂在运行上，已批准资产挂在项目上——代码里一直分得很清楚，界面上此前两者都叫
 * 「用例」。于是项目卡写着「还没有用例」，而库里有 68 次运行、40 条待复核；画布说
 * 「用例代码 38」，代码线说 0。合成一个数不是修法，那只会让同一句谎话说得更圆滑。
 */
export interface ProjectOverview {
  projectId: string;
  approved: {
    cases: number;
    withCode: number;
    byPriority: Record<Priority, number>;
    machineDecidable: number;
  };
  candidates: {
    runs: number;
    runsWithCases: number;
    cases: number;
    code: number;
    latestRunId?: string;
    latestAt?: string;
  };
}


/* ---- 07 P5：成本 / 记分板 / gold ---- */
export interface CostCaseRow {
  caseId: string; title: string; priority: string; n: number; passRate: number; infra: number;
  failures: { infra: number; locate: number; assert: number; unknown: number }; unobservable: number;
  wallMedian?: number; wallSpread: string; modelCallsMedian?: number; modelMsMedian?: number; tokensMedian?: number;
  cacheHitRate?: number; stale: number; oracleMachineShare?: number; usdMedian?: number;
  healedRuns: number; degraded: { total: number; blocked: number }; phasedRuns: number; phaseMedian: Record<string, number | undefined>;
  attribution: { runner: number; window: number };
}
export interface CostReport {
  project: string; last: number; cases: CostCaseRow[];
  totals: { runs: number; tokens: number; modelCalls: number; modelMs: number; wallMs: number; hits: number; misses: number; stale: number; machine: number; judge: number; passed: number;
    failures: { infra: number; locate: number; assert: number; unknown: number }; unobservable: number; healedRuns: number; degraded: { total: number; blocked: number };
    phases: Record<string, number>; phasedRuns: number; attribution: { runner: number; window: number } };
}
/** 记分板一行：binding 的字段摊平在顶层（`score_run` 写的形状），外加 capability。 */
export interface ScoreboardRow {
  capability: string; runId?: string; goldHash?: string; coverage?: number; heldOut?: number | { coverage?: number }; gate?: number | { score?: number };
  tokens?: number; n?: number; binding?: Record<string, unknown>; skillVersion?: string; promptsDigest?: { combined?: string }; model?: { model?: string }; runtime?: string; materialsHash?: string;
  [k: string]: unknown;
}
export interface GoldItem { sourceRefs?: string[]; expected?: string; ruleFamily?: string; split?: "train" | "dev" | "heldout"; reviewReceipt?: { reviewer: string; at: string; contentHash: string }; id: string; title: string; story?: string; designMethod?: string; expectTier?: number; heldOut?: boolean; match: Record<string, unknown>; anchors?: string[]; stale?: boolean }
export interface GoldFile { reviewPolicy?: "individual-v1"; id: string; items: GoldItem[]; outOfScope?: string[] }
export interface GoldState { capability: string; dir: string; draft: GoldFile | null; gold: GoldFile | null; frozenHash: string | null; currentHash: string | null; checklist: string[] }
