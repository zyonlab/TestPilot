/**
 * 用户故事的质量检查。
 *
 * 对照 **QUS 框架**（Quality User Story）——Lucassen、Dalpiaz、van der Werf、
 * Brinkkemper，*Improving agile requirements: the Quality User Story framework and tool*，
 * Requirements Engineering 期刊（2016 年前后；正式引用前需核对卷号）。它给出 13 条准则，
 * 分句法 / 语义 / 语用三组，配套工具 AQUSA 自动检查其中一部分。
 *
 * 这里实现的是**能自动查、而且这条流水线真会犯**的那几条。选择的依据是：
 * 一条准则如果需要人判断（比如「有价值」），做成自动检查只会产生噪声。
 *
 * | QUS 准则 | 这里怎么查 | 之前有没有 |
 * |---|---|---|
 * | 良构（well-formed） | 有角色、有收益 | ✅ 已有（只是没对上名字） |
 * | **原子（atomic）** | 一条故事只讲一件事 | ❌ **新加** |
 * | **最小（minimal）** | 不夹带实现细节 | ❌ **新加** |
 * | 唯一（unique） | 标题不重复 | ❌ 新加 |
 * | 可测（testable） | 有验收标准，且写成 Given/When/Then | ❌ 新加 |
 * | 完整句（full sentence） | 标题不是一个词组 | ❌ 新加 |
 *
 * 没实现的七条里，「有价值」「可估算」「面向问题」「独立」需要人判断，
 * 「无歧义」「完整」「依赖显式」需要跨故事的语义分析——**留着不做，
 * 比做一个会误报的版本好**（需求异味那边刚吃过 80% 误报的亏）。
 *
 * 和异味检测同一条规矩：**报，不拦**。
 */

export interface StoryFinding {
  storyId: string;
  criterion: "well-formed" | "atomic" | "minimal" | "unique" | "testable" | "full-sentence";
  what: string;
  hit?: string;
}

interface StoryLike {
  id: string;
  title: string;
  role?: string;
  benefit?: string;
  acceptance?: string[];
}

/**
 * 空洞的角色。
 *
 * 「用户」不是一个角色，它是「有人」的同义词。QUS 的良构要求说得出**谁**——
 * 前台、管理员、第一次来的访客，因为不同的人要的东西不一样，而故事的价值全在那个差别上。
 *
 * 第一版只查「非空」，于是一次运行靠写「用户 / 能进入按姓氏检索主人的页面」全数通过
 * ——角色是最空洞的那个词，收益是把标题复述了一遍。**一个能被空话满足的检查，
 * 比没有检查更糟：它会给出「这一版合格」的假象。**
 */
const HOLLOW_ROLE = /^(?:用户|使用者|访客|人|某人|系统|user|someone|a user|the user)$/i;

/** 一条故事塞了两件事的迹象：并列连词把两个动作连起来。 */
const CONJUNCTION = /(?:并且|同时|以及|然后再|，还|，并)/;

/** 实现细节：故事该说「要什么」，不该说「怎么做」。 */
const IMPLEMENTATION = /选择器|selector|xpath|css\s|接口|API\b|数据库|SQL|表结构|字段名|HTTP|状态码|\.js\b|\.ts\b/i;

/** 一条验收标准要有「当…则…」的结构，否则它是描述不是判据。 */
const HAS_WHEN = /When|当|如果|若/i;
const HAS_THEN = /Then|则|就|显示|跳转|提示/i;

export function checkStory(s: StoryLike): StoryFinding[] {
  const out: StoryFinding[] = [];
  const add = (criterion: StoryFinding["criterion"], what: string, hit?: string) =>
    out.push({ storyId: s.id, criterion, what, ...(hit ? { hit } : {}) });

  // 良构：说不出「谁想要」和「能得到什么」的条目，不是用户故事，是界面事实。
  const role = s.role?.trim() ?? "";
  if (!role || !s.benefit?.trim())
    add("well-formed", "说不出谁想要、能得到什么——那不是用户故事，是一条界面事实");
  else if (HOLLOW_ROLE.test(role))
    add(
      "well-formed",
      "角色是空洞的——「用户」是「有人」的同义词，说不出是哪一种人要它",
      role,
    );

  // 原子：一条故事只讲一件事。塞两件的那条，验收标准会互相牵扯，用例也拆不干净。
  const conj = CONJUNCTION.exec(s.title);
  if (conj) add("atomic", "一条故事讲了两件事——验收标准会互相牵扯，用例也拆不干净", conj[0]);

  // 最小：不夹带实现细节。故事说「要什么」，实现细节属于代码那一层。
  const impl = IMPLEMENTATION.exec(`${s.title} ${(s.acceptance ?? []).join(" ")}`);
  if (impl) add("minimal", "夹带了实现细节——故事说要什么，不说怎么做", impl[0]);

  // 完整句：一个词组不是故事。「登录」是个功能名，「用户登录后看到自己的钱包」才是故事。
  if (s.title.trim().length < 6) add("full-sentence", "标题太短，像一个功能名而不是一件事");

  // 可测：没有验收标准的故事没法验；有而写不出「当…则…」的，是描述不是判据。
  const acc = s.acceptance ?? [];
  if (!acc.length) add("testable", "没有验收标准——没法说它什么时候算做到了");
  else {
    const vague = acc.filter((a) => !(HAS_WHEN.test(a) && HAS_THEN.test(a)));
    if (vague.length === acc.length)
      add("testable", "验收标准没有「当…则…」的结构——那是描述，不是判据", acc[0]?.slice(0, 40));
  }

  return out;
}

export interface StoryQualityReport {
  findings: StoryFinding[];
  /** 有问题的故事占比。跨版本可比——条数会被故事数量带偏。 */
  ratio: number;
  byCriterion: Record<string, number>;
}

export function checkStories(stories: StoryLike[]): StoryQualityReport {
  const findings = stories.flatMap(checkStory);

  // 唯一：标题重复的故事，复核时会被当成两件事各看一遍。
  const seen = new Map<string, string>();
  for (const s of stories) {
    const k = s.title.trim().toLowerCase();
    const first = seen.get(k);
    if (first) findings.push({ storyId: s.id, criterion: "unique", what: `和 ${first} 标题相同` });
    else seen.set(k, s.id);
  }

  const dirty = new Set(findings.map((f) => f.storyId)).size;
  const byCriterion: Record<string, number> = {};
  for (const f of findings) byCriterion[f.criterion] = (byCriterion[f.criterion] ?? 0) + 1;
  return {
    findings,
    ratio: stories.length ? Number((dirty / stories.length).toFixed(3)) : 0,
    byCriterion,
  };
}
