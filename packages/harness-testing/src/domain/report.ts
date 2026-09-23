import { z } from "zod";
import { assessExploration, ExplorationAssessmentSchema, ExplorationAttemptSchema } from "./explorationEvidence.js";
import { SfgActionSchema, type StateFlowGraph } from "../exec/sfg.js";
import { DomainIdSchema } from "./rules.js";
import type { ExplorationCharter } from "./charter.js";

/**
 * 探索回执与报告（ExplorationReport v1）。
 *
 * 和 StateFlowGraph 的分工：图记「在 A 做了什么到了 B」；报告记「charter 里的每个目标
 * 找到没有、试了没有、为什么没试」。两份都由服务端/循环写，计数由代码算——
 * 一次「50 条边、7 条走过」的探索，walked 分子必须是 7，看见的 43 条不计入。
 */
export const ObservationStatusSchema = z.enum(["attempted", "observed_only", "blocked", "skipped_equivalent", "failed"]);
export type ObservationStatus = z.infer<typeof ObservationStatusSchema>;

export const InteractionTargetSchema = z
  .object({
    stableId: z.string().min(1),
    targetSpecId: DomainIdSchema,
    featureId: DomainIdSchema,
    stateId: z.string().min(1),
    route: z.string(),
    role: z.string().default(""),
    label: z.string(),
    display: z.string(),
    selector: z.string(),
    availability: z.enum(["enabled", "disabled"]).default("enabled"),
    foundAtRound: z.number().int().nonnegative(),
  })
  .strict();
export type InteractionTarget = z.infer<typeof InteractionTargetSchema>;

export const EffectSchema = z
  .object({
    controlsAdded: z.array(z.string()).default([]),
    controlsRemoved: z.array(z.string()).default([]),
    stateChanged: z.array(z.string()).default([]),
    textAdded: z.array(z.string()).default([]),
    textRemoved: z.array(z.string()).default([]),
  })
  .strict();

export const ObservationSchema = z
  .object({
    id: z.string().min(1),
    targetId: z.string().min(1),
    targetSpecId: DomainIdSchema,
    featureId: DomainIdSchema,
    status: ObservationStatusSchema,
    stateBefore: z.string().min(1),
    stateAfter: z.string().optional(),
    action: SfgActionSchema.optional(),
    effect: EffectSchema.optional(),
    /** after 状态的控件 display 列表——规则的 controlsPresent 对着它判。 */
    controlsAfter: z.array(z.string()).default([]),
    evidenceRefs: z.array(z.string()).default([]),
    reason: z.string().optional(),
    round: z.number().int().nonnegative(),
  })
  .strict();
export type Observation = z.infer<typeof ObservationSchema>;

export const PlannedTargetStatusSchema = z.enum(["attempted", "observed_only", "blocked", "not_found", "failed", "skipped_equivalent"]);
export const PlannedTargetSchema = z
  .object({
    targetSpecId: DomainIdSchema,
    featureId: DomainIdSchema,
    action: z.enum(["activate", "observe-only", "fill"]),
    status: PlannedTargetStatusSchema,
    /** 只有有效可见状态（observe-only）或实际动作与后态回执才能满足声明目标。 */
    terminal: z.boolean(),
    reason: z.string().optional(),
    targetIds: z.array(z.string()).default([]),
    observationIds: z.array(z.string()).default([]),
  })
  .strict();
export type PlannedTarget = z.infer<typeof PlannedTargetSchema>;

export const CoverageSchema = z
  .object({
    visitedUrls: z.number().int().nonnegative(),
    statesSeen: z.number().int().nonnegative(),
    edgesSeen: z.number().int().nonnegative(),
    edgesWalked: z.number().int().nonnegative(),
    /** 走过且 effect 非空：这一步确实做成了什么。 */
    transitionsAsserted: z.number().int().nonnegative(),
    targetsPlanned: z.number().int().nonnegative(),
    targetsFound: z.number().int().nonnegative(),
    targetsAttempted: z.number().int().nonnegative(),
    targetsBlocked: z.number().int().nonnegative(),
    targetsNotFound: z.number().int().nonnegative(),
    targetsFailed: z.number().int().nonnegative(),
    targetsObservedOnly: z.number().int().nonnegative(),
  })
  .strict();

