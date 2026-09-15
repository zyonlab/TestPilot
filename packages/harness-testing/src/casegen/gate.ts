import { tierOf } from "../exec/oracle.js";
import type { CaseBundle, FindingField, GateFinding, GateReport, TextCase } from "./types.js";
import { isOpenQuestion } from "../exec/stepSemantics.js";

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
  /**
   * 分数里算不算「有人真做了的动作型准则占比」这个因子（见 runGate 文末）。
   *
   * **只有账本那条路径该开。** 那边故事被编号（`acceptanceIndex.ts`）、编号交给了模型、
   * `acRefs` 填不出编号就拒收——认领准则是契约的一部分。进程内的 `design.cases` 节点与
   * MCP `run_pipeline` 的契约里一个字都没提 `acRefs`，那边的用例天生不认领任何准则；
   * 默认开的话，每一次画布运行只要故事里有一条「点击」就是 0 分。2026-09-15 改的时候
   * 就是 `run-routes.test.ts` 先红，回头一查才发现节点臂根本不产出这一栏。
   */
  acceptanceInScore?: boolean;
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

const DEFAULTS: Required<GateOptions> = { acceptanceInScore: false,
  minNegativeRatio: 0.3,
  maxSteps: 8,
  minSteps: 1,
  gradeOracles: true,
  dedupe: true,
};

/** Words that promise nothing: an assertion built from them cannot fail honestly. */
/**
 * 一句「确认/验证 X 显示 Y」是状态，不是动作。见下面 `step-not-an-action` 的注释。
 *
 * 两段都要命中才算：光有「确认」不够——`确认下单`、`点击 Confirm` 是真动作，
 * 第二段那些状态词把它们排除在外。
 */
const CHECK_VERB = /^\s*(确认|验证|检查|断言|校验|观察|assert|verify|ensure|check|confirm)\b|^\s*(确认|验证|检查|断言|校验|观察)/i;
const STATE_WORD =
  /显示|可见|不可见|存在|不存在|出现|未出现|处于|激活|为空|非空|勾选|选中|保持|仍是|应该|是默认|为|\bis\b|\bare\b|shows?|displays?|contains?|exists?|visible|present|remains?/i;
/**
 * 第二种形状：**纯观察**。
 *
 * 2026-09-13 跑 `trade-panel.order-entry` 之前逐条看出来的：TC-013 / TC-016 / TC-017
 * 的第 2 步是「查看面板方向按钮区域」「查看面板 Size 输入框旁」——它连一个状态词都没有，
 * 上面那条「检查动词 + 状态词」两段全中的规则**漏了**。而它同样不是动作：
 * 「看一眼某个区域」在浏览器里没有对应操作，规划器只能放弃。
 *
 * 这类句子的判据是它自己：以观察动词开头，而且**整句里没有任何可执行的动词**。
 * 「查看更多」（点展开）不在此列——那里的 `更多` 后面跟着可点的东西，
 * 所以只在句子里没有出现任何动作动词时才算。
 */
const LOOK_VERB = /^\s*(查看|看一?下|观察|留意|注意|浏览|look at|observe|inspect|view)/i;
/**
 * 动作动词不能被控件名字咬住：`按钮` 里有「按」、`输入框` 里有「输入」、
 * `选择器` 里有「选择」——不排掉的话「查看面板方向按钮区域」会被当成一个动作句放过去。
 */
const ACTION_VERB =
  /点击|单击|双击|点一?下|点选|点按|轻点|敲|按下|按住|长按|填入|填写|键入|粘贴|输入(?!框)|勾选|取消勾选|选择(?!器|框)|切换(?!器)|打开|关闭|滚动|拖动|悬停|提交|导航|上传|清空|等待|click|tap|type|fill|enter|select|toggle|open|close|scroll|drag|hover|submit|navigate|upload|press|wait/i;
const STEP_IS_ASSERTION = {
  test: (s: string) => (CHECK_VERB.test(s) && STATE_WORD.test(s)) || (LOOK_VERB.test(s) && !ACTION_VERB.test(s)),
};

/**
 * 「这条准则要求用户动手吗」与「这条用例真的动手了吗」。
 * 服务端那份同义实现在 `server/src/acceptanceIndex.ts`——两边都要判，各自独立。
 */
