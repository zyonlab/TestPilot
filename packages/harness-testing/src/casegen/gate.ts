import { tierOf } from "../exec/oracle.js";
import type { CaseBundle, FindingField, GateFinding, GateReport, TextCase } from "./types.js";

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

  /**
   * 记一条 finding。
   *
   * `message` 仍然生成——报告、评测与日志要一句能读的话。但界面不该拿它当唯一来源：
   * 那句话在这里就拼死了，过了河是个常量，没有 key 也就没法译、没法配「为什么」和
   * 「怎么改」。所以每条规则同时给 `args`（句子里的洞）与 `field`（它在挑哪个字段的毛病）。
   */
  const add = (
    rule: string,
    message: string,
    caseId?: string,
    severity: GateFinding["severity"] = "warn",
    extra?: { args?: Record<string, string | number>; field?: FindingField },
  ) => findings.push({ rule, message, caseId, severity, ...extra });

  // 1. Traceability — a case nobody can trace back to a story is a case nobody can review.
  let orphans = 0;
  for (const c of cases)
    if (!storyIds.has(c.storyId)) {
      orphans += 1;
      add("traceability", `${c.title} points at story ${c.storyId}, which does not exist`, c.id, "warn", {
        args: { storyId: c.storyId },
      });
    }

  // 2. Structure and granularity.
  for (const c of cases) {
    if (c.steps.length > cfg.maxSteps)
      add("granularity", `${c.steps.length} steps — a case that verifies one thing needs few`, c.id, "warn", {
        args: { n: c.steps.length },
        field: "steps",
      });
    if (c.steps.length < cfg.minSteps)
      add("granularity", "no steps", c.id, "warn", { args: { n: 0 }, field: "steps" });
    if (!c.expected.trim())
      add("structure", "no expected outcome: nothing to pass or fail on", c.id, "warn", { field: "expected" });
    if (cfg.gradeOracles && VAGUE.test(c.expected))
      add("oracle-vague", `assertion promises nothing checkable: "${c.expected.slice(0, 60)}"`, c.id, "warn", {
        args: { expected: c.expected.slice(0, 60) },
        field: "expected",
      });
    else if (cfg.gradeOracles && !CONCRETE.test(c.expected))
      add(
        "oracle-vague",
        `assertion names no observable phenomenon: "${c.expected.slice(0, 60)}"`,
        c.id,
        "info",
      );
    if (cfg.gradeOracles && c.tier === 3)
      add("tier", "judged by a model — reserve tier 3 for what nothing else can decide", c.id, "info", {
        args: {},
        field: "expected",
      });
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
        add("secret", `credential written into a step instead of a placeholder: "${s.slice(0, 50)}"`, c.id, "warn", {
          args: { step: s.slice(0, 50) },
          field: "steps",
        });
  }

  // 3. Duplicates — same key, same case in different words.
  const seen = new Map<string, TextCase>();
  let duplicates = 0;
  for (const c of cfg.dedupe ? cases : []) {
    const prev = seen.get(c.key);
    if (prev) {
      duplicates += 1;
      add("duplicate", `same coverage as "${prev.title}" (key ${c.key})`, c.id, "warn", {
        args: { other: prev.title, key: c.key },
        field: "title",
      });
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
    if (!cases.some((c) => c.storyId === s.id))
      add("story-uncovered", `story ${s.id} has no cases`, undefined, "warn", { args: { storyId: s.id } });

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

  /**
   * 声称覆盖了一条规格里根本没有的转移。
   *
   * 这比「说不出转移」更糟：它让结构覆盖率看起来更高，而多出来的那一条谁也走不到。
   * 评分那一侧会把它过滤掉（分子只认图上有的），但**过滤掉不等于没发生**——
   * 一条编出来的引用说明这条用例并不知道自己在验证什么。
   */
  const known = new Set(bundle.stories.flatMap(() => [] as string[]));
  for (const f of bundle.flows ?? []) for (const tr of f.transitions ?? []) known.add(tr);
  if (known.size)
    for (const c of cases)
      for (const cv of c.covers ?? [])
        if (!known.has(cv))
          add("covers-unknown", `claims to cover ${cv}, which the specification does not contain`, c.id, "warn", {
            args: { transition: cv },
            field: "covers",
          });
  for (const c of cases)
    if (!(c.covers ?? []).length && c.designMethod === "state-transition")
      add("no-transition", "claims to be a state-transition case but names no transition", c.id, "info", {
        args: {},
        field: "covers",
      });

  /**
   * 方法标签与内容对不对得上。
   *
   * 提示词把五种设计方法定义得很清楚，可没有任何一条规则去校验模型有没有照做——
   * 于是「主人列表页包含 Pets 列标题」被标成了 `boundary`。检查一个列标题存不存在，
   * 跟边界值分析没有任何关系，它是等价类里最平凡的一条。
   *
   * 一条错标的代价不止这一条：评审者只要看到一条明显对不上的标签，
   * 就会连带怀疑其余每一条，而那批标签本身是有用的。
   *
   * 判据是确定性的、粗的、只往一个方向报：**只有当一条用例里找不到任何该方法的痕迹时
   * 才记一条 info**。宁可漏，不可错杀——一个经常误报的门禁会被关掉，然后它什么也保护不了。
   */
  const TRACE: Record<string, RegExp> = {
    // 边界：空、最小、最大、刚越界、长度、位数、超出范围，或者出现具体数字
    boundary:
      /空|留空|最小|最大|上限|下限|超出|越界|临界|长度|位数|超过|不足|0|零|负|小数|溢出|empty|blank|min|max|limit|boundary|exceed|over|length|digits|negative|decimal|\d/i,
    // 负例：产品必须拒绝，并且说出来
    negative:
      /错误|失败|拒绝|不允许|无效|非法|不存在|查不到|未找到|必填|不能为空|提示|报错|校验|不合法|不符合|超出范围|invalid|error|reject|refuse|fail|not found|must (not|be)|required|forbidden|denied|out of (bounds|range)|not allowed/i,
    // 状态迁移：一次状态改变，以及改变之后必须成立的东西
    "state-transition":
      /跳转|到达|进入|返回|停留|变成|切换|之后|然后|导航|navigat|redirect|goes? to|arrives?|returns?|remains? on|then/i,
    // 判定表：多个条件的组合
    "decision-table": /同时|组合|且|并且|与.*都|when .* and |both|combination/i,
  };
  for (const c of cases) {
    const probe = TRACE[c.designMethod];
    if (!probe) continue; // equivalence 没有可判的痕迹——任何一条用例都可能是等价类的代表
    const hay = [c.title, c.expected, ...c.steps, ...(c.precondition ?? [])].join(" ");
    // 状态迁移已经有 `no-transition` 在管它说不说得出转移，这里只补「连叙述上都没有变化」。
    if (c.designMethod === "state-transition" && (c.covers ?? []).length) continue;
    if (!probe.test(hay))
      add(
        "method-mismatch",
        `labelled "${c.designMethod}", but nothing in the case shows that method at work`,
        c.id,
        "info",
        { args: { method: c.designMethod }, field: "designMethod" },
      );
  }

  /**
   * 会写数据、却不收拾自己的用例。
   *
   * 这条规则的下游是一次真事故：一批「新增主人」的用例反复跑，每跑一遍留一条 John Doe，
   * PetClinic 的冻结基线从 10 个 owner 涨到 13 个。冻结基线校验是**事后**拦住它的；
   * 这里是源头。
   *
   * 一条留下记录的用例会毒化它自己以后的每一次运行——第二次跑面对的产品和第一次不同，
   * 而这个差别一直看不见，直到某个计数断言毫无道理地挂掉，然后被当成产品缺陷去查。
   *
   * 判据看步骤里有没有写动作的痕迹。只记 info：有些「新增」提交之后被产品自己拒绝了，
   * 那种用例什么也没留下，硬拦会误伤。
   */
  /**
   * 判据分两步，因为「看起来像写」和「真的留下了东西」差得很远。
   *
   * 第一版只看动词，把「查找主人页包含 lastName 输入框、Find Owner 按钮与 **Add Owner** 链接」
   * 也报了——那个 Add Owner 是一个链接的名字，不是这条用例干的事。16 条里一多半是这种。
   *
   * 现在要求同时满足：**往表单里填过东西** + **做了一次写动作**，而且断言不是
   * 「产品拒绝了它」——被拒绝的写入什么也没留下，硬报会误伤。
   *
   * 写动作的词表里**不含**「提交 / submit」：「留空提交『Find Owner』」是一次查询，
   * 它什么也不写。第二版栽在这上面，四条误报全是查询。
   */
  const TYPES_IN = /填入|输入|填写|勾选|选择|上传|type |enter |fill|input|upload|select /i;
  const COMMITS =
    /保存|删除|移除|新增|创建|注册|添加|上传|下单|编辑|修改|add owner|save|delete|remove|create|register|sign up|upload|update/i;
  const REFUSED =
    /错误|失败|拒绝|不允许|无效|非法|必填|不能为空|校验|不合法|停留在|仍在|未创建|没有新增|invalid|error|reject|must not|required|out of (bounds|range)|remains? on|not created/i;
  for (const c of cases) {
    if ((c.postSteps ?? []).length) continue;
    // 负例多半是「产品应当拒绝」——被拒绝的写入没有留下任何东西要收拾。
    if (c.designMethod === "negative") continue;
    const typed = c.steps.some((s) => TYPES_IN.test(s));
    // 写动作在标题里说也算：「新增主人」这件事往往写在标题上，步骤里只写「点 Add Owner」。
    const committed = [c.title, ...c.steps].some((s) => COMMITS.test(s));
    if (!typed || !committed) continue;
    if (REFUSED.test(c.expected)) continue;
    add(
      "no-cleanup",
      "creates or changes something and never puts it back — it poisons every later run of itself",
      c.id,
      "info",
      { args: {}, field: "steps" },
    );
  }

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