export const ExplorationReportSchema = z
  .object({
    schemaVersion: z.literal("exploration-report.v1"),
    charterId: DomainIdSchema,
    rulePack: z.object({ id: DomainIdSchema, version: z.string(), hash: z.string() }).strict(),
    entryUrl: z.string(),
    stateAbstraction: z.string(),
    states: z.array(z.object({ id: z.string(), route: z.string(), title: z.string(), controlCount: z.number().int().nonnegative() }).strict()),
    targets: z.array(InteractionTargetSchema),
    observations: z.array(ObservationSchema),
    plannedTargets: z.array(PlannedTargetSchema),
    /** 还没做完的：预算到点时留给续跑。 */
    frontier: z.array(z.object({ targetSpecId: DomainIdSchema, featureId: DomainIdSchema, targetId: z.string().optional(), reason: z.string() }).strict()),
    stopReason: z.object({ kind: z.string(), n: z.number().optional() }).strict(),
    assessment: ExplorationAssessmentSchema.optional(),
    sourceAttempt: ExplorationAttemptSchema.optional(),
    completion: z.enum(["complete", "partial"]),
    coverage: CoverageSchema,
    unknowns: z.array(z.string()),
    budget: z.object({ maxScreens: z.number().int(), screens: z.number().int(), rounds: z.number().int(), maxRounds: z.number().int() }).strict(),
  })
  .strict();
export type ExplorationReport = z.infer<typeof ExplorationReportSchema>;

/** 计数全部由代码从图上算；模型不参与。 */
export function coverageOfGraph(graph: Pick<StateFlowGraph, "states" | "transitions">): Pick<z.infer<typeof CoverageSchema>, "visitedUrls" | "statesSeen" | "edgesSeen" | "edgesWalked" | "transitionsAsserted"> {
  const walked = graph.transitions.filter((t) => t.walked !== false);
  const asserted = walked.filter((t) => t.ok && !!t.effect && (t.effect.controlsAdded.length + t.effect.controlsRemoved.length + t.effect.stateChanged.length + t.effect.textAdded.length) > 0);
  return {
    visitedUrls: new Set(graph.states.map((s) => s.route)).size,
    statesSeen: graph.states.length,
    edgesSeen: graph.transitions.filter((t) => t.walked === false).length,
    edgesWalked: walked.length,
    transitionsAsserted: asserted.length,
  };
}


