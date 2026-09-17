/**
 * v3 数据契约的**唯一** zod 落点（`docs/v3/01-数据契约.md` §1–§5）。
 *
 * 这个文件由 A 路建、B/C 路引。它只放**新形状**：已经有 schema 的东西
 * （`GoldChecklist` / `StoryBundle` / `GatedBundle` / `CoverageResult`）在
 * `harness-core/eval/coverage.ts` 与 `harness-testing/casegen/types.ts` 里，
 * 这里一律 `import type`，不重造——两份形状迟早会漂移，而漂移的那一刻没有人会知道。
 *
 * 派生函数（`agentState` / `goldHash`）也在这里，理由同上：
 * 「谱系相同」这件事是靠一个字符串相等判出来的，那个字符串怎么算必须只有一处。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { RunModelsSchema } from "@testpilot/harness-core/model-profiles";
export { RunBindingSchema, ArtifactRevisionSchema, RunRegistrationSchema, RunEventSchema } from "@testpilot/harness-core/run-contracts";

/* ------------------------------------------------------------ 三态结果 */

/**
 * 一次工具调用的第三种结局：**被门禁拦下**。
 *
 * 借 commerce-agents 的 `ToolOutcome`（`commerce_common/streaming.py`）：结果不是「成功 / 失败」
 * 两态，而是 `ok / error / blocked`。`blocked` 是**正常结果**——工具好好的，是规则说了不。
 * 分开的理由在读的人那边：审计台与 trace 要能把「工具坏了」和「规则拦了」分开数，
 * 因为后者的次数本身是一个度量：一次运行里模型撞了几次门禁，就是它试了几次绕过来源印记、
 * 谱系或工作区边界——2026-09-03 C 臂那次 meta.json 造假，正是该被这样数出来的事。
 *
 * `gate` 是拦它的那道门的名字，与 hook 里 `output.gate` 用同一套词：
 * `binding`（来源印记缺项）、`lineage`（跨谱系比较）、`provenance`（出处对不上）、
 * `grounding`（先读再写）、`workspace`（越出允许写的目录）、`sut`（被测对象缺席或没接上：不是故障）。
 */
export class Held extends Error {
  readonly status = "blocked" as const;
  constructor(
    readonly gate: "binding" | "lineage" | "provenance" | "grounding" | "workspace" | "sut" | "schema",
    message: string,
  ) {
    super(message);
    this.name = "Held";
  }
}

/** 拦下时回给调用方的形状。宿主按 `status` 分流，模型读 `reason` 知道该补什么。 */
export const HeldResultSchema = z.object({
  status: z.literal("blocked"),
  gate: z.enum(["binding", "lineage", "provenance", "grounding", "workspace", "sut", "schema"]),
  reason: z.string(),
});
export type HeldResult = z.infer<typeof HeldResultSchema>;

export const heldResult = (h: Held): HeldResult => ({ status: "blocked", gate: h.gate, reason: h.message });

/* ------------------------------------------------------------------ 指纹 */

/** sha256 的前 16 位十六进制。scoreboard 上的所有指纹都是这个长度。 */
export const sha16 = (text: string | Buffer): string =>
  createHash("sha256").update(text).digest("hex").slice(0, 16);

/**
 * `harness-core/util/digest.ts` 的 `TextDigest` 形状，写成 zod。
 *
 * 不 re-export 那边的 interface 是因为这里要的是**运行时校验**：
 * `meta.json` 是从磁盘读回来的，读回来的东西没有类型。
 */
export const TextDigestSchema = z.object({
  entries: z.record(z.string()),
  combined: z.string(),
});
export type TextDigestShape = z.infer<typeof TextDigestSchema>;

/* ----------------------------------------------------- §1 runs/<runId>/ */

export const ModelBindingSchema = z.object({
  baseUrl: z.string(),
  model: z.string(),
  thinking: z.boolean().nullable(),
});

/**
 * P3 来源印记的载体。缺任一必填项，`score_run` 拒绝打分（§2 拒收规则）。
 *
 * `skillVersion` 取代了 v2 的 `graphVersion`：v3 里没有图了，一次运行的「形状」
 * 由 skill 的版本号定。它由调用方（skill）传进来——工具自己编不出这个数，
 * 编出来的版本号是一个**看起来合法的**印记，比没有印记更坏。
 */
