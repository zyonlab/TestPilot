import { duplicateRuns, parseCode } from "./parse.js";
import type { CodeBundle, CodeFinding, CodeGateReport } from "./types.js";

/**
 * Gate ② — is this code something a test team would keep?
 *
 * Unlike gate ①, this one has teeth, but only where a fact justifies them: code that
 * cannot run is blocked, because "it does not execute" is not a matter of taste. Style is
 * still advisory. The rules are the ones a test-development review actually argues about:
 * is the shared setup shared, is the data separated from the logic, is there an assertion
 * at all, and is anything sleeping instead of waiting for a condition.
 */

export interface CodeGateOptions {
  maxActions?: number;
  minReuseRatio?: number;
}

const DEFAULTS: Required<CodeGateOptions> = { maxActions: 12, minReuseRatio: 0 };

/** A sleep is a guess about timing that will be wrong on a slower machine. */
const RAW_SLEEP = /setTimeout\s*\(|sleep\s*\(|waitForTimeout\s*\(|delay\s*\(/i;
/** Credentials written into the source instead of referenced. */
// Matches both `password: "s3cr3t"` and `'password: s3cr3t'`. A `${...}` placeholder right
// after the separator is the correct form and must not trip it.
const INLINE_SECRET =
  /(password|passwd|pwd|secret|token|api[_-]?key)\s*[:=]\s*["'`]?(?!\$\{)[^"'`\s$][^"'`\n]{2,}/i;

/** Fields whose value is a credential, however innocuous the literal looks. */
const CREDENTIAL_FIELD = /password|密码|passwd|pwd|用户名|username|user name|account|账号|token|secret/i;

/**
 * A literal typed into a credential field.
 *
 * Found on a real run: the generator invented `testuser` / `testpass`, the login failed for
 * the obvious reason, and the repair loop then reported a *product defect* — a plausible
 * story built on a test that was wrong. Invented credentials do not merely fail; they fail
 * in a way that blames the product, and they quietly destroy the suite's ability to catch
 * anything past the login screen.
 *
 * The exception matters as much as the rule: a negative or boundary case is *supposed* to
 * type something invalid. "Wrong password" needs a literal wrong password — demanding a
 * placeholder there would be the rule misfiring on the cases that need it least.
 */
/** An assertion that demands a refusal: the case is about invalid input, whatever it is labelled. */
const ASSERTS_REFUSAL =
  /invalid|incorrect|错误|拒绝|失败|不允许|不能|denied|rejected|not (shown|displayed|logged)|remains? on the login|停留在登录/i;

function credentialLiteral(
  action: { kind: string; text: string; field?: string },
  intent: { designMethod?: string; expected?: string; title?: string } | undefined,
): boolean {
  if (action.kind !== "input") return false;
  if (!CREDENTIAL_FIELD.test(action.field ?? "")) return false;
  if (!action.text.trim()) return false; // an empty value is a boundary case, not a credential
  if (action.text.includes("${")) return false;
  /**
   * Evidence over label: a case whose assertion demands a refusal is about invalid input
   * even when the generator labelled it "equivalence" — which it does, often.
   *
   * 标题和断言都算证据，步骤不算。这条边界是这条规则的关键：
   *
   * 真实误报——「登录失败后页面URL保持不变」，`designMethod` 是 state-transition，
   * 断言写的是后果（"URL 保持为 …，未发生跳转"）而不是拒绝本身。它显然是一条负例，
   * 而证据落在标题上。只看 `expected` 就会把它拦下来，然后给出一个错误的建议：
   * 换成 `${env.*}` 会让这次登录**成功**，而这条用例要的正是它失败。
   *
   * 步骤则不能算证据。「输入 test_user」不能证明这条用例是负例——那是循环论证：
   * 用写死凭证这件事本身，来豁免写死凭证。
   */
  const claim = `${intent?.title ?? ""} ${intent?.expected ?? ""}`;
  const invalidByDesign =
    intent?.designMethod === "negative" ||
    intent?.designMethod === "boundary" ||
    ASSERTS_REFUSAL.test(claim);
  return !invalidByDesign;
}

export function runCodeGate(bundle: CodeBundle, opts: CodeGateOptions = {}): CodeGateReport {
  const cfg = { ...DEFAULTS, ...opts };
  const findings: CodeFinding[] = [];
  const add = (rule: string, message: string, severity: CodeFinding["severity"], caseId?: string) =>
    findings.push({ rule, message, severity, caseId });

  for (const f of bundle.failed)
    add("codegen-failed", `no code was produced: ${f.message}`, "block", f.caseId);

  let withoutAssertion = 0;
  let parameterized = 0;

  for (const c of bundle.code) {
    const parsed = parseCode(c.code);
    // Blocking, because it is a fact rather than an opinion: something in here cannot run.
    for (const u of parsed.unsupported) add("unsupported-call", u, "block", c.caseId);
    if (!parsed.actions.length) add("empty", "the code performs no action", "block", c.caseId);

    const all = [...c.actions];
    if (!all.some((a) => a.kind === "assert")) {
      withoutAssertion += 1;
      // A case with no assertion cannot fail. It is not a test, it is a visit.
      add("no-assertion", "nothing is asserted: this case can never fail", "block", c.caseId);
    }
    if (all.length > cfg.maxActions)
      add("granularity", `${all.length} actions — a case this long verifies nothing in particular`, "warn", c.caseId);

    if (RAW_SLEEP.test(c.code))
      add("raw-sleep", "waits on a timer instead of on a condition", "warn", c.caseId);
    if (INLINE_SECRET.test(c.code))
      add("inline-secret", "a credential is written into the source instead of ${secret.*}", "block", c.caseId);
    const intent = bundle.cases.find((t) => t.id === c.caseId);
    for (const a of all)
      if (credentialLiteral(a, intent))
        add(
          "invented-credential",
          `a literal "${a.text.slice(0, 24)}" is typed into ${a.field ?? "a credential field"} — use \${env.*} / \${secret.*}, or the case fails for a reason that has nothing to do with the product`,
          "block",
          c.caseId,
        );
    if (c.params.length) parameterized += 1;
    if (!c.uses.length && bundle.fragments.length)
      add("reuse", "repeats setup that other cases share as a fragment", "info", c.caseId);
  }

  const totalActions = bundle.code.reduce((n, c) => n + c.actions.length, 0);
  const fragmentActions = bundle.fragments.reduce((n, f) => n + f.actions.length * f.usedBy.length, 0);
  const reuseRatio = totalActions + fragmentActions ? fragmentActions / (totalActions + fragmentActions) : 0;
  if (bundle.code.length > 1 && reuseRatio < cfg.minReuseRatio)
    add("reuse", `only ${Math.round(reuseRatio * 100)}% of steps come from shared fragments`, "warn");

  const dupes = duplicateRuns(bundle.code);
  if (dupes > 0)
    add("duplication", `${dupes} step sequences are still repeated across cases`, "info");

  const blocked = new Set(findings.filter((f) => f.severity === "block" && f.caseId).map((f) => f.caseId));
  const cases = bundle.code.length + bundle.failed.length;

  return {
    score: cases ? Math.max(0, 1 - blocked.size / cases) : 0,
    findings,
    stats: {
      cases,
      fragments: bundle.fragments.length,
      reuseRatio: Number(reuseRatio.toFixed(3)),
      duplicateRuns: dupes,
      parameterized,
      withoutAssertion,
    },
  };
}

/** Cases the gate refuses to let through to execution. */
export function blockedCases(report: CodeGateReport): Set<string> {
  return new Set(
    report.findings.filter((f) => f.severity === "block" && f.caseId).map((f) => f.caseId as string),
  );
}
