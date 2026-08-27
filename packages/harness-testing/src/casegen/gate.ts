import { tierOf } from "../exec/oracle.js";
import type { CaseBundle, GateFinding, GateReport, TextCase } from "./types.js";

/**
 * Gate ① — does this batch of text cases meet the test-design rules?
 *
 * It **scores and marks; it does not refuse**. That is a decision with history behind it:
 * an earlier version of this idea (a regex that rejected "vague" assertions) fired a dozen
 * times and was right zero times, catching good criteria like "the login button becomes
 * clickable again" while missing every vague one. A gate that hurts everyday work gets
 * switched off, and then it protects nothing. So findings are warnings, the score is a
 * number that can move, and the only thing allowed to block is a hard fact (stage two:
 * the code does not run).
 */

export interface GateOptions {
  /** Below this share of negative/boundary cases, an all-happy-path suite is called out. */
  minNegativeRatio?: number;
  /** A case that verifies one thing has few steps; a case with twenty verifies nothing. */
  maxSteps?: number;
  minSteps?: number;
  /** Ablation: stop judging assertion hardness (tier + vagueness). */
  gradeOracles?: boolean;
  /** Ablation: stop collapsing cases that share a dedupe key. */
  dedupe?: boolean;
}

const DEFAULTS: Required<GateOptions> = {
  minNegativeRatio: 0.3,
  maxSteps: 8,
  minSteps: 1,
  gradeOracles: true,
  dedupe: true,
};

/** Words that promise nothing: an assertion built from them cannot fail honestly. */
const VAGUE = /正常|合理|符合预期|友好|良好|恰当|适当|没有问题|正确显示|流畅|works? (correctly|fine)|as expected|properly|reasonable/i;

