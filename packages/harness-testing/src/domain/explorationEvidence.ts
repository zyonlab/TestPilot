import { z } from 'zod';
import { abstractionOf, type StateFlowGraph } from '../exec/sfg.js';
import type { ExplorationCharter } from './charter.js';
import type { InteractionTarget, Observation } from './report.js';

/** Identity originates before dispatch, travels through RPC, and is echoed by the collector. */
export const ExplorationAttemptSchema = z.object({
  attemptId: z.string().uuid(), runId: z.string().min(1), projectId: z.string().min(1),
  environmentHash:z.string().min(1).nullable().optional(), pageVersion:z.string().min(1).nullable().optional(), inputFingerprint:z.string().min(1).optional(),
  entryUrl: z.string().url(), scopeHash: z.string().min(1), startedAt: z.string().datetime(),
}).strict();
export type ExplorationAttempt = z.infer<typeof ExplorationAttemptSchema>;
export const explorationExecId = (attempt: ExplorationAttempt) => `observe-${attempt.attemptId}`;
export const sameExplorationAttempt = (actual: unknown, expected: ExplorationAttempt): boolean => {
  const parsed = ExplorationAttemptSchema.safeParse(actual);
  return parsed.success && (Object.keys(expected) as Array<keyof ExplorationAttempt>).every(k => parsed.data[k] === expected[k]);
};

export const ExplorationAssessmentSchema = z.object({
  version: z.literal(1),
  status: z.enum(['complete', 'partial', 'unknown']),
  reasons: z.array(z.string()),
  scope: z.object({ entryUrl: z.string(), routes: z.array(z.string()), urlPatterns: z.array(z.string()), denominator: z.number().int().nonnegative().nullable() }),
  stop: z.object({ kind: z.string(), n: z.number().optional() }),
  counts: z.object({ seen: z.number(), attempted: z.number(), interactionCompleted: z.number(), observationCompleted: z.number(), assertionsPassed: z.number().nullable() }),
  targets: z.array(z.object({
    targetSpecId: z.string(), featureId: z.string(), seen: z.boolean(), attempted: z.boolean(),
    interactionCompleted: z.boolean(), observationCompleted: z.boolean(), assertion: z.literal('not_collected'),
    reason: z.string(), completedObservationIds: z.array(z.string()), observationIds: z.array(z.string()), evidenceRefs: z.array(z.string()), invalidRefs: z.array(z.string()),
  })),
  progress: z.object({ abstractStates: z.number(), uniqueWalkedTransitions: z.number(), repeatedActions: z.number(), invalidTransitions: z.number(), abstraction: z.string() }).nullable(),
  unvisited: z.array(z.string()),
});
export type ExplorationAssessment = z.infer<typeof ExplorationAssessmentSchema>;

/** Uses the collector's abstract state IDs; changing counters/text cannot add states here. */
export function explorationProgress(graph: StateFlowGraph): NonNullable<ExplorationAssessment['progress']> {
  const states = new Set(graph.states.map(s => s.id));
  const transitions = new Set<string>();
  const actions = new Set<string>();
  let repeatedActions = 0, invalidTransitions = 0;
  for (const edge of graph.transitions) {
    if (edge.walked !== true) continue;
    if (!states.has(edge.from) || (edge.ok && (!edge.to || !states.has(edge.to)))) { invalidTransitions++; continue; }
    const actionKey = JSON.stringify([edge.from, edge.to ?? null, edge.ok, edge.action.kind, edge.action.target.replace(/\d+/g, '#'), edge.action.input]);
    if (actions.has(actionKey)) repeatedActions++;
    else actions.add(actionKey);
    if (!edge.ok || !edge.to) continue;
    // Input values remain distinct; only volatile digits in labels are masked, as in sfg.ts.
    const key = JSON.stringify([edge.from, edge.to, edge.action.kind, edge.action.target.replace(/\d+/g, '#'), edge.action.input]);
    transitions.add(key);
  }
  return { abstractStates: states.size, uniqueWalkedTransitions: transitions.size, repeatedActions, invalidTransitions, abstraction: graph.abstraction };
}