/**
 * **动作动词表是拿真语料调出来的，不是想出来的。**
 *
 * 2026-09-14 第一版只认「点击/单击/双击」，而重跑那一轮模型写的是「用户点「Limit」」
 * ——光杆的「点」。154 条真实验收准则里，判成动作的从 89 条掉到本该有的 107 条，
 * 12 条故事被误报成「一条动作型准则都没有」，而契约正拿这份错标注在教模型写用例。
 *
 * 所以光杆的「点」要认，但得排掉名词性用法：`节点/终点/观点/重点/焦点/地点/起点`
 * 用负向后顾排，`点差/点位/点评` 用负向先行排。同理 `按` 只认 `按下/按住/长按`
 * （否则「按钮」全中），`输入` 不认 `输入框`，`选择` 不认 `选择器/选择框`。
 * `挂单` 也不能进表——「查看挂单档位」里它是名词。
 *
 * 第三版（同日）补的：重写时把 `打开/关闭` 弄丢了，`执行/设为/切到/勾上` 也没有,
 * 于是「打开持仓面板」「执行 Transfer to Spot」「将杠杆设为 20x」又被判成看一眼。
 * 三轮运行的 258 条去重语料现在判出 173 条动作型，剩下的逐条复核过：
 * 全是 `用户查看X` / `页面加载完成` / `订单成交` / `行情触及 TP 价` 这类观察与系统事件。
 */
const ACCEPTANCE_ACTION =
  /(?<![节终观重焦特优缺地时起热盲难要看论支据零冰卖买基]) ?点(?![差位评子心缀])|单击|双击|敲|按下|按住|长按|填入|填写|键入|粘贴|输入(?!框)|勾选|取消勾选|勾上|选择(?!器|框)|选中|选定|切换(?!器)|切到|滚动|拖动|拖拽|悬停|提交|上传|清空|设置|设为|设成|执行|打开|关闭|展开|收起|滑动|调整|修改|启用|停用|连接|断开|下单|撤单|撤掉|撤销|取消|平仓|开仓|转账|充值|提现|划转|刷新|重新加载|重新进入|返回|跳转|click|tap|type|fill|enter|select|toggle|scroll|drag|hover|submit|upload|press|connect|disconnect|cancel|enable|disable|reload|refresh|open|close/i;