export const RunMetaSchema = z.object({
  runId: z.string().min(1),
  stage: z.enum(["g1", "g2"]),
  /**
   * 哪个运行时跑出来的（07 P2）：Penguin / Claude Code / Codex，或不经 agent 直接跑流水线。
   * 可选，缺省 = 旧条目（那时只有 Penguin）。它进 scoreboard 的 binding——运行时不同的两条分数不可比。
   */
  runtime: z.enum(["penguin", "claude-code", "codex", "pipeline"]).optional(),
  skillVersion: z.string().min(1),
  promptsDigest: TextDigestSchema,
  params: z.record(z.unknown()),
  ablated: z.array(z.string()),
  model: ModelBindingSchema,
  /** N-01: absent on legacy runs; never infer two roles from the old model field. */
  modelRoles: RunModelsSchema.optional(),
  materialsHash: z.string().min(1),
  startedAt: z.string(),
  finishedAt: z.string(),
  spend: z.object({ calls: z.number(), tokens: z.number(), ms: z.number() }),
  /**
   * 单条 skill 进化时冻结的上游产物在哪。**可选，缺省表示这次运行没有冻结输入**——
   * 整条流水线从 `docs/` 起跑，一步不落。
   *
   * 加它是因为「按 skill 进化」的两臂只该差 skill 版本一件事：给 design 冻结
   * `nodes/spec.json` + `nodes/stories.json`，同一份输入喂给多个 design 候选，
   * 于是候选之间的分差归得到 design 那一版改动身上。这个字段记下那份输入从哪来，
   * 供 `score_run` 复算 `inputHash`（见下）与审计台回看。
   */
  frozenInputsDir: z.string().optional(),
  /**
   * 冻结的上游产物的内容指纹（`inputHashOf`，与 `materialsHash` 同一套哈希）。
   * **可选，缺省即「没有冻结输入」**，与冻结前的旧条目兼容。
   *
   * 它进 `ScoreboardEntry`，作为 `goldHash` 之外的第二条谱系判据：两条条目若都带
   * `inputHash` 且不同，就是**喂了不同上游产物**的两场进化实验，跨实验不可比
   * （`paired_eval` 拒收）。由 `run_pipeline` 在冻结起跑时算出并写进这里。
   */
  inputHash: z.string().optional(),
});
export type RunMeta = z.infer<typeof RunMetaSchema>;

/**
 * 画布（US-14）与断点续跑（US-16.4）都靠它。
 *
 * `wrote` 是续跑的钥匙：`{ from: "design" }` 要知道 `design` 之前的那些节点
 * 把产物写在哪个文件里。没有它，「从中间接着跑」只能靠猜文件名。
 */
export const NodeEventSchema = z.object({
  runId: z.string(),
  node: z.string(),
  phase: z.enum(["start", "end", "error"]),
  at: z.string(),
  ms: z.number().optional(),
  calls: z.number().optional(),
  tokens: z.number().optional(),
  error: z.string().optional(),
  wrote: z.string().optional(),
});
export type NodeEvent = z.infer<typeof NodeEventSchema>;

/**
 * 一条决定是谁做的**这一类**。只有一个值：`human`。
 *
 * 借 commerce-agents 的 `StagedChange`：`created_by_kind ∈ {operator, agent}`，而 `applied_by`
 * 没有 kind——**批准永远是人**。这里同理：类型上没有 `agent` 这个值，所以「模型批准了自己的用例」
 * 在形状层就写不出来。真正的强制在两处：审计台的决定路由是唯一写 `decisions.json` 的地方
 * （`server/src/penguin.ts::writeDecisions`），hook `protect-decisions.mjs` 拒绝 agent 用
 * `write_file` 碰这个文件；`read_decisions` 只回校验通过的条目。
 *
 * 默认值是为兼容 2026-09-03 之前写的 decisions.json；新写的一律显式带上。
 */
export const DecidedByKind = z.enum(["human"]);

export const DecisionSchema = z.object({
  caseId: z.string(),
  decision: z.enum(["approved", "rejected", "revised"]),
  by: z.string(),
  decidedByKind: DecidedByKind.default("human"),
  at: z.string(),
  edit: z
    .object({
      title: z.string().optional(),
      steps: z.array(z.string()).optional(),
      expected: z.string().optional(),
    })
    .optional(),
  reason: z.string().optional(),
});
export type Decision = z.infer<typeof DecisionSchema>;

