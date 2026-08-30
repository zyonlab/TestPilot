import { z } from "zod";
import { FindingFieldSchema } from "../casegen/types.js";
import { TextCaseSchema } from "../casegen/types.js";

/**
 * Stage-two artifacts: the executable side.
 *
 * The deliverable is code, but the harness also keeps the code's *meaning* as a normalized
 * action list. Two reasons: the executor drives Midscene with natural-language actions, so
 * something has to translate; and a repair loop that edits free-form source cannot tell
 * whether a change touched a wait or an assertion — which is exactly the distinction that
 * decides whether a "fix" was honest.
 */

export const ActionSchema = z
  .object({
    kind: z.enum(["action", "input", "assert"]),
    /** What Midscene is told to do, or to verify. */
    text: z.string(),
    /** For `input`: which field the value goes into. */
    field: z.string().optional(),
  })
  // An empty value is a legitimate INPUT — "leave the username blank" is a real test — but
  // an empty action or assertion is a broken case. Found by a real run: the contract used
  // to reject the empty-username case, which is one of the cases that matters most.
  .refine((a) => a.kind === "input" || a.text.trim().length > 0, {
    message: "an action or assertion needs text",
    path: ["text"],
  });
export type Action = z.infer<typeof ActionSchema>;

/** A reusable step sequence shared by several cases (login, seeding, cleanup). */
export const FragmentSchema = z.object({
  name: z.string().min(1),
  actions: z.array(ActionSchema).min(1),
  usedBy: z.array(z.string()).default([]),
});
export type Fragment = z.infer<typeof FragmentSchema>;

export const CodeCaseSchema = z.object({
  caseId: z.string(),
  title: z.string(),
  /** The emitted source. */
  code: z.string(),
  /** The same thing the executor can actually run. */
  actions: z.array(ActionSchema).min(1),
  /** Fragments this case calls instead of repeating their steps. */
  uses: z.array(z.string()).default([]),
  /** Parameters the case reads (`${env.X}` / `${secret.X}`), for the data layer. */
  params: z.array(z.string()).default([]),
});
export type CodeCase = z.infer<typeof CodeCaseSchema>;

export const CodeBundleSchema = z.object({
  origin: z.string().default("inline"),
  cases: z.array(TextCaseSchema).default([]),
  fragments: z.array(FragmentSchema).default([]),
  code: z.array(CodeCaseSchema).default([]),
  /** Cases the generator could not turn into code, with why. */
  failed: z.array(z.object({ caseId: z.string(), message: z.string() })).default([]),
});
export type CodeBundle = z.infer<typeof CodeBundleSchema>;

/* ---- gate ② ---- */

export const CodeFindingSchema = z.object({
  caseId: z.string().optional(),
  rule: z.string(),
  severity: z.enum(["block", "warn", "info"]),
  message: z.string(),
  /**
   * 句子里要填的洞。
   *
   * 领域层**只产 rule + args**，一句给人看的话都不拼。此前这里拼死的那句英文过了河就是
   * 一个常量：中文界面上原样显示 `[oracle-vague] assertion names no observable phenomenon`，
   * 没有 key 也就没法译、没法配「为什么」和「怎么改」。`message` 仍然生成，
   * 因为报告、评测与日志要一句能读的话——但界面不该拿它当唯一的来源。
   */
  args: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  field: FindingFieldSchema.optional(),
});
export type CodeFinding = z.infer<typeof CodeFindingSchema>;

export const CodeGateReportSchema = z.object({
  score: z.number().min(0).max(1),
  findings: z.array(CodeFindingSchema),
  stats: z.object({
    cases: z.number(),
    fragments: z.number(),
    /** Share of actions that live in a fragment rather than being repeated. */
    reuseRatio: z.number(),
    /** Duplicated action sequences still left in the cases. */
    duplicateRuns: z.number(),
    parameterized: z.number(),
    withoutAssertion: z.number(),
  }),
});
export type CodeGateReport = z.infer<typeof CodeGateReportSchema>;

export const GatedCodeBundleSchema = CodeBundleSchema.extend({ gate: CodeGateReportSchema });
export type GatedCodeBundle = z.infer<typeof GatedCodeBundleSchema>;

/* ---- execution + repair ---- */

export const ExecOutcomeSchema = z.object({
  caseId: z.string(),
  status: z.enum(["passed", "failed"]),
  /** Which bucket the failure belongs in: infra / locate / assert. */
  failKind: z.enum(["infra", "locate", "assert"]).optional(),
  failCode: z.string().optional(),
  message: z.string().optional(),
  ms: z.number().default(0),
  /**
   * 这次执行留下的截图，**存路径不存像素**。
   *
   * 此前这个字段不存在，于是 `graphs.ts` 记录执行时只能写死一个空数组，界面拿到空数组
   * 又回落成四个灰色占位框——三个文件、三层，没有任何一层觉得自己在撒谎，而用户看到的是
   * 「图还在加载」。事实是这里永远不会有图。
   *
   * 存的是相对 artifacts 目录的路径（`exec/<execId>-<i>.png`），不是 data URI：
   * 后者会让 testpilot.db 从 192K 涨到几十 MB，而且截图进了 SQLite 之后就没法单独清理。
   * 这些 PNG 本来就已经被 runner 写在盘上了——此前只是没有人引用它们。
   */
  screenshots: z.array(z.string()).optional(),
  logs: z.array(z.string()).optional(),
});
export type ExecOutcome = z.infer<typeof ExecOutcomeSchema>;

/** What a repair round changed. The classification is the whole point (see repair.ts). */
export const RepairChangeSchema = z.enum([
  "structure",
  "selector-wording",
  "waiting",
  "assertion-semantics",
  "case-removed",
  "none",
]);
export type RepairChange = z.infer<typeof RepairChangeSchema>;

export const RepairRoundSchema = z.object({
  caseId: z.string(),
  round: z.number(),
  before: ExecOutcomeSchema,
  changes: z.array(RepairChangeSchema),
  note: z.string().default(""),
});
export type RepairRound = z.infer<typeof RepairRoundSchema>;

export const RepairReportSchema = z.object({
  rounds: z.array(RepairRoundSchema),
  outcomes: z.array(ExecOutcomeSchema),
  /** Passing cases ÷ all cases, counting every pass however it was reached. */
  loosePassRate: z.number(),
  /**
   * The same rate with cases that only went green after their assertion was weakened (or
   * that were removed) taken out. Published side by side with the loose one on purpose:
   * in the study this project follows, those two numbers were 70% and 50%.
   */
  strictPassRate: z.number(),
  degraded: z.array(z.string()),
  stoppedBecause: z.record(z.string(), z.string()),
});
export type RepairReport = z.infer<typeof RepairReportSchema>;

export const RepairedBundleSchema = GatedCodeBundleSchema.extend({ repair: RepairReportSchema });
export type RepairedBundle = z.infer<typeof RepairedBundleSchema>;

export const CODE_KIND = {
  gatedCases: "gated-cases",
  code: "code",
  gatedCode: "gated-code",
  repaired: "repaired-code",
} as const;
