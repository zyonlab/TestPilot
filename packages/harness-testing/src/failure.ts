/**
 * Failure classification.
 *
 * "The test failed" is three different statements, and mixing them poisons every number
 * downstream: an environment timeout is not a product defect, and a step that could not
 * find its target is not a failed assertion. The flake rate, the gate verdict and (in
 * phase 1) what the repair loop is even allowed to change all depend on this split.
 *
 * Protocol side (docs/archive/spec/06): the code is what crosses the wire, the attribution is what
 * statistics bucket it into.
 */
export type Attribution = "infra" | "locate" | "assert";

export interface Failure {
  /** Wire code, e.g. EXEC_TIMEOUT. Stable enough to switch on, coarse enough to survive. */
  code: string;
  attribution: Attribution;
  /** Whether retrying the SAME input could plausibly succeed. */
  retryable: boolean;
  message: string;
}

// Two flavours of "no verdict was produced", worth telling apart because they point at
// different things to fix: the model endpoint, or the environment under test.
const MODEL =
  /AI model service|model provider|rate limit|502|503|504|terminated|fetch failed|socket hang up/i;
const ENV =
  /PAGE_NOT_READY|page is blank|page elements tree is empty|net::ERR|ECONNREFUSED|ENOTFOUND|browser has disconnected|Target closed|Protocol error|page crashed/i;
const TIMEOUT = /timeout|ETIMEDOUT|Navigation timeout|timed out/i;
const INFRA = new RegExp(`${MODEL.source}|${ENV.source}|${TIMEOUT.source}`, "i");

/**
 * 驱动模型拆不动这句指令：它是一个目标，不是一个动作。
 *
 * 2026-09-13 又漏了一次：`Failed to plan actions: 右侧区域当前显示的是交易下单面板…`
 * ——用例把一句前置确认（「确认右侧区域显示订单簿」）写进了 `steps`，Midscene 规划时
 * 直接放弃并把**放弃的理由**写在冒号后面，一个字都不沾这三句旧措辞。于是它掉进兜底档
 * `EXEC_ASSERT`，一条措辞问题被记成产品缺陷。加上 `Failed to plan actions` 本身。
 */
const PLAN =
  /replanning \d+ times|more than the limit|split the task into multiple steps|Failed to plan actions/i;

// The model could not ground the instruction in the page: element/target not found.
const LOCATE =
  /cannot find|could not find|cannot be found|is not present on the current page|not found on the page|no element|element not located|failed to locate|unable to locate|no matching element|locate: multiple elements found/i;

/** Same predicate the executor has always used, kept as a named export for compatibility. */
export function isInfraError(msg: string): boolean {
  return /LIFECYCLE_[A-Z_]+|AUTHENTICATION_NOT_VERIFIED|EXEC_CANCELLED|ENV_RESET_FAILED|ENV_TEARDOWN_FAILED|BUDGET_EXHAUSTED/.test(msg) || INFRA.test(msg);
}

export function classifyFailure(message: string): Failure {
  const msg = message ?? "";
  const preparation = /^(LIFECYCLE_[A-Z_]+|PREREQUISITE_NOT_VERIFIED|AUXILIARY_CHECK_NOT_VERIFIED)/.exec(msg)?.[0];
  if (preparation) return { code: preparation, attribution: "infra", retryable: false, message: msg };
  const stopped = /AUTHENTICATION_NOT_VERIFIED|EXEC_CANCELLED|ENV_RESET_FAILED|ENV_TEARDOWN_FAILED|BUDGET_EXHAUSTED/.exec(msg)?.[0];
  if (stopped) return { code: stopped, attribution: "infra", retryable: false, message: msg };
  // Order matters: a model timeout is a model problem first and a timeout second.
  if (MODEL.test(msg))
    return { code: "MODEL_UNAVAILABLE", attribution: "infra", retryable: true, message: msg };
  if (ENV.test(msg))
    return { code: "EXEC_ENV", attribution: "infra", retryable: true, message: msg };
  if (TIMEOUT.test(msg))
    return { code: "EXEC_TIMEOUT", attribution: "infra", retryable: true, message: msg };
  if (PLAN.test(msg)) {
    /**
     * 规划失败：指令太抽象，驱动模型拆不成动作。
     *
     * 这**不是**产品没通过断言。实测里 `Navigate to the product list page` 这样一句
     * ——一个目标，不是一个动作——让 Midscene replan 十次后放弃，而它掉进兜底档变成了
     * `EXEC_ASSERT`：一次由用例措辞造成的失败，被记成「产品是坏的」。分档机制存在的
     * 全部理由就是不让这种事发生，而这一类正好漏在网外。
     *
     * 归到 `locate`：跟「找不到元素」一样，是可以靠改措辞解决的，修复循环该去改用例，
     * 而不是走「这是产品缺陷」的出口。
     */
    return { code: "EXEC_PLAN", attribution: "locate", retryable: true, message: msg };
  }
  if (LOCATE.test(msg)) {
    // A replan can succeed where a cached plan failed — this is what self-heal retries.
    return { code: "EXEC_LOCATE", attribution: "locate", retryable: true, message: msg };
  }
  // A failed assertion is a verdict. Retrying it just produces the same verdict.
  return { code: "EXEC_ASSERT", attribution: "assert", retryable: false, message: msg };
}
