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

/**
 * 一句动作是不是一个「目标」而不是一次交互。
 *
 * 提示词里明确禁止过它。判据往窄了写：`navigate to` / `go to` / `that leads to` /
 * `wait for … to`（等一屏加载完）/ `complete the …`，以及「进入…页面」这种中文写法。
 * 只报 warn——一个经常误报的门禁会被关掉，然后它什么也保护不了。
 */
const GOAL_ACTION =
  /\b(navigate to|go to|proceed to|complete the|finish the)\b|\bthat leads to\b|\bwait for\b[^,.;]*\bto (load|appear|be (fully )?(rendered|displayed|visible))|进入[^，。；]{0,12}(页面|页)|完成整个|导航到/i;
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

export function runCodeGate(
  bundle: CodeBundle,
  opts: CodeGateOptions = {},
  /** 这条用例有没有机器判据。有的话，「代码里没有断言」不再意味着「不可能失败」。 */
  oracleOf?: (caseId: string) => unknown,
): CodeGateReport {
  const cfg = { ...DEFAULTS, ...opts };
  const findings: CodeFinding[] = [];
  /**
   * `message` 仍然生成（报告、评测与日志要一句能读的话），但界面不该拿它当唯一来源：
   * 那句话在这里就拼死了，过了河是个常量，没有 key 也就没法译。所以同时给 `args`。
   */
  const add = (
    rule: string,
    message: string,
    severity: CodeFinding["severity"],
    caseId?: string,
    args?: Record<string, string | number>,
  ) => findings.push({ rule, message, severity, caseId, ...(args ? { args } : {}) });

  for (const f of bundle.failed)
    add("codegen-failed", `no code was produced: ${f.message}`, "block", f.caseId, { reason: f.message });

  let withoutAssertion = 0;
  let parameterized = 0;

  for (const c of bundle.code) {
    const parsed = parseCode(c.code);
    // Blocking, because it is a fact rather than an opinion: something in here cannot run.
    for (const u of parsed.unsupported) add("unsupported-call", u, "block", c.caseId, { call: u });
    if (!parsed.actions.length) add("empty", "the code performs no action", "block", c.caseId);

    const all = [...c.actions];
    /**
     * **有机器判据的用例，断言不在代码里——它在判据里。**
     *
     * 这条规则原来的前提是「代码里没有断言的用例不可能失败」，那在阶段二只有 `aiAssert`
     * 一种检查方式时是对的。现在不是了：带机器判据的用例，判决在最后一条语句之后由程序
     * 求值（见 `exec/run.ts`），代码里再写一句 `aiAssert` 反而有害——它跑在判据之前，
     * 模型判假就抛异常，把程序本该下的结论否掉。
     *
     * 所以代码生成被明确要求「有判据就只写动作」。而这条规则没跟着改，
     * 结果是 40 条用例里 **38 条被 block**，一条都执行不了。
     *
     * **一条规则的正确性建立在另一处的行为上，而那处行为被改了。**这在这个项目里
     * 是反复出现的形状（见 `docs/spec/13-重新规划.md` 里 dimeshift 那一节）。
     */
    const hasMachineOracle = !!oracleOf?.(c.caseId);
    if (!all.some((a) => a.kind === "assert") && !hasMachineOracle) {
      withoutAssertion += 1;
      // A case with no assertion cannot fail. It is not a test, it is a visit.
      add("no-assertion", "nothing is asserted: this case can never fail", "block", c.caseId);
    }
    if (all.length > cfg.maxActions)
      add("granularity", `${all.length} actions — a case this long verifies nothing in particular`, "warn", c.caseId, {
        n: all.length,
      });

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
    /**
     * 目标式动作。
     *
     * `CODEGEN_STABLE` 里已经写明禁止它：「never a goal ('navigate to the product list
     * page')」「never a wait-for-a-page」。但没有任何一条规则去校验模型有没有照做——
     * 实测产出里就有 `'click the navigation link or menu item that leads to the owners
     * list page'`。规律很清晰：**凡是有门禁的要求模型就照做，凡是没有的就漂**。
     *
     * 代价很实在：驱动界面的模型会把目标自己拆成动作，拆不动就放弃——于是这条用例
     * 因为措辞失败，却被报成产品坏了。这类失败最难查，因为报告上看不出它跟产品无关。
     */
    for (const a of all)
      if (a.kind !== "assert" && GOAL_ACTION.test(a.text))
        add("goal-action", `this is a goal, not an action: "${a.text.slice(0, 80)}"`, "warn", c.caseId, {
          action: a.text.slice(0, 80),
        });

    if (c.params.length) parameterized += 1;
    if (!c.uses.length && bundle.fragments.length)
      add("reuse", "repeats setup that other cases share as a fragment", "info", c.caseId);
  }

  const totalActions = bundle.code.reduce((n, c) => n + c.actions.length, 0);
  const fragmentActions = bundle.fragments.reduce((n, f) => n + f.actions.length * f.usedBy.length, 0);
  const reuseRatio = totalActions + fragmentActions ? fragmentActions / (totalActions + fragmentActions) : 0;
  if (bundle.code.length > 1 && reuseRatio < cfg.minReuseRatio)
    add("reuse", `only ${Math.round(reuseRatio * 100)}% of steps come from shared fragments`, "warn", undefined, {
      pct: Math.round(reuseRatio * 100),
    });

  /**
   * 同一个目标，在同一条故事里被写成了几种不同的话。
   *
   * 实测：`'Click the "FIND OWNERS" link in the navigation bar'` 与
   * `'click the "FIND OWNERS" link in the navigation bar'` 是相邻两条用例里的同一次导航；
   * 兽医页那次更明显，五条用例五种写法。代价有三个：收敛不成公共片段（复用率 3/38
   * 就是这么来的）、缓存命中率下降、以及同一个动作可能被驱动模型定位到不同的元素上。
   *
   * 判据只认**引号里的东西**——`"FIND OWNERS"`、`「Add Owner」`。那串字是界面上真实
   * 存在的文案，也是这句动作真正指向的目标；两句都指着它、写法却不同，就是措辞漂了。
   *
   * 第一版按关键词重合度分组，实测把「点查找链接」和「点提交按钮」并成了一组——
   * 去掉停用词之后它们都只剩下 click 和 owner。一个会报假货的门禁会被关掉，
   * 然后它什么也保护不了，所以判据换成了这个窄得多、但不会认错的。
   */
  const LITERAL = /["'“”「『]([^"'“”」』\n]{2,40})["'“”」』]/g;
  const literalsOf = (s: string): string[] =>
    [...s.matchAll(LITERAL)].map((m) => m[1]!.trim().toLowerCase()).filter((x) => x.length > 1);

  const byTarget = new Map<string, Set<string>>();
  for (const c of bundle.code) {
    const story = bundle.cases.find((t) => t.id === c.caseId)?.storyId;
    if (!story) continue;
    for (const a of c.actions) {
      if (a.kind === "assert") continue;
      for (const lit of new Set(literalsOf(a.text))) {
        const key = `${story}\u0000${lit}`;
        byTarget.set(key, (byTarget.get(key) ?? new Set()).add(a.text.trim()));
      }
    }
  }
  for (const [key, texts] of byTarget) {
    // 只差大小写与首尾空白的也算不同写法：它们同样收敛不成一个片段，也同样打不中缓存。
    if (texts.size < 2) continue;
    const lit = key.split("\u0000")[1]!;
    const samples = [...texts].slice(0, 2).map((s) => `"${s.slice(0, 48)}"`).join(" / ");
    add("wording-drift", `"${lit}" is acted on ${texts.size} different ways: ${samples}`, "info", undefined, {
      n: texts.size,
      target: lit,
      samples,
    });
  }

  const dupes = duplicateRuns(bundle.code);
  if (dupes > 0)
    add("duplication", `${dupes} step sequences are still repeated across cases`, "info", undefined, { n: dupes });

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