const NAV_STEP = /^\s*(打开|访问|导航|前往|进入|open|navigate|go to)/i;
function whenClause(text: string): string {
  // 只认子句开头的 When（句首，或 `/ ， ; 换行` 之后）——2026-09-14 实测模型两种分隔都用。服务端同义实现见 acceptanceIndex.ts。
  return (/(?:^|[/,，;；\n])\s*When\s+([^/,，;；\n]+)/i.exec(text))?.[1]?.trim() ?? "";
}
function normalizeRef(x: string): string {
  return x.replace(/[\s“”"'（）()、,，。.]/g, "");
}
/** 步骤里有没有一个既不是导航、也不是「看一眼」的真实动作。 */
function caseHasAction(c: { steps?: string[] }): boolean {
  return (c.steps ?? []).some(
    (step) => !NAV_STEP.test(step) && ACCEPTANCE_ACTION.test(step) && !STEP_IS_ASSERTION.test(step),
  );
}


const VAGUE = /正常|合理|符合预期|友好|良好|恰当|适当|没有问题|正确显示|流畅|works? (correctly|fine)|as expected|properly|reasonable/i;

/**
 * **钉在易变值上的断言。**
 *
 * 实测（demo.binance.com 合约页，2026-09-01）：探索只拿到整屏转储，规格于是把
 * 「Funding 0.01000%」「Countdown 05:40:16」写成了规则，用例跟着产出
 * 「验证入口页 Funding 数值」「验证入口页 Countdown 数值」——**下一次跑必然失败**，
 * 而这一批用例在门禁上拿了满分、零条 warn。
 *
 * 十八条规则里此前没有一条拦得住它，方向甚至是反的：带数字即通过 `oracle-vague`，
 * 而 `tier-unbacked` 还在逼每条低层级用例交出字面量判据。
 *
 * **判据只认字面量，不认词。** 第一版还匹配了 `funding rate` / `24h high` / `last price`
 * 这些词，结果在真实运行上产生了 6 条全是误报的告警：
 * 「页面显示 "Funding (8h) / Countdown" 字段」「页面显示 "24h High" 字段」——
 * 它们断言的是**字段存在**，那是完全正当的，而且恰恰是提示词约束生效之后模型该写的样子。
 * 一条会把正确行为判成错的规则，第一次被误伤的人就会把它关掉，
 * 于是它连原本能抓的那一类也一起失效了。
 *
 * 所以只留三种**一望即知是快照**的字面量：时刻（05:40:16）、带三位以上小数的百分比
 * （0.01000%）、千分位大数（110,510,941,835.01）。
 * 「余额等于 100」「出现 3 条记录」这类正当断言一个都不碰。
 */
const VOLATILE_ORACLE =
  /\b\d{1,2}:\d{2}(:\d{2})?\b|\d+\.\d{3,}\s*%|\b\d{1,3}(,\d{3}){2,}(\.\d+)?\b/;

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
    /**
     * 断言钉在了一个每秒都在变的读数上——**这条用例下一次跑必然失败**。
     *
     * 报 warn 而不是 info：它不是"写得不够好"，而是"它一定会红，而红的原因和产品无关"。
     * 一条必然失败的用例比没有这条用例更糟，因为它会把真实失败淹掉。
     */
    if (cfg.gradeOracles && VOLATILE_ORACLE.test(c.expected))
      add(
        "oracle-volatile",
        `assertion is pinned to a value that changes on its own: "${c.expected.slice(0, 60)}"`,
        c.id,
        "warn",
        { args: { expected: c.expected.slice(0, 60) }, field: "expected" },
      );
    if (cfg.gradeOracles && c.tier === 3)
      add("tier", "judged by a model — reserve tier 3 for what nothing else can decide", c.id, "info", {
        args: {},
        field: "expected",
      });
    // The tier used to be a label nobody could check, so every case could claim 1 and be
    // judged by a model anyway. Now it is a claim with a fact behind it: either there is an
    // oracle a program can settle, or the case is tier 3 whatever it says about itself.
    /**
     * **判据也可以挂在断言上。**
     *
     * v2 把 `expected` 一句话拆成了 `assertions[]`，每条各带自己的 `oracle`——一条用例
     * 于是可以完全不写顶层 `oracle` 而仍然处处可判。这条规则却只看顶层：2026-09-11
     * 第二轮实测，一条臂的 53 条用例**每一条都有断言级判据**（其中 27 条是接口判据），
     * 却被 51 条 `tier-unbacked` 点名，分数 0.038。这不是它写得差，是门禁看不见。
     */
    const oracles = [c.oracle, ...(c.assertions ?? []).map((a) => a.oracle)].filter(Boolean) as NonNullable<TextCase["oracle"]>[];
    /**
     * **判决必须在屏幕上。**
     *
     * 这个产品产出的是端到端 UI 测试：一条用例驱动界面、再对界面上出现的东西下判断。
     * 去问被测产品自己的后端接口，判的就不是用户看得见的那件事——接口说下单成功而屏幕上
     * 没有那一行，这条用例会通过，而产品其实是坏的。2026-09-12 用户明确这条口径之前，
     * 提示词里写的是反的（「涉及资金或持仓状态的用例**必须**带接口判据」），
     * `fixtures/hyperliquid-testnet/cases.json` 那 8 条也全是接口判据——那些是旧口径的产物。
     *
     * 拦在这里而不只是写进提示词：提示词管的是模型愿不愿意，门禁管的是什么算合格。
     */
    for (const o of oracles)
      if (o.kind === "api")
        add("oracle-offsite", `verdict is read from the product's own API, not from the screen: ${o.url}`, c.id, "warn", { field: "expected" });
    if (cfg.gradeOracles && c.tier <= 2 && !oracles.length)
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
    /**
     * **`steps` 里只能是动作。**
     *
     * 2026-09-13 实测（exec-1f7d2cdd）：81 条里 14 条把一句前置状态确认写进了步骤——
     * TC-001 的第 2 步是「确认右侧区域显示订单簿（Order Book 标签处于激活态…）」。
     * 那是用户故事里的 Given，不是用户要做的事。执行侧把每个 step 交给 `aiAction`，
     * 而 `aiAction` 只会规划动作：Midscene 拆不动，抛 `Failed to plan actions: <理由>`，
     * 于是一条措辞问题被记成产品缺陷。
     *
     * 前置状态属于 `precondition`，事后判断属于 `assertions`——两处都有地方放，
     * 唯独 `steps` 没有。`warn` 而不是 `error`：按 caseId 计分，等于挡住这条过关。
     */
    for (const s of c.steps)
      if (STEP_IS_ASSERTION.test(s.trim()))
        add("step-not-an-action", `step states a condition instead of an action — preconditions belong in precondition, checks in assertions: "${s.slice(0, 60)}"`, c.id, "warn", {
          args: { step: s.slice(0, 60) },
          field: "steps",
        });
    for (const s of c.steps)
      if (/密码\s*[:：=]\s*\S|password\s*[:=]\s*\S/i.test(s) && !s.includes("${"))
        add("secret", `credential written into a step instead of a placeholder: "${s.slice(0, 50)}"`, c.id, "warn", {
          args: { step: s.slice(0, 50) },
          field: "steps",
        });
    /**
     * 断言挂在第几步之后判（`afterStep`），得落在步骤范围里——超出去执行器就只能在最后判，等于没写。
     * 开放问题写进断言里判不出结果（执行器只记不判）：记 info，让它挪进 readiness.reason。
     */
    for (const a of c.assertions ?? []) {
      if (a.afterStep !== undefined && a.afterStep > c.steps.length)
        add("assertion-after-step-out-of-range", `assertion ${a.id} is pinned after step ${a.afterStep}, but the case has ${c.steps.length} step(s)`, c.id, "warn", {
          args: { assertion: a.id, afterStep: a.afterStep, steps: c.steps.length },
        });
      if (isOpenQuestion(a.statement))
        add("assertion-open-question", `assertion ${a.id} is an open question, not a check — it can neither pass nor fail; move it to readiness.reason`, c.id, "info", {
          args: { assertion: a.id },
        });
    }
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
  /**
   * **负例要按场景数，不是按方法数。**
   *
   * v2 把 `negative` 从设计方法拆成了 `scenarioType`（21 §5：一条负例同样可以用边界或
   * 判定表设计出来）。这一行却一直只数 `designMethod`——于是新契约产出的用例越规范，
   * 这个比例越低。2026-09-11 实测：一批 53 条用例里 13 条 `scenarioType: "negative"`，
   * 门禁报出来的负例比例是 0.057，真值 0.245，差了四倍多，而低于阈值那条告警照样开。
   *
   * 三者取并集而不是相加：一条 `scenarioType: "negative"` 且 `designMethod: "boundary"`
   * 的用例只能算一条，相加会让比例超过 1。
   */
  const negativeIds = new Set<string>();
  for (const c of cases)
    if (c.scenarioType === "negative" || c.designMethod === "negative" || c.designMethod === "boundary")
      negativeIds.add(c.id);
  const negatives = negativeIds.size;
  const negativeRatio = cases.length ? negatives / cases.length : 0;
  if (cases.length && negativeRatio < cfg.minNegativeRatio)
    add(
      "negative-ratio",
      `only ${Math.round(negativeRatio * 100)}% of cases are negative or boundary — a suite that is all happy path is not a suite`,
    );

  // 5. Stories nobody wrote a case for.
  const subsumed = new Set(bundle.stories.flatMap((s) => s.subsumes ?? []));
  for (const s of bundle.stories)
    // 被覆盖的故事本来就没有自己的用例——那是设计，不是漏洞。它的准则在下面单独查。
    if (!subsumed.has(s.id) && !cases.some((c) => c.storyId === s.id))
      add("story-uncovered", `story ${s.id} has no cases`, undefined, "warn", { args: { storyId: s.id } });

  /**
   * 5.1 **一条要求用户动手的验收准则，没有任何用例真的动手去做它。**
   *
   * 2026-09-13 实测（81 条用例 / 29 条故事）量出的那条闭合链：
   * 模型改写 `acRefs`（85 条里 21 条），把「When 用户勾选 Reduce Only 并提交」
   * 换成「When 用户查看面板」→ 用例不需要动作（81 条里 24 条除了导航什么都不做）→
   * 判据退化成「页面上有这个字面量」→ 那种判据在初始页面上就成立
   * （`trade-panel.order-entry` 通过 9 条里 6 条是这样）→ **通过时什么都没证明**。
   *
   * 契约与服务端已经从两头堵：验收准则带编号交出去，`acRefs` 填不出编号就拒收。
   * 门禁这一条管的是另一件事——**编号对上了，动作却没做**。
   * S-08「输入超出 szDecimals 小数位的数量」「切换计价单位」两条动作型准则，
   * 当时一条用例都没认领，而 TC-016/017 认领它时把 When 改成了「查看」。
   *
   * 按 storyId 计分而不是 caseId：漏掉的是一条准则，不是某一条用例的毛病。
   */
  /**
   * 被覆盖的故事，它的准则由**覆盖它的那条故事的用例**了结（`StorySchema.subsumes`）。
   * 所以这里不能只看 `storyId` 相等的用例——那样长故事刚把短用例合并掉，
   * 门禁就会反过来报「这些准则没人认领」，把想要的结构判成缺陷。
   */
  const coveredBy = new Map<string, string>();
  for (const s of bundle.stories) for (const id of s.subsumes ?? []) coveredBy.set(id, s.id);
  /** 动作型准则的分母与没人真做的那几条——分数要用（见文末 score）。 */
  let actionable = 0;
  const uncoveredAc: string[] = [];
  for (const s of bundle.stories) {
    const owner = coveredBy.get(s.id) ?? s.id;
    const mine = cases.filter((c) => c.storyId === s.id || c.storyId === owner);
    (s.acceptance ?? []).forEach((text, i) => {
      if (!ACCEPTANCE_ACTION.test(whenClause(text) || text)) return;
      actionable += 1;
      const id = `${s.id}/AC-${i + 1}`;
      const claimed = mine.filter((c) => (c.acRefs ?? []).some((r) => r === id || normalizeRef(r) === normalizeRef(text)));
      if (!claimed.length) {
        uncoveredAc.push(id);
        add("acceptance-uncovered", `${id} 要求用户动手（When ${(whenClause(text) || text).slice(0, 34)}），却没有任何用例认领它`, undefined, "warn", { args: { storyId: s.id, acId: id } });
      } else if (!claimed.some(caseHasAction)) {
        uncoveredAc.push(id);
        add("acceptance-uncovered", `${id} 要求用户动手，而认领它的 ${claimed.map((c) => c.id).join("/")} 步骤里只有导航和查看——没有人真的做过这个动作`, undefined, "warn", { args: { storyId: s.id, acId: id } });
      }
    });
  }

  /**
   * 5.2 **一条用例除了导航之外什么都不做。**
   *
   * 81 条里 24 条是这样，其中 11 条是纯「打开页面 + 看一眼」。这种用例的判据必然是
   * 「页面上有某个字面量」，而它在初始页面上就已经成立——它测的是「这一页还在」。
   * 展示型需求确实存在，所以是 `warn` 不是 `error`；但它得被数出来。
   */
  for (const c of cases)
    if ((c.steps ?? []).length && !caseHasAction(c))
      add("case-without-action", `除了导航之外没有任何动作，步骤只是看：${(c.steps ?? []).join(" | ").slice(0, 70)}`, c.id, "warn", { field: "steps" });

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
  /**
   * **`flows` 为空时不能就此放行。**
   *
   * 原来这里是 `if (known.size)`：一份没有流程的产物，任何 `covers` 值都免检。
   * 2026-09-11 实测（docs/v3/22）：一条臂的 67 条用例里有 27 条填了 `covers`，
   * 值形如 `/trade~6 --[点「Trades」]--> /trade~7`——那是状态转移图**人类可读摘要里的一行**，
   * 不是转移 id。产物的 `flows` 是空的，于是这 27 条编造的引用一条都没被点到，
   * 门禁还给了满分，而结构覆盖率凭空多了 27 条谁也走不到的边。
   *
   * 「查不了」和「查过了没问题」是两件事。没有可对照的流程时，一条 `covers` 是
   * **无法核实的主张**，必须说出来。
   */
  /**
   * 没有流程可对照时，退一步看**用例自己的状态模型**。
   *
   * 上面那条规则原来一律记 warn。它抓对过一次（27 条编造的 id），但它也把另一种情况
   * 一起判了：一条带 `design.technique: "state-transition"` 的用例，它的 `covers` 和
   * `design.transitionIds` 是同一批边，还写明了 `stateModelRef`——这批边**查得到出处**，
   * 只是产品侧还没有一份转移清单可以对照。
   *
   * 2026-09-11 第二轮实测：两条臂都被这一条打到 0 分，其中一条的 112 条用例里有 85 条
   * 带真正的程序判据、66 条带完整状态证据，另一条 53 条一个判据都没有。一条把两者判成
   * 同一个分数的规则，没有区分能力，也就没有用。
   *
   * 所以按证据分档：说得出自己的状态模型、且 `covers` 与 `transitionIds` 一致的，记 info
   * （缺口在产品模型没有转移清单，不在这条用例）；说不出的，仍然记 warn。
   */
  if (!known.size)
    for (const c of cases) {
      const covers = c.covers ?? [];
      if (!covers.length) continue;
      const d = c.design;
      const selfDeclared =
        d?.technique === "state-transition" && covers.every((cv) => d.transitionIds.includes(cv));
      add(
        "covers-unverifiable",
        selfDeclared
          ? `names transitions from its own state model ${d.stateModelRef}, but the product model carries no transition inventory to check them against`
          : "names transitions to cover, but this bundle carries no flows to check them against",
        c.id,
        selfDeclared ? "info" : "warn",
        { args: { transitions: covers.join(", ") }, field: "covers" },
      );
    }
  if (known.size)
    for (const c of cases)
      for (const cv of c.covers ?? [])
        if (!known.has(cv))
          add("covers-unknown", `claims to cover ${cv}, which the specification does not contain`, c.id, "warn", {
            args: { transition: cv },
            field: "covers",
          });
  /**
   * 声称用了某种设计方法，却没给设计证据（21 §5）。
   *
   * 记 **info** 而不是 warn：这些字段 2026-09-11 才进 schema，历史产物一条都没有，
   * 记 warn 会把每一批旧归档的分数一起改掉——而分数要能重放。它的作用是让缺口**可见**，
   * 不是把旧账翻出来重判。等新链路稳定产出之后再考虑提级，那要单独决定。
   */
  for (const c of cases)
    if (!c.design && c.designMethod !== "negative")
      add("design-evidence-missing", `claims ${c.designMethod} but gives no design evidence`, c.id, "info", {
        args: { method: c.designMethod },
        field: "designMethod",
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
   *
   * **但第三版收过头了。** 2026-08-30 的 case-cleanup 评测里，B 臂 36 条用例一条清理都
   * 没有、其中一大半是登录用例，而这条规则一条都没抓到——因为词表里只有
   * 「新增 / 保存 / 删除」这类**对数据**的写，没有「登录」。
   *
   * 登录不写数据，但它**留下会话**：下一条用例面对的是一个已登录的产品，而它自己不知道。
   * 这跟留下一条 John Doe 是同一种毒——第二次跑面对的产品和第一次不同，
   * 差别看不见，直到某个断言毫无道理地挂掉。
   *
   * 所以判据的正确说法不是「有没有写动作」，是「**跑完之后产品还在不在原来的状态**」。
   * 会话与数据都算。而登录和查询的区别也正在这里：查询什么也不留下。
   */
  const TYPES_IN = /填入|输入|填写|勾选|选择|上传|type |enter |fill|input|upload|select /i;
  const COMMITS =
    /保存|删除|移除|新增|创建|注册|添加|上传|下单|编辑|修改|登录|登入|签入|add owner|save|delete|remove|create|register|sign up|sign in|log ?in|upload|update/i;
  const REFUSED =
    /错误|失败|拒绝|不允许|无效|非法|必填|不能为空|校验|不合法|停留在|仍在|未创建|没有新增|invalid|error|reject|must not|required|out of (bounds|range)|remains? on|not created/i;
  /**
   * 自己收拾干净的用例。
   *
   * 「有效登录后点击 Log out，不再显示个人面板」这条**在自己的步骤里就把状态还原了**——
   * 跑完之后没有会话留下，不需要 postSteps。加宽词表之后这类被误报了 3 条，
   * 而它们恰恰是**唯一真的在测清理路径**的那几条，报它们最伤人。
   */
  const UNDOES = /退出|登出|注销|删除刚|还原|恢复|log ?out|sign ?out|revert/i;
  for (const c of cases) {
    if ((c.postSteps ?? []).length) continue;
    // 负例多半是「产品应当拒绝」——被拒绝的写入没有留下任何东西要收拾。
    if (c.designMethod === "negative") continue;
    if ([c.title, ...c.steps].some((s) => UNDOES.test(s))) continue;
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
    // 同上：断言级判据也算数，取这条用例能交付的**最硬**的那一层。
    const all = [c.oracle, ...(c.assertions ?? []).map((a) => a.oracle)].filter(Boolean) as NonNullable<TextCase["oracle"]>[];
    const real = all.length ? String(Math.min(...all.map((o) => tierOf(o)))) : "3";
    tiersBacked[real] = (tiersBacked[real] ?? 0) + 1;
  }

  // 把分拖下来的到底是哪几条。分数就是从这个集合算出来的，所以它不是"另算一遍"，
  // 而是把同一次计算的中间结果留下来——界面因此能从 58% 一步点到那几条上。
  const flagged = [
    ...new Set(findings.filter((f) => f.severity === "warn" && f.caseId).map((f) => f.caseId as string)),
  ];
  /**
   * **分数是两个比例的乘积：没被警告点到的用例占比 × 有人真做了的动作型准则占比。**
   *
   * 此前只有前一半。`acceptance-uncovered` 按故事记、不带 caseId，于是**永远进不了
   * `flagged`**——漏掉的准则再多，分数一分不扣。一个用例量小的运行最容易撞上：
   * 用例少，被点名的用例就少，而没人认领的准则反而多。2026-09-15 回查已存的门禁报告：
   *
   *   | 运行                               | 旧分 | 动作型准则 | 没人真做 | 新分  |
   *   | Vikunja · Claude Code 宿主（19 条）| 1.0  | 16         | 4        | 0.75  |
   *   | Hyperliquid · Claude Code（11 条） | 1.0  | 14         | 6        | 0.571 |
   *   | Hyperliquid · Web（86 条）         | 0.814| 53         | 1        | 0.799 |
   *
   * 前两次拿的是满分，而其中一次有 43% 的动作型准则没有任何用例去做——
   * 门禁在这类运行上说的「完美」恰好是它最没看住的时候。第三行几乎不动：
   * 覆盖好的运行不会被这个改动误伤。
   *
   * 乘而不是加权平均：两件事都得成立，任一半塌了分数就该跟着塌，不该被另一半的高分垫起来。
   * 没有动作型准则时第二个因子取 1——没有要做的动作，就谈不上漏做。
   * 这个因子只在 `acceptanceInScore` 打开时生效，理由写在 GateOptions 上。
   */
  const caseShare = cases.length ? Math.max(0, 1 - flagged.length / cases.length) : 0;
  const acceptanceCounts = cfg.acceptanceInScore === true && actionable > 0;
  const acceptanceShare = acceptanceCounts ? (actionable - uncoveredAc.length) / actionable : 1;
  const score = caseShare * acceptanceShare;

  return {
    // The score is a blunt instrument on purpose. It is meant to move between versions, not to be a certificate.
    score,
    scoreBasis: {
      cases: cases.length,
      flagged,
      // 只在它真的进了分数时才写出来——界面会照着它说「分数的另一半掉在这里」，没算进去就不能这么说。
      ...(cfg.acceptanceInScore === true ? { acceptance: { actionable, uncovered: uncoveredAc } } : {}),
      formula: acceptanceCounts
        ? `(1 − ${flagged.length}/${cases.length}) × (1 − ${uncoveredAc.length}/${actionable})（被警告点到的用例 ÷ 全部用例；没人真做的动作型准则 ÷ 全部动作型准则）`
        : `1 − ${flagged.length}/${cases.length}（被警告点到的用例 ÷ 全部用例）`,
    },
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
      /*
       * **阈值和比例一起给出去。**
       *
       * 门禁自己会在低于阈值时出一条 finding（见上面 `negativeRatio < cfg.minNegativeRatio`），
       * 所以规则一直是执行着的。但界面上只印得出「31% negative」——一个没有分母的数：
       * 31% 是达标了还是差得远？人得先去翻图定义里的 `minNegativeRatio` 才知道。
       * AC-05.2 的原话是「不低于阈值」，那么阈值就该和比例印在一起。
       */
      minNegativeRatio: cfg.minNegativeRatio,
      orphans,
      duplicates,
    },
  };
}
