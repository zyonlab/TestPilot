/**
 * Failure classification.
 *
 * "The test failed" is three different statements, and mixing them poisons every number
 * downstream: an environment timeout is not a product defect, and a step that could not
 * find its target is not a failed assertion. The flake rate, the gate verdict and (in
 * phase 1) what the repair loop is even allowed to change all depend on this split.
 *
 * Protocol side (docs/spec/06): the code is what crosses the wire, the attribution is what
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
  /net::ERR|ECONNREFUSED|ENOTFOUND|browser has disconnected|Target closed|Protocol error|page crashed/i;
const TIMEOUT = /timeout|ETIMEDOUT|Navigation timeout|timed out/i;
const INFRA = new RegExp(`${MODEL.source}|${ENV.source}|${TIMEOUT.source}`, "i");

// The model could not ground the instruction in the page: element/target not found.
const LOCATE =
  /cannot find|could not find|not found on the page|no element|element not located|failed to locate|unable to locate|no matching element/i;

/** Same predicate the executor has always used, kept as a named export for compatibility. */
export function isInfraError(msg: string): boolean {
  return INFRA.test(msg);
}

export function classifyFailure(message: string): Failure {
  const msg = message ?? "";
  // Order matters: a model timeout is a model problem first and a timeout second.
  if (MODEL.test(msg))
    return { code: "MODEL_UNAVAILABLE", attribution: "infra", retryable: true, message: msg };
  if (ENV.test(msg))
    return { code: "EXEC_ENV", attribution: "infra", retryable: true, message: msg };
  if (TIMEOUT.test(msg))
    return { code: "EXEC_TIMEOUT", attribution: "infra", retryable: true, message: msg };
  if (LOCATE.test(msg)) {
    // A replan can succeed where a cached plan failed — this is what self-heal retries.
    return { code: "EXEC_LOCATE", attribution: "locate", retryable: true, message: msg };
  }
  // A failed assertion is a verdict. Retrying it just produces the same verdict.
  return { code: "EXEC_ASSERT", attribution: "assert", retryable: false, message: msg };
}
