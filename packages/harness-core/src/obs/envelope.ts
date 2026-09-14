import { z } from "zod";

// The one envelope every event in the system travels in. Commands go over RPC,
// FACTS go over this bus — so what the UI sees and what lineage records are the
// same rows, not two parallel implementations that can drift apart.

export const ScopeSchema = z
  .object({
    projectId: z.string(),
    wfRunId: z.string(),
    nodeRunId: z.string(),
    runId: z.string(),
    caseId: z.string(),
    processId: z.string(),
  })
  .partial();
export type Scope = z.infer<typeof ScopeSchema>;

export const PROTOCOL_VERSION = 1 as const;

export interface Envelope<T = unknown> {
  v: typeof PROTOCOL_VERSION;
  /** Monotonic, assigned by the store. The anchor a reconnecting client resumes from. */
  id: number;
  ts: string;
  scope: Scope;
  kind: string;
  payload: T;
}

export const EnvelopeSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  id: z.number().int().nonnegative(),
  ts: z.string(),
  scope: ScopeSchema,
  kind: z.string().min(1),
  payload: z.unknown(),
});

export interface Err {
  code: string;
  message: string;
  retryable: boolean;
  detail?: unknown;
}

// Event kinds (docs/archive/spec/06). Kept as a const map so producers can't typo a kind
// into existence — an unknown kind on the bus is a bug, not a new feature.
export const EventKind = {
  wfRunStarted: "wf.run.started",
  wfRunFinished: "wf.run.finished",
  wfNodeStarted: "wf.node.started",
  wfNodeFinished: "wf.node.finished",
  wfNodeOutput: "wf.node.output",
  wfPaused: "wf.paused",
  gateResult: "gate.result",
  caseCreated: "case.created",
  caseUpdated: "case.updated",
  runProgress: "run.progress",
  /** One frame of a streamed interactive session (explore / live debug). */
  sessionProgress: "session.progress",
  runFinished: "run.finished",
  repairRound: "repair.round",
  artifactReady: "artifact.ready",
  processStatus: "process.status",
  budgetUpdate: "budget.update",
  log: "log",
  error: "error",
} as const;
export type EventKind = (typeof EventKind)[keyof typeof EventKind];

/**
 * Kinds whose DELIVERY is coalesced (see EventBus). Persistence is never coalesced:
 * lineage keeps every row, the UI just doesn't need 40 repaints a second.
 */
export const COALESCED_KINDS: ReadonlySet<string> = new Set<string>([
  EventKind.runProgress,
  EventKind.wfNodeOutput,
  EventKind.processStatus,
  EventKind.budgetUpdate,
  EventKind.log,
]);

/** Stable key for coalescing: same kind + same scope target collapses. */
export function coalesceKey(e: Envelope): string {
  const s = e.scope;
  return [e.kind, s.processId, s.nodeRunId, s.runId, s.wfRunId, s.projectId].join("|");
}