/* -------------------------------------------- §2 benchmark/<capability>/ */

/**
 * 第 0 步那 30 条人标。judge 校准（κ）与 gate 阈值的锚。
 *
 * `heldOut` 的一半从不进任何调优——它是这份标注唯一能防住「照着标注调 judge」的东西。
 */
export const HumanLabelSchema = z.object({
  goldId: z.string(),
  caseId: z.string(),
  runId: z.string(),
  covered: z.boolean(),
  by: z.string(),
  at: z.string(),
  heldOut: z.boolean(),
});
export type HumanLabel = z.infer<typeof HumanLabelSchema>;

/**
 * 语义覆盖那一栏。
 *
 * `coverage` 与主 `coverage` **并列，不替代**：主的那个是确定性的、可跨运行比；
 * 这个是模型判的、更准但不可比。两个都印，永远标着名字（`semantic.ts` 的原话）。
 * `kappa` / `spread` 只有校准过（`calibrate_judge` 跑过）才有——没跑过就是空，
 * 而不是填一个 0：0 是「judge 和人完全不一致」，空是「没人量过」。
 */
export const JudgeBindingSchema = z.object({
  /** 判官模型名（`TP_JUDGE_MODEL`，与生成器不同族——P2）。 */
  model: z.string(),
  /** 判官口径（semantic.ts 的 STABLE 提示词）的 sha256 前 16 位。 */
  promptDigest: z.string(),
});

export const SemanticScoreSchema = z.object({
  /**
   * 谁判的、按哪版口径判的。**可选，缺省即老条目**（2026-09-04 之前没记）。
   * 两条条目 judge 不同，它们的 semantic 那一栏不可比——`paired_eval` 在 note 里说出来。
   */
  judge: JudgeBindingSchema.optional(),
  coverage: z.number(),
  heldOutCoverage: z.number().optional(),
  kappa: z.number().optional(),
  spread: z.number().optional(),
  matched: z
    .array(z.object({ goldId: z.string(), caseId: z.string(), reason: z.string() }))
    .optional(),
  stillMissing: z.array(z.string()).optional(),
  calls: z.number().optional(),
  tokens: z.number().optional(),
});

export const McNemarSchema = z.object({
  aOnly: z.number(),
  bOnly: z.number(),
  bothPassed: z.number(),
  bothFailed: z.number(),
  p: z.number(),
  reading: z.string(),
});

/**
 * P2 的落点：`goldHash` 变了就是新谱系，跨谱系不比。
 *
 * `binding` 是**完整的** `RunMeta`，不是一个 runId 引用。理由：scoreboard 要能
 * 独立于 `runs/` 被读懂——运行目录会被清理，而一条比不了的历史分数比没有分数更坏。
 *
 * `matrix` / `methodMix` / `misses` 是契约 §2 之外多带的三样，标 optional：
 * 它们不参与「谱系相同」的判定，只是让审计台不必再回头读一遍 `cases.json`。
 */
export const ScoreboardEntrySchema = z.object({
  id: z.string(),
  at: z.string(),
  agentState: z.string(),
  goldHash: z.string(),
  /**
   * 冻结上游产物的指纹。**可选，缺省表示这条运行没有冻结输入**（整条流水线从 docs 起跑），
   * 与冻结机制上线前的旧条目兼容。
   *
   * 它是 `goldHash` 之外的第二条谱系判据（数据契约 §2 的补充）：按 skill 进化时，
   * 输入是被冻结的上游产物，这份输入变了这条分数就不能和旧条目比。两条条目都带
   * `inputHash` 且不同 → 不同的进化实验，`paired_eval` 拒收。两条都不带 → 老路，
   * 比整条流水线。
   */
  inputHash: z.string().optional(),
  goldPath: z.string(),
  runId: z.string(),
  coverage: z.number(),
  heldOutCoverage: z.number(),
  cases: z.number(),
  semantic: SemanticScoreSchema.optional(),
  vsPrev: z
    .object({
      entryId: z.string(),
      runId: z.string().optional(),
      mcnemar: McNemarSchema,
      flips: z.number(),
      /** 逐题：哪几条翻了，往哪边翻。三个数说服不了人，一份清单可以。 */
      flipped: z
        .array(z.object({ id: z.string(), title: z.string(), from: z.enum(["a", "b"]) }))
        .optional(),
    })
    .optional(),
  frozen: z.boolean(),
  binding: RunMetaSchema,
  /** 一句给读的人看的话。只在有话要说时才有——比如两臂差了不止一样东西。 */
  note: z.string().optional(),
  matrix: z
    .object({
      gold: z.array(
        z.object({
          id: z.string(),
          title: z.string(),
          heldOut: z.boolean(),
          by: z.array(z.string()),
          reach: z.enum(["hit", "miss"]),
        }),
      ),
      extras: z.array(z.object({ id: z.string(), title: z.string() })),
    })
    .optional(),
  methodMix: z.record(z.object({ expected: z.number(), covered: z.number() })).optional(),
  misses: z.array(z.object({ id: z.string(), title: z.string(), heldOut: z.boolean() })).optional(),
});
export type ScoreboardEntry = z.infer<typeof ScoreboardEntrySchema>;

