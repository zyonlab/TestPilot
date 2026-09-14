import { parseCode } from "@testpilot/harness-testing";
import type { Request, Response, NextFunction } from 'express';
import { canonicalJSON, type Principal } from '@testpilot/harness-core/run-contracts';
import { reviewerPrincipal } from './reviewPrincipal.js';
import { getCase } from './db.js';
import { runLedger } from './runService.js';
import { LedgerError } from './runLedger.js';
import { boardBinding, recordBoardActionRepair } from './decisionDelivery.js';
const actionFields = new Set(['steps', 'code']);
export function requestPrincipal(req: Pick<Request, 'headers'>): Principal {
  try { return reviewerPrincipal(req); } catch { return { kind: 'agent', id: 'unverified-api-client' }; }
}
/** Request bodies never confer reviewer identity. New registered intent edits go through versioned review. */
export function assertCaseMutation(id: string, raw: unknown, method: string, principal: Principal) {
  const before = getCase(id); if (!before) throw new LedgerError(404, 'case_missing');
  const link = boardBinding(id);
  if (method === 'DELETE') {
    if (link) throw new LedgerError(409, 'withdraw_versioned_approval_required');
    if (principal.kind !== 'human') throw new LedgerError(403, 'human_review_required');
    return;
  }
  const patch = raw && typeof raw === 'object' ? { ...raw } as Record<string, unknown> : {};
  delete patch.__actor;
  const changed = Object.keys(patch).filter(k => canonicalJSON(patch[k] ?? null) !== canonicalJSON((before as unknown as Record<string, unknown>)[k] ?? null));
  if (changed.some(k => !actionFields.has(k))) {
    if (link) throw new LedgerError(409, 'review_revision_required');
    if (principal.kind !== 'human') throw new LedgerError(403, 'test_intent_frozen');
  }
  if (changed.includes('code')) {
    const assertions = (code: string) => parseCode(code).actions.filter(a => a.kind === 'assert').map(a => a.text);
    if (canonicalJSON(assertions(before.code ?? '')) !== canonicalJSON(assertions(String(patch.code ?? '')))) throw new LedgerError(403, 'code_assertions_frozen');
  }
  if (link && changed.length) recordBoardActionRepair(before, patch, principal);
}
/** Mounted before legacy routes; deterministic services and new review routes also validate at their own boundaries. */
export function intentPolicy(req: Request, res: Response, next: NextFunction) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  try {
    const principal = requestPrincipal(req);
    const kase = /^\/cases\/([^/]+)(?:\/(code))?$/.exec(req.path);
    if (kase && ['PATCH', 'DELETE'].includes(req.method)) {
      assertCaseMutation(decodeURIComponent(kase[1]), req.body, req.method, principal);
      if (req.body && typeof req.body === 'object') delete req.body.__actor;
      res.locals.principal = principal;
    }
    if (req.path === '/cases' && req.method === 'POST' && req.body?.sourceRunId && runLedger().registration(req.body.sourceRunId)) throw new LedgerError(403, 'approved_projection_service_required');
    if (/^\/projects\/[^/]+$/.test(req.path) && req.method === 'DELETE') reviewerPrincipal(req);
    const generate = /^\/cases\/([^/]+)\/generate-code$/.exec(req.path);
    if (generate && boardBinding(decodeURIComponent(generate[1]))) throw new LedgerError(409, 'generate_bound_code_required');
    const review = /^\/review\/([^/]+)\//.exec(req.path);
    if (review) {
      reviewerPrincipal(req);
      const run = runLedger().registration(decodeURIComponent(review[1]));
      if (run) return res.status(409).json({ code: 'versioned_review_required', href: `#/?open=wfruns&run=${encodeURIComponent(run.runId)}` });
    }
    if (/^\/audit\/[^/]+\/labels$/.test(req.path) || /^\/cases\/[^/]+\/(baselines\/approve|perf-baseline\/approve|baseline-verdict|quarantine)$/.test(req.path) || /^\/gold(?:\/|$)/.test(req.path)) reviewerPrincipal(req);
    next();
  } catch (error) { const e = error instanceof LedgerError ? error : new LedgerError(400, 'intent_request_invalid'); res.status(e.status).json({ code: e.code }); }
}