/** Traces of an observable phenomenon: quoted text, a number, a state change. */
const CONCRETE =
  /[「『"'“”].+[」』"'“”]|\d|等于|大于|小于|不再|不显示|出现|消失|跳转|变成|恢复|保持|停留|为空|包含|清空|残留|shown|displayed|visible|disappears?|contains?|equals?|redirect|is empty|are empty|not present|no longer|remains? on|does not contain/i;

export function runGate(bundle: CaseBundle, opts: GateOptions = {}): GateReport {
  const cfg = { ...DEFAULTS, ...opts };
  const findings: GateFinding[] = [];
  const storyIds = new Set(bundle.stories.map((s) => s.id));
  const cases = bundle.cases;

  const add = (rule: string, message: string, caseId?: string, severity: GateFinding["severity"] = "warn") =>
    findings.push({ rule, message, caseId, severity });

  // 1. Traceability — a case nobody can trace back to a story is a case nobody can review.
  let orphans = 0;
  for (const c of cases)
    if (!storyIds.has(c.storyId)) {
      orphans += 1;
      add("traceability", `${c.title} points at story ${c.storyId}, which does not exist`, c.id);
    }

  // 2. Structure and granularity.
  for (const c of cases) {
    if (c.steps.length > cfg.maxSteps)
      add("granularity", `${c.steps.length} steps — a case that verifies one thing needs few`, c.id);
    if (c.steps.length < cfg.minSteps) add("granularity", "no steps", c.id);
    if (!c.expected.trim()) add("structure", "no expected outcome: nothing to pass or fail on", c.id);
    if (cfg.gradeOracles && VAGUE.test(c.expected))
      add("oracle-vague", `assertion promises nothing checkable: "${c.expected.slice(0, 60)}"`, c.id);
    else if (cfg.gradeOracles && !CONCRETE.test(c.expected))
      add(
        "oracle-vague",
        `assertion names no observable phenomenon: "${c.expected.slice(0, 60)}"`,
        c.id,
        "info",
      );
    if (cfg.gradeOracles && c.tier === 3)
      add("tier", "judged by a model — reserve tier 3 for what nothing else can decide", c.id, "info");
    // The tier used to be a label nobody could check, so every case could claim 1 and be
    // judged by a model anyway. Now it is a claim with a fact behind it: either there is an
    // oracle a program can settle, or the case is tier 3 whatever it says about itself.
    if (cfg.gradeOracles && c.tier <= 2 && !c.oracle)
      add(
        "tier-unbacked",
        `claims tier ${c.tier} but carries no machine-checkable oracle — at execution time a model will decide it`,
        c.id,
      );
    if (cfg.gradeOracles && c.oracle && tierOf(c.oracle) > c.tier)
      add(
        "tier-unbacked",
        `claims tier ${c.tier}, but its oracle is a relation between two observations (tier ${tierOf(c.oracle)})`,
        c.id,
        "info",
      );
    for (const s of c.steps)
      if (/密码\s*[:：=]\s*\S|password\s*[:=]\s*\S/i.test(s) && !s.includes("${"))
        add("secret", `credential written into a step instead of a placeholder: "${s.slice(0, 50)}"`, c.id);
  }

  // 3. Duplicates — same key, same case in different words.
  const seen = new Map<string, TextCase>();
  let duplicates = 0;
  for (const c of cfg.dedupe ? cases : []) {
    const prev = seen.get(c.key);
    if (prev) {
      duplicates += 1;
      add("duplicate", `same coverage as "${prev.title}" (key ${c.key})`, c.id);
    } else seen.set(c.key, c);
  }

  // 4. Method mix and the happy-path check.
  const methods: Record<string, number> = {};
  for (const c of cases) methods[c.designMethod] = (methods[c.designMethod] ?? 0) + 1;
  const negatives = (methods.negative ?? 0) + (methods.boundary ?? 0);
  const negativeRatio = cases.length ? negatives / cases.length : 0;
  if (cases.length && negativeRatio < cfg.minNegativeRatio)
    add(
      "negative-ratio",
      `only ${Math.round(negativeRatio * 100)}% of cases are negative or boundary — a suite that is all happy path is not a suite`,
    );

  // 5. Stories nobody wrote a case for.
  for (const s of bundle.stories)
    if (!cases.some((c) => c.storyId === s.id)) add("story-uncovered", `story ${s.id} has no cases`);

  /**
   * 6. 这条「故事」是不是一条故事。
   *
   * 实测产出里出现过「页面底部显示社交链接和版权信息」——没有人想要它，它只是一条关于
   * 屏幕的事实。由这种条目衍生出的用例，做的也只能是「屏幕还是不是原来的样子」。
   *
   * 只标记不拒收，理由和这个门禁的其余部分一样：判断一条故事有没有价值，最终要人来看，
   * 门禁能做的是把该看的挑出来。
   */
  for (const s of bundle.stories) {
    if (!s.role?.trim() && !s.benefit?.trim())
      add(
        "story-no-actor",
        `story ${s.id} 说不出谁想要它、能得到什么——它更像一条界面事实，而不是一条用户故事`,
        undefined,
        "info",
      );
    /**
     * Given/When/Then 里最要紧的是 When：没有触发的验收标准是一句描述，不是判据。
     *
     * 触发词不能只看动词——「结账页有三个**输入**框」里的「输入」是名词的一部分，
     * 第一版就在这上面误判了。所以要求动词后面跟着「后 / 时 / 之后」，
     * 或者出现显式的 when / 当…时 / 若 / 如果。
     */
    const HAS_TRIGGER =
      /\bwhen\b|当[^，。；]{1,20}(时|后)|(点击|输入|提交|选择|勾选|访问|打开)[^，。；]{0,20}(后|时|之后)|若|如果/i;
    const noWhen = (s.acceptance ?? []).filter((a) => !HAS_TRIGGER.test(a));
    if (s.acceptance?.length && noWhen.length === s.acceptance.length)
      add(
        "acceptance-no-trigger",
        `story ${s.id} 的验收标准里没有一条说「做了什么之后」——它们是描述，不是判据`,
        undefined,
        "info",
      );
  }

  /**
   * 有多少故事挂在流程上。
   *
   * 这个比例是故事地图能不能画的前提：横轴来自流程，挂不上去的故事在地图上没有位置。
   * 它同时也是「这批故事有多少是真的能力、多少是界面事实」的粗略读数。
   */
  const anchored = bundle.stories.filter((s) => s.flowId?.trim()).length;

  /**
   * 有多少用例说得出自己走了哪条转移。
   *
   * 说不出的那些多半没在验证一次变化，而是在描述一屏——「页面显示 X」。这个比例是
   * 结构覆盖率能不能算的前提，也是「这批用例有多少在测行为」的粗略读数。
   */
  const covering = cases.filter((c) => (c.covers ?? []).length > 0).length;
  for (const c of cases)
    if (!(c.covers ?? []).length && c.designMethod === "state-transition")
      add(
        "no-transition",
        `声称是状态转移用例，却说不出它走了哪条转移`,
        c.id,
        "info",
      );

  const tiers: Record<string, number> = {};
  for (const c of cases) tiers[String(c.tier)] = (tiers[String(c.tier)] ?? 0) + 1;
  // Two distributions, deliberately: what the batch claims, and what it can actually
  // deliver. A gap between them is the number worth watching.
  const tiersBacked: Record<string, number> = {};
  for (const c of cases) {
    const real = c.oracle ? String(tierOf(c.oracle)) : "3";
    tiersBacked[real] = (tiersBacked[real] ?? 0) + 1;
  }

  return {
    // The score is a blunt instrument on purpose: a share of cases with no warning against
    // them. It is meant to move between versions, not to be a certificate.
    score: cases.length
      ? Math.max(0, 1 - new Set(findings.filter((f) => f.severity === "warn" && f.caseId).map((f) => f.caseId)).size / cases.length)
      : 0,
    findings,
    stats: {
      cases: cases.length,
      tiers,
      tiersBacked,
      stories: bundle.stories.length,
      storiesAnchored: anchored,
      casesCovering: covering,
      methods,
      negativeRatio: Number(negativeRatio.toFixed(3)),
      orphans,
      duplicates,
    },
  };
}