/** Completion is confined to declared targets. No oracle is executed by the explorer. */
export function assessExploration(input: {
  entryUrl: string; charter?: ExplorationCharter; graph?: StateFlowGraph;
  budget?: {maxScreens:number; screens:number; maxRounds:number; rounds:number};
  targets?: InteractionTarget[]; observations?: Observation[]; stop?: {kind: string; n?: number};
}): ExplorationAssessment {
  const {charter, graph} = input, stop = input.stop ?? {kind:'unknown'};
  const states = new Set(graph?.states.map(s => s.id) ?? []);
  const targetEvidenceCollected = input.observations !== undefined && input.targets !== undefined;
  const observations = input.observations ?? [], found = input.targets ?? [];
  const controlKey = (display:string) => abstractionOf('route+controls/norm')({url:'/',controls:[display.trim().replace(/\s+/g,' ')]});
  const visible = (t:InteractionTarget, stateId:string) => !!t.display.trim() && !!graph?.states.find(s=>s.id===stateId)?.controls.some(c=>controlKey(c)===controlKey(t.display));
  const ids = new Set(observations.map(o => o.id));
  const validRef = (ref: string) => {
    if (ref.startsWith('sfg:state:')) return states.has(ref.slice(10));
    if (/^sfg:edge:\d+$/.test(ref)) return !!graph?.transitions[Number(ref.slice(9))];
    if (ref.startsWith('observation:')) return ids.has(ref.slice(12));
    // Screenshot paths are supplementary, never sufficient structural evidence.
    return ref.startsWith('shot:');
  };
  const targets = (charter?.featureTargets ?? []).map(spec => {
    const matches = found.filter(t => t.targetSpecId === spec.id && t.featureId === spec.featureId && states.has(t.stateId) && visible(t,t.stateId));
    const obs = observations.filter(o => o.targetSpecId === spec.id && o.featureId === spec.featureId);
    const invalidRefs = obs.flatMap(o => [
      ...o.evidenceRefs.filter(ref => !validRef(ref)),
      ...(!states.has(o.stateBefore) ? [`sfg:state:${o.stateBefore}`] : []),
      ...(o.stateAfter && !states.has(o.stateAfter) ? [`sfg:state:${o.stateAfter}`] : []),
      ...(!matches.some(t => t.stableId === o.targetId) ? [`target:${o.targetId}`] : []),
    ]);
    const valid = obs.filter(o => states.has(o.stateBefore) && matches.some(t => t.stableId === o.targetId) && o.evidenceRefs.every(validRef));
    const edgeFor = (o: Observation) => o.evidenceRefs.flatMap(ref => {
      if (!/^sfg:edge:\d+$/.test(ref)) return [];
      const e = graph?.transitions[Number(ref.slice(9))];
      return e && e.walked === true && e.from === o.stateBefore && o.action && e.action.kind === o.action.kind && e.action.target === o.action.target && e.action.selector === o.action.selector ? [e] : [];
    });
    const attempted = valid.some(o => ['attempted','failed'].includes(o.status) && edgeFor(o).length > 0);
    const completed = valid.filter(o => o.status === 'attempted' && o.stateAfter && states.has(o.stateAfter) && edgeFor(o).some(e => e.ok && e.to === o.stateAfter));
    const seen = matches.length > 0;
    const observationCompleted = spec.action === 'observe-only' && valid.some(o => o.status === 'observed_only' && o.evidenceRefs.includes(`sfg:state:${o.stateBefore}`) && matches.some(t=>t.stableId===o.targetId && visible(t,o.stateBefore)));
    const interactionCompleted = spec.action !== 'observe-only' && completed.length > 0;
    const reason = !graph || !targetEvidenceCollected ? 'evidence_not_collected' : interactionCompleted || observationCompleted ? 'evidence_complete'
      : invalidRefs.length ? 'invalid_evidence' : obs.some(o => o.status === 'blocked') ? 'blocked'
      : !seen ? 'not_found' : obs.some(o => o.status === 'failed') ? 'failed'
      : obs.some(o => o.status === 'skipped_equivalent') ? 'equivalent_unverified'
      : attempted || obs.some(o => o.status === 'attempted') ? 'missing_post_state' : 'not_attempted';
    return { targetSpecId:spec.id, featureId:spec.featureId, seen, attempted, interactionCompleted, observationCompleted,
      assertion:'not_collected' as const, reason, completedObservationIds:completed.map(o=>o.id), observationIds:valid.map(o => o.id), evidenceRefs:[...new Set(valid.flatMap(o => o.evidenceRefs.filter(r => !r.startsWith('shot:'))))], invalidRefs:[...new Set(invalidRefs)] };
  });
  const reasons: string[] = [];
  if (!charter) reasons.push('scope_undeclared');
  else if (!targets.length) reasons.push('empty_targets');
  if (!graph || (charter && !targetEvidenceCollected)) reasons.push('evidence_not_collected');
  if (!['dry','exhausted'].includes(stop.kind)) reasons.push('stop_not_completion');
  const budget=input.budget;
  if (budget && ((budget.maxScreens>0 && budget.screens>=budget.maxScreens) || (budget.maxRounds>0 && budget.rounds>=budget.maxRounds))) reasons.push('budget_exhausted');
  if (targets.some(t => !t.interactionCompleted && !t.observationCompleted)) reasons.push('targets_incomplete');
  const progress = graph ? explorationProgress(graph) : null;
  if (progress?.invalidTransitions) reasons.push('invalid_evidence');
  return ExplorationAssessmentSchema.parse({version:1, status: !charter || !graph || !targetEvidenceCollected || !targets.length ? 'unknown' : reasons.length ? 'partial' : 'complete', reasons,
    scope:{entryUrl:input.entryUrl, routes:charter?.scope.routes ?? [], urlPatterns:charter?.scope.urlPatterns ?? [], denominator:charter ? targets.length : null}, stop,
    counts:{seen:targets.filter(t=>t.seen).length, attempted:targets.filter(t=>t.attempted).length, interactionCompleted:targets.filter(t=>t.interactionCompleted).length, observationCompleted:targets.filter(t=>t.observationCompleted).length, assertionsPassed:null},
    targets, progress, unvisited:graph?.unvisited ?? [],
  });
}