/* ------------------------------------------------- §3 scans/<runId>.json */

export const ScanFindingSchema = z.object({
  caseId: z.string(),
  kind: z.enum(["assert-trivial", "unanchored", "touched-sut", "duplicate", "unfounded-step"]),
  evidence: z.string(),
  severity: z.enum(["block", "warn"]),
});
export type ScanFinding = z.infer<typeof ScanFindingSchema>;

export const ScanReportSchema = z.object({
  runId: z.string(),
  at: z.string(),
  scanner: z.string(),
  findings: z.array(ScanFindingSchema),
});
export type ScanReport = z.infer<typeof ScanReportSchema>;

/* ------------------------------------------- §4 materials/.index/ 与检索 */

export const SpecChunkSchema = z.object({
  id: z.string(),
  docId: z.string(),
  heading: z.array(z.string()),
  text: z.string(),
  tokens: z.number(),
});
export type SpecChunk = z.infer<typeof SpecChunkSchema>;

/**
 * 显式关系图。
 *
 * 2512.12117：62% 的跨文件证据纯向量检索找不到。所以除了「和查询像」，
 * 还要有「和这一段**连着**」——同一条路由、同一段流程。`to` 不是 chunkId 就是
 * 一个外部标识（一条路由、一个控件名），由 `kind` 决定读法。
 */
export const SpecEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  kind: z.enum(["mentions-route", "mentions-control", "same-flow"]),
});
export type SpecEdge = z.infer<typeof SpecEdgeSchema>;

export const SpecIndexSchema = z.object({
  materialsHash: z.string(),
  chunks: z.array(SpecChunkSchema),
  edges: z.array(SpecEdgeSchema),
});
export type SpecIndex = z.infer<typeof SpecIndexSchema>;

export const RetrieveResultSchema = z.object({
  chunks: z.array(SpecChunkSchema.extend({ score: z.number().optional(), why: z.string().optional() })),
  dropped: z.number(),
  hint: z.string(),
});
export type RetrieveResult = z.infer<typeof RetrieveResultSchema>;

/* ------------------------------------------------------- 执行侧（现有形状） */

/**
 * `drive_sut` 的返回。
 *
 * 它是 `harness-testing/exec/run.ts` 的 `RunResult` **去掉 Buffer 之后**的投影：
 * `pngBuffers` 是 `Buffer[]`，过不了 JSON-RPC，而截图的**路径**（`screenshots`）
 * 才是调用方要的东西。除此之外一个字段都不改名——名字一改，两边就要各自维护一份
 * 「这个字段在那边叫什么」的知识。
 */
export const ExecOutcomeSchema = z.object({
  caseId: z.string(),
  status: z.enum(["passed", "failed", "unobservable"]),
  durationMs: z.number(),
  startedAt: z.string(),
  logs: z.array(z.string()),
  screenshots: z.array(z.string()),
  oracle: z.array(z.unknown()),
  failureReason: z.string().optional(),
  infraError: z.boolean().optional(),
  failure: z.unknown().optional(),
  endedAt: z.string().optional(),
  mutationApplied: z.number().optional(),
});
export type ExecOutcome = z.infer<typeof ExecOutcomeSchema>;

