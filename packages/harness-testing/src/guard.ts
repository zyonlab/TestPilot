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
 *   is this target denied outright                (`guard.denyHosts` — operator config)
 *   does this case contain an irreversible step   (blocked unless the environment allows it)
 *
 * **删除、支付、清理本来就是被测产品的功能**，用例要测的正是它们——所以默认放行
 * （`blockIrreversible` 默认 false）。运营方要整机拦截可以打开它，但那是全局开关，
 * 不是每个被测对象勾一次。绝不能碰的地址走禁止名单，那条线在上面，谁也放不开。
 *
 * What it is NOT: a security boundary. Reading step text cannot tell whether "confirm"
 * confirms a delete or a cancel. It stops "someone pointed the whole suite at production",
 * not someone who wants around it. Refusals are loud — a silently skipped step would show
 * up as a passing run, which is the worst outcome of all.
 */

/**
 * 通用的不可逆 / 动钱的操作词。故意宽：问一句比道歉便宜。
 *
 * **只放换任何产品都成立的词**。「下单 / 开仓 / 平仓 / 撤单」只在交易类产品上是副作用，
 * 它们跟着那个产品的规则包走（`sideEffectLabels`），不焊在这里。
 * 只拦**动作**，不拦名词：2026-09-11 那张表把「查看下单面板」「读取开仓价」误伤过，
 * 一条会把正确行为判成错的规则，第一次被误伤的人就会把它整个关掉。
 */
const IRREVERSIBLE =
  /删除|移除|清空|重置|注销|销户|退款|支付|付款|授权|转账|提现|解绑|发布|上线|delete|remove|wipe|purge|reset|deactivate|refund|pay\b|payment|checkout|transfer|withdraw|publish|deploy/i;

export interface Verdict {
  allow: boolean;
  /** Why — shown to the person, and recorded on the blocked run. */
  why: string;
  code?: "GUARD_HOST" | "GUARD_IRREVERSIBLE";
}

export interface GuardContext {
  /** 这个产品的规则包声明的额外不可逆操作词（只在 `blockIrreversible` 打开时才用得上）。 */
  sideEffectLabels?: readonly string[];
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/**
 * 规则包的 `sideEffectLabels` 按**正则**解释，和 `forbidLabels` 一个口径——这样才写得出
 * `下单(?!面板|区)` 这种「动作要拦、名词别误伤」的条目（2026-09-11 那张表被「查看下单面板」误伤过）。
 * 写坏的正则跳过，不让一条坏条目把整条守卫弄炸。
 */
const compileLabels = (labels: readonly string[]): RegExp[] =>
  labels.flatMap((l) => { try { return [new RegExp(l, "i")]; } catch { return []; } });

/**
 * Check one case before it runs. `steps` should include login and teardown steps: a
 * teardown that deletes the account is exactly the thing worth catching.
 */
export function checkRun(url: string, steps: string[], guard: HarnessConfig["guard"], context: GuardContext = {}): Verdict {
  const host = hostOf(url);
  if (guard.denyHosts.includes(host)) {
    return {
      allow: false,
      code: "GUARD_HOST",
      why: `${host} is on guard.denyHosts — nothing runs against it, whatever the environment says`,
    };
  }
  if (!guard.blockIrreversible) return { allow: true, why: "irreversible-step guard is off" };

  const extra = compileLabels((context.sideEffectLabels ?? []).map((l) => l.trim()).filter(Boolean));
  const hit = steps.find((s) => IRREVERSIBLE.test(s) || extra.some((re) => re.test(s)));
  if (!hit) return { allow: true, why: "no irreversible step" };
  return {
    allow: false,
    code: "GUARD_IRREVERSIBLE",
    why: `this step does something irreversible — "${hit.slice(0, 80)}" — and the environment for ${host} does not allow irreversible steps`,
  };
}