export function buildExplorationReport(input: {
  charter: ExplorationCharter;
  graph: StateFlowGraph;
  targets: InteractionTarget[];
  observations: Observation[];
  stop: { kind: string; n?: number };
  budget: { maxScreens: number; screens: number; rounds: number; maxRounds: number };
  unknowns?: string[];
}): ExplorationReport {
  const { charter, graph, targets, observations } = input;
  const byTarget = new Map<string, Observation[]>();
  for (const o of observations) byTarget.set(o.targetSpecId, [...(byTarget.get(o.targetSpecId) ?? []), o]);
  const foundBy = new Map<string, InteractionTarget[]>();
  for (const t of targets) foundBy.set(t.targetSpecId, [...(foundBy.get(t.targetSpecId) ?? []), t]);

  const planned: PlannedTarget[] = charter.featureTargets.map((spec) => {
    const obs = byTarget.get(spec.id) ?? [];
    const found = foundBy.get(spec.id) ?? [];
    const has = (s: ObservationStatus) => obs.filter((o) => o.status === s);
    const base = { targetSpecId: spec.id, featureId: spec.featureId, action: spec.action, targetIds: found.map((t) => t.stableId), observationIds: obs.map((o) => o.id) };
    if (has("attempted").length) return { ...base, status: "attempted" as const, terminal: true };
    if (has("failed").length) return { ...base, status: "failed" as const, terminal: true, reason: has("failed")[0]!.reason };
    if (has("blocked").length) return { ...base, status: "blocked" as const, terminal: true, reason: has("blocked")[0]!.reason };
    if (has("skipped_equivalent").length) return { ...base, status: "skipped_equivalent" as const, terminal: true, reason: has("skipped_equivalent")[0]!.reason };
    if (found.length) return { ...base, status: "observed_only" as const, terminal: spec.action === "observe-only", reason: spec.action === "observe-only" ? "observe_only" : "found_not_activated" };
    return { ...base, status: "not_found" as const, terminal: false, reason: "not_found_in_scope" };
  });

  const assessment = assessExploration({charter, graph, targets, observations, entryUrl:charter.scope.entryUrl, stop:input.stop, budget:input.budget});
  for (const p of planned) {
    const evidence = assessment.targets.find(t => t.targetSpecId === p.targetSpecId)!;
    p.terminal = evidence.interactionCompleted || evidence.observationCompleted;
    if (p.status === 'attempted' && !evidence.attempted) {
      p.status = evidence.seen ? 'observed_only' : 'not_found';
      p.reason = evidence.reason;
    }
  }
  const frontier = planned
    .filter((p) => !p.terminal || p.status === "blocked" || p.status === "failed")
    .map((p) => ({ targetSpecId: p.targetSpecId, featureId: p.featureId, ...(p.targetIds[0] ? { targetId: p.targetIds[0] } : {}), reason: assessment.targets.find(t => t.targetSpecId === p.targetSpecId)!.reason }));
  const unknowns = [
    ...(input.unknowns ?? []),
    ...planned.filter((p) => p.status === "not_found").map((p) => `target ${p.targetSpecId} (${p.featureId}) not found in scope: not observed ≠ not applicable`),
  ];
  const completion: ExplorationReport["completion"] = assessment.status === "complete" ? "complete" : "partial";
  const count = (s: PlannedTarget["status"]) => planned.filter((p) => p.status === s).length;
  return ExplorationReportSchema.parse({
    schemaVersion: "exploration-report.v1",
    charterId: charter.id,
    rulePack: charter.rulePack,
    entryUrl: charter.scope.entryUrl,
    stateAbstraction: graph.abstraction,
    states: graph.states.map((s) => ({ id: s.id, route: s.route, title: s.title, controlCount: s.controls.length })),
    targets,
    observations,
    plannedTargets: planned,
    frontier,
    stopReason: input.stop,
    completion,
    assessment,
    coverage: {
      ...coverageOfGraph(graph),
      targetsPlanned: planned.length,
      targetsFound: assessment.counts.seen,
      targetsAttempted: assessment.counts.attempted,
      targetsBlocked: count("blocked"),
      targetsNotFound: count("not_found"),
      targetsFailed: count("failed"),
      targetsObservedOnly: count("observed_only"),
    },
    unknowns,
    budget: input.budget,
  });
}

/** 报告的人类可读摘要，跟着 exploration.md 走：下游先看结构再看正文。 */
export function describeReport(r: ExplorationReport): string {
  const c = r.coverage;
  const lines = [
    "===== 领域探索回执 =====",
    `规则包：${r.rulePack.id}@${r.rulePack.version}　charter：${r.charterId}　完成度：${r.completion}　停止：${r.stopReason.kind}${r.stopReason.n ? `(${r.stopReason.n})` : ""}`,
    `地址 ${c.visitedUrls} / 状态 ${c.statesSeen} / 看见的边 ${c.edgesSeen} / 走过的边 ${c.edgesWalked} / 有效果的转移 ${c.transitionsAsserted}`,
    "分母仅为已声明目标；交互完成不代表业务断言通过，不代表全站覆盖。",
    `有后态证据的交互 ${r.assessment?.counts.interactionCompleted ?? "unknown"}；业务断言通过：未采集`,
    `目标 ${c.targetsPlanned}：已试 ${c.targetsAttempted}，仅看见 ${c.targetsObservedOnly}，阻塞 ${c.targetsBlocked}，未找到 ${c.targetsNotFound}，失败 ${c.targetsFailed}`,
    "",
    "逐目标：",
    ...r.plannedTargets.map((p) => `- ${p.targetSpecId} [${p.featureId}] ${p.status}${p.reason ? `（${p.reason}）` : ""}`),
    ...(r.frontier.length ? ["", "未完成（续跑 frontier）：", ...r.frontier.map((f) => `- ${f.targetSpecId}：${f.reason}`)] : []),
    ...(r.unknowns.length ? ["", "未知：", ...r.unknowns.map((u) => `- ${u}`)] : []),
  ];
  return lines.join("\n");
}