export const DetectionEvalResultSchema = z.object({
  id: z.string(),
  runId: z.string(),
  falseAlarms: z.array(z.string()),
  falseAlarmRate: z.number(),
  leaning: z.enum(["false-alarms", "silence", "balanced", "undetermined"]),
  mutants: z.array(
    z.object({
      defect: z.string(),
      title: z.string(),
      killed: z.boolean(),
      killedBy: z.array(z.string()),
      ran: z.number(),
      applied: z.enum(["yes", "no", "unknown"]),
    }),
  ),
  mutationScore: z.number(),
  notApplied: z.number(),
  cases: z.number(),
  note: z.string(),
  startedAt: z.string(),
  finishedAt: z.string(),
});
export type DetectionEvalResult = z.infer<typeof DetectionEvalResultSchema>;

export const CalibrationSchema = z.object({
  kappa: z.number(),
  spread: z.number(),
  n: z.number(),
  runs: z.number(),
  agreement: z.number(),
  /** 混淆的四格。κ 一个数读不出来是哪边错——这四个数可以。 */
  confusion: z.object({ bothYes: z.number(), bothNo: z.number(), judgeOnly: z.number(), humanOnly: z.number() }),
  items: z.array(
    z.object({
      goldId: z.string(),
      caseId: z.string(),
      human: z.boolean(),
      votes: z.array(z.boolean()),
      judge: z.boolean(),
      unstable: z.boolean(),
      heldOut: z.boolean(),
    }),
  ),
  note: z.string(),
});
export type Calibration = z.infer<typeof CalibrationSchema>;

/* ------------------------------------------------------------ §5 工具入参 */

/**
 * 这些是 MCP `inputSchema` 的**唯一**来源。
 *
 * MCP SDK 的 `registerTool` 收的是「zod 形状字面量」（`ZodRawShape`），不是
 * `z.object(...)`，所以这里导出的是形状对象；需要整体校验时用 `z.object(SHAPE)`。
 */
export const RunPipelineInput = {
  approvedRunId: z.string().optional().describe("G2 only: registered generation run whose case revisions have current human approvals."),
  approvedRevisionIds: z.array(z.string()).optional().describe("G2 only: exact approved case revisions to compile; omitted selects all currently approved cases."),
  stage: z.enum(["g1", "g2"]).describe('Pipeline stage. "g1" designs cases from documents.'),
  materialsDir: z.string().describe("Directory holding the specification documents (*.md / *.txt)."),
  outDir: z.string().describe("Run directory to write stories.json, cases.json, gate.json, meta.json and events.jsonl into."),
  limit: z.number().int().min(1).max(50).optional().describe("Maximum number of user stories. Default 12."),
  stopAfter: z.string().optional().describe('Stop once this node has finished, e.g. "stories". Leaves a resumable events.jsonl.'),
  from: z.string().optional().describe('Resume at this node, reading the upstream artefact recorded in events.jsonl. Requires the same outDir, unless frozenInputsDir supplies the upstream products.'),
  frozenInputsDir: z.string().optional().describe('When resuming (from must be set), read the frozen upstream products (nodes/*.json) from this directory instead of outDir, so one frozen input can feed many candidates of the resumed stage. Records frozenInputsDir and the computed inputHash in meta.json.'),
  ablate: z.array(z.string()).optional().describe("Component switches to turn off for this run, for ablation comparison."),
  domainReferencePath: z.string().optional().describe("File holding the domain reference bound to this run (project data). Omitted: TP_DOMAIN_REFERENCE_FILE, else none."),
  skillVersion: z.string().optional().describe('Version of the calling skill, YYYY-MM-DD.N. Recorded in meta.json as the provenance of this run.'),
  lang: z.string().optional().describe('Output language for stories and cases. Default "zh".'),
};

export const ScoreRunInput = {
  runId: z.string().describe("Run to score. Either the runId in meta.json or the run directory's name."),
  goldPath: z.string().describe("Path to the human-written gold checklist. There is no default — scoring against the wrong checklist reads as a regression."),
  runsDir: z.string().optional().describe('Directory holding run directories. Default "runs" under the working directory.'),
  semantic: z.boolean().optional().describe("Also ask the model about the items keyword matching missed. Slower, and the extra number is not comparable across runs."),
};

export const PairedEvalInput = {
  a: z.string().describe("Baseline run id."),
  b: z.string().describe("Run id to compare against the baseline."),
  goldPath: z.string().describe("Gold checklist both runs are scored against."),
  runsDir: z.string().optional().describe('Directory holding run directories. Default "runs".'),
};

