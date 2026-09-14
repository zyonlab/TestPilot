import { afterEach, expect, it, vi } from 'vitest';
import { reviewerPrincipal } from '../src/reviewPrincipal.js';

afterEach(() => vi.unstubAllEnvs());

it('uses local operator attribution without credentials, ignoring legacy configuration and cookies', () => {
  vi.stubEnv('TP_REVIEW_TOKEN', 'obsolete-fixture-token');
  expect(reviewerPrincipal({ headers: {} })).toEqual({ kind: 'human', id: 'local-operator' });
  expect(reviewerPrincipal({ headers: { cookie: 'tp_reviewer=expired-fixture-session' } })).toEqual({ kind: 'human', id: 'local-operator' });
});

it('never converts explicit agent or obsolete reviewer credentials into operator authority', () => {
  vi.stubEnv('TP_REVIEW_TOKEN', 'obsolete-fixture-token');
  for (const authorization of ['Bearer agent-token', 'Bearer obsolete-fixture-token', '']) {
    expect(() => reviewerPrincipal({ headers: { authorization } })).toThrow('operator_action_required');
  }
});
