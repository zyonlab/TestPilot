import { z } from 'zod';

// A closed, content-free contract: no prompts, URLs, endpoints, accounts or errors.
export const ExecutionStageSchema = z.enum(['compilation', 'validation', 'reset', 'dispatch', 'retry-wait', 'session-navigation', 'authentication', 'preparation', 'actions', 'assertions', 'cleanup']);
const Status = z.enum(['completed', 'failed', 'cancelled', 'unknown']);
const Failure = z.object({ attribution: z.enum(['infra', 'locate', 'assert', 'unknown']), retryable: z.boolean() }).strip();
export const ExecutionObservationSchema = z.object({
  version: z.literal(1),
  stages: z.array(z.object({
    stage: ExecutionStageSchema, durationMs: z.number().nonnegative(), status: Status,
    model: z.object({ source: z.enum(['role-proxy', 'deterministic', 'unavailable']), forwarded: z.number().int().nonnegative().nullable(), blocked: z.number().int().nonnegative().nullable() }).strip(),
    failure: Failure.optional(),
  }).strip()),
  cache: z.object({ session: z.enum(['hit', 'miss', 'unknown', 'unavailable']), midscene: z.enum(['unknown', 'unavailable']) }).strip(),
  retries: z.array(z.object({ stage: ExecutionStageSchema, reason: z.enum(['coordinate-replay', 'retryable-infrastructure']), delayMs: z.number().nonnegative() }).strip()),
}).strip();
export type ExecutionObservation = z.infer<typeof ExecutionObservationSchema>;
export type ExecutionStage = z.infer<typeof ExecutionStageSchema>;
export const ExecutionAttemptSchema = z.object({ attempt: z.number().int().positive(), status: z.enum(['passed','failed','unobservable','cancelled','unknown']), durationMs: z.number().nonnegative(), observation: ExecutionObservationSchema.nullable() }).strip();
export type ExecutionAttempt = z.infer<typeof ExecutionAttemptSchema>;
export function readExecutionObservation(value: unknown): ExecutionObservation | null {
  const parsed = ExecutionObservationSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Sequential measured boundaries; a missing source is unknown, including launch failures. */
export function executionObserver(now: () => number = () => performance.now()) {
  const data: ExecutionObservation = { version: 1, stages: [], cache: { session: 'unavailable', midscene: 'unknown' }, retries: [] };
  let current: ExecutionObservation['stages'][number] | undefined, start = now();
  let source: (() => readonly {forwarded?: boolean}[] | undefined) | undefined;
  let offset = 0;
  const end = () => {
    if (!current) return;
    current.durationMs += Math.max(0, now() - start);
    if (current.model.source !== 'deterministic') {
      const records = source?.();
      const slice = records?.slice(offset);
      const known = slice && slice.every(r => typeof r.forwarded === 'boolean');
      current.model = { source: known ? 'role-proxy' : 'unavailable', forwarded: known ? slice.filter(r=>r.forwarded).length : null, blocked: known ? slice.filter(r=>!r.forwarded).length : null };
      offset = records?.length ?? 0;
    }
    current = undefined;
  };
  return {
    data,
    source(read: () => readonly {forwarded?: boolean}[] | undefined, from = 0) { source = read; offset = from; },
    begin(stage: ExecutionStage, deterministic = false) {
      end(); start = now();
      current = { stage, durationMs: 0, status: 'completed', model: { source: deterministic ? 'deterministic' : 'unavailable', forwarded: deterministic ? 0 : null, blocked: deterministic ? 0 : null } };
      data.stages.push(current);
    },
    issue(status: z.infer<typeof Status>, failure?: z.infer<typeof Failure>) {
      if (!current) return;
      // A later unknown cannot erase a known failure.
      if (current.status !== 'failed' || status === 'cancelled') current.status = status;
      if (failure) current.failure = Failure.parse(failure);
    },
    retry(reason: ExecutionObservation['retries'][number]['reason'], delayMs = 0) {
      if (current) data.retries.push({ stage: current.stage, reason, delayMs });
    },
    end,
  };
}