export const MutateAndDetectInput = {
  runId: z.string().describe("Run whose cases are executed."),
  target: z.string().describe("URL of the system under test, e.g. http://localhost:5301/testlogin."),
  defects: z.array(z.string()).optional().describe("Which injected faults to try. Empty means every fault the target advertises."),
  runsDir: z.string().optional().describe('Directory holding run directories. Default "runs".'),
  limit: z.number().int().min(1).max(20).optional().describe("Cases to run per build. Each one costs a browser session and model time. Default 3."),
};

export const DriveSutInput = {
  runId: z.string().describe("Run holding the case."),
  caseId: z.string().describe("Case to execute."),
  target: z.string().optional().describe("Bare URL of the system under test. Use projectId/env instead whenever the product needs a login, a viewport or fixed headers."),
  projectId: z.string().optional().describe("TestPilot project whose environment record supplies the session, viewport, headers and variables."),
  env: z.string().optional().describe("Environment id or name inside that project. Defaults to the project's default environment."),
  apiBase: z.string().optional().describe("Where the TestPilot gateway is. Default http://127.0.0.1:5301."),
  viewport: z.object({ width: z.number().int().min(320).max(4096).optional(), height: z.number().int().min(320).max(4096).optional() }).optional().describe("Override the viewport. Defaults to the environment record, then to 1600x1000."),
  dryRun: z.boolean().optional().describe("Resolve the environment and the case and return the execution plan without launching a browser or touching the system under test."),
  runsDir: z.string().optional().describe('Directory holding run directories. Default "runs".'),
};

export const RetrieveSpecInput = {
  materialsDir: z.string().describe("Directory holding the specification documents. The index is built into materials/.index/."),
  query: z.string().describe("What the caller is about to work on — a user story, an acceptance criterion, a route."),
  budgetTokens: z.number().int().min(200).max(200_000).describe("Token budget for the returned specification text."),
  chunkIds: z.array(z.string()).optional().describe("Fetch these chunks by id instead of searching, for following up on a hint."),
  rebuild: z.boolean().optional().describe("Rebuild the index even if the cached one matches the materials hash."),
};

/**
 * 写产物的两个工具（07 T-09）：门禁挪进工具里。Codex 没有 PreToolUse 这类 hook，模型直接 `write_file`
 * 就绕过了校验；让它只能通过这两个工具写 `stories.json` / `cases.json`，形状与出处在工具里核（和 hook 同一份
 * `validate.ts`），不过就拒写并记 `holds.jsonl`。Claude Code / Penguin 上 hook 仍在，这是双保险。
 */
export const WriteStoriesInput = {
  runId: z.string().describe("Run to write into: runs/<runId>/stories.json."),
  runsDir: z.string().optional().describe('Directory holding run directories. Default "runs" (or TP_RUNS_DIR).'),
  content: z.union([z.string(), z.record(z.unknown())]).describe("The stories.json content: a JSON string or the object itself. Shape: StoryBundle (see skill testpilot-stories REFERENCE.md)."),
};
export const WriteCasesInput = {
  runId: z.string().describe("Run to write into: runs/<runId>/cases.json."),
  runsDir: z.string().optional().describe('Directory holding run directories. Default "runs" (or TP_RUNS_DIR).'),
  content: z.union([z.string(), z.record(z.unknown())]).describe("The cases.json content: a JSON string or the object itself. Shape: CaseBundle; every case's sourceRefs must be chunk ids this session's retrieve_spec returned."),
  materialsDir: z.string().optional().describe("Materials directory whose .index/index.json is the fallback provenance basis. Default <workspace>/materials next to runsDir."),
};

/** 面向执行的两个工具（07 T-14）。判决由执行器的 oracle 层下，工具不问模型。 */
export const RunCaseInput = {
  projectId: z.string().describe("TestPilot project holding the case (its default environment supplies URL, session, viewport, variables)."),
  caseId: z.string().optional().describe("Case id (tc-…). Give this or title."),
  title: z.string().optional().describe("Case title (exact or unique substring) when the id is not at hand."),
  retries: z.number().int().min(0).max(3).optional().describe("Self-heal retries. Default 0: report what happened, do not repair."),
  apiBase: z.string().optional().describe("Where the TestPilot gateway is. Default http://127.0.0.1:5301."),
};
export const RunP0Input = {
  projectId: z.string().describe("TestPilot project whose P0 suite to run."),
  filter: z.enum(["P0", "P1", "P2", "all"]).optional().describe('Which priority to run. Default "P0".'),
  retries: z.number().int().min(0).max(3).optional().describe("Self-heal retries per case. Default 0."),
  apiBase: z.string().optional().describe("Where the TestPilot gateway is. Default http://127.0.0.1:5301."),
};

