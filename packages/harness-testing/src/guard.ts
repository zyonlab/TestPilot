import type { HarnessConfig } from "@testpilot/harness-core";

/**
 * The guard.
 *
 * There is no tool registry to police here — the model produces data and this code does
 * the acting — so the guard has exactly one job: **the run is about to take natural
 * language and click real buttons on a real product, and one of those sentences might be
 * "delete the account".**
 *
 * It checks two things, both before anything is touched:
 *   is this target allowed to be driven at all   (host allowlist, off by default)
 *   does this case contain an irreversible step  (blocked outside the allowlist)
 *
 * What it is NOT: a security boundary. Reading step text cannot tell whether "confirm"
 * confirms a delete or a cancel. It stops "someone pointed the whole suite at production",
 * not someone who wants around it. Refusals are loud — a silently skipped step would show
 * up as a passing run, which is the worst outcome of all.
 */

/** Irreversible or money-moving. Deliberately over-inclusive: asking is cheaper than apologising. */
const IRREVERSIBLE =
  /删除|移除|清空|重置|注销|销户|退款|支付|付款|下单|转账|提现|解绑|发布|上线|delete|remove|wipe|purge|reset|deactivate|refund|pay\b|payment|checkout|transfer|withdraw|publish|deploy/i;

export interface Verdict {
  allow: boolean;
  /** Why — shown to the person, and recorded on the blocked run. */
  why: string;
  code?: "GUARD_HOST" | "GUARD_IRREVERSIBLE";
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export function isAllowedHost(url: string, allowHosts: string[]): boolean {
  return allowHosts.includes(hostOf(url));
}

/**
 * Check one case before it runs. `steps` should include login and teardown steps: a
 * teardown that deletes the account is exactly the thing worth catching.
 */
export function checkRun(
  url: string,
  steps: string[],
  guard: HarnessConfig["guard"],
): Verdict {
  const host = hostOf(url);
  const allowed = guard.allowHosts.includes(host);

  if (guard.allowlistOnly && !allowed) {
    return {
      allow: false,
      code: "GUARD_HOST",
      why: `${host} is not on the allowlist, and allowlistOnly is on. Add it to guard.allowHosts if you mean it.`,
    };
  }
  if (!guard.blockIrreversible || allowed) return { allow: true, why: allowed ? `${host} is allowlisted` : "no host restriction" };

  const hit = steps.find((s) => IRREVERSIBLE.test(s));
  if (!hit) return { allow: true, why: "no irreversible step" };
  return {
    allow: false,
    code: "GUARD_IRREVERSIBLE",
    why: `this step does something irreversible — "${hit.slice(0, 80)}" — and ${host} is not on the allowlist`,
  };
}