export const ExtractEpisodesInput = {
  runId: z.string().describe("Run whose artifacts (gate.json, holds.jsonl, scans/<runId>.json) the episode candidates are computed from."),
  runsDir: z.string().optional().describe('Directory holding run directories. Default "runs".'),
  scanPath: z.string().optional().describe("Path to scans/<runId>.json when the scanner ran; omitted means no scan findings are read."),
};

export const ReadDecisionsInput = {
  runId: z.string().describe("Run whose review decisions to read."),
  runsDir: z.string().optional().describe('Directory holding run directories. Default "runs".'),
};

export const CalibrateJudgeInput = {
  labelsPath: z.string().describe("Path to human-labels.json — the human judgements the model judge is measured against."),
  goldPath: z.string().describe("Gold checklist the labels refer to."),
  runsDir: z.string().optional().describe('Directory holding run directories. Default "runs".'),
  runs: z.number().int().min(1).max(9).optional().describe("How many times each item is judged, to measure the judge's own instability. Default 3."),
};

/* ------------------------------------------------------------------ 派生 */

/**
 * 「这次运行是**哪一版 agent** 产出的」。
 *
 * 三样东西定一版：skill 的版本、提示词的指纹、参数。少任何一样，两次分数就可能
 * 被当作同一版的重复测量，而实际上中间有人改过东西——那正是 P3 要防的那种谎。
 *
 * 参数用 `JSON.stringify` 而不是排序后的规范形式：契约里写死了这一句，
 * 两边算得不一样就等于没算。键序由 `run_pipeline` 写 `meta.json` 时固定。
 */
export const agentState = (meta: Pick<RunMeta, "skillVersion" | "promptsDigest" | "params">): string =>
  sha16(meta.skillVersion + meta.promptsDigest.combined + JSON.stringify(meta.params));

/** 一份 gold checklist 的谱系。**按文件内容**算，不按路径——路径改名不该换谱系。 */
export const goldHashOf = (contents: string | Buffer): string => sha16(contents);

/**
 * 一组冻结上游产物的谱系。**和 `materialsHash`（`hashMaterials`）同一套哈希**：
 * 逐文件 `relpath \0 content \0`，按相对路径排序后串起来取 sha256 前 16 位。
 *
 * 用同一套的理由和 `goldHashOf` 一样：判「输入相同」靠一个字符串相等，那个字符串
 * 只能有一处算法。`relFiles` 是相对 `rootDir` 的路径（如 `nodes/stories.json`）；
 * 只哈希真的存在的那几个——人冻结了什么，就哈希什么，不替它补全。
 *
 * 落在 `contracts.ts` 而不是 `pipeline.ts`：`score_run` 复算它时也要走这条路，
 * 两处算得不一样就等于没算（`agentState` 的那笔账）。
 */
export function inputHashOf(rootDir: string, relFiles: string[]): string {
  const h = createHash("sha256");
  for (const rel of [...relFiles].sort()) {
    const full = join(rootDir, rel);
    if (!existsSync(full)) continue;
    h.update(rel);
    h.update("\0");
    h.update(readFileSync(full));
    h.update("\0");
  }
  return h.digest("hex").slice(0, 16);
}

/** 同上，从磁盘读。找不到就抛——静默兜底到别的清单是 v2 那个洞（架构 §3 P2）。 */
export function goldHashOfFile(path: string): string {
  return goldHashOf(readFileSync(path));
}

/**
 * `RunMeta` 的拒收检查。
 *
 * 返回缺了哪几项，而不是一个布尔：调用方要能在错误消息里说清**缺的是哪个**，
 * 否则「拒收」对使用的人是一句没法处理的话。
 */
export function missingBinding(meta: unknown): string[] {
  const parsed = RunMetaSchema.safeParse(meta);
  if (parsed.success) return [];
  const required = ["skillVersion", "promptsDigest", "model", "materialsHash"];
  const bad = new Set(parsed.error.issues.map((i) => String(i.path[0] ?? "")));
  const missing = required.filter((k) => bad.has(k));
  // 必填四项都在，却仍然解析不过：形状坏在别处，一并报出来,不要谎称「没问题」。
  return missing.length ? missing : [...bad].filter(Boolean);
}
