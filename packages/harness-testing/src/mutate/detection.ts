import type { Mutant } from "./operators.js";

/**
 * 把「干净跑 + 变异跑」的结果，变成逐条用例的**预测 vs 实际**——也就是
 * `harness-core/src/eval/detect.ts` 要的那个形状。
 *
 * ## 为什么要这一步
 *
 * 语义覆盖只问「**该测的测了多少**」，不问「**测的都对不对**」。一套生成 200 条垃圾
 * 外加 10 条好用例的系统，覆盖率和只生成那 10 条的一样高。要补上精确率，
 * 就得逐条知道「这条用例这次判得对不对」，而那需要**每条用例的实际情况**。
 *
 * ## 实际情况从哪来（不靠人标注）
 *
 * 两个来源合起来正好凑齐混淆矩阵的四个格子：
 *
 * **① 干净跑：产品是对的，所以每条用例的实际情况都是「应该通过」。**
 * 基准应用是已知正确的参照实现，这一条成立。于是这一轮里任何一条判「失败」的用例，
 * 都是**虚报**（假阳性）——它要么写错了期望，要么不稳定。
 *
 * **② 变异跑：产品被改坏了一处，而我们知道改的是哪一处。**
 * 一条用例的判据如果**正是被改坏的那句话**，它就**应该**失败；判据是别的，
 * 它应该照常通过。这条推导不需要人，也不需要猜。
 *
 * ## 这不是循环论证——但要说清楚为什么
 *
 * 变异体的**生成**绝不看用例的判据（见 `operators.ts` 那条规矩，考卷不能由考生出）。
 * 这里用到判据的是**记分**：变异体已经独立地选好了，我们只是问「给定这个变异体，
 * 哪些用例本来就该注意到它」。选题独立，判卷时对答案，这是两件事。
 *
 * ## 它量不到的（老老实实写出来）
 *
 * - **判据以外的失败算不算对，这里判不了。**一个变异体可能连带把导航改坏，
 *   于是一条判据无关的用例也失败了。那既可能是合理的连带反应，也可能是脆弱。
 *   这里一律记成「应该通过而它失败了」= 虚报，**这会低估精确率**。宁可低估。
 * - **召回率只在变异体覆盖到的范围内成立。**没有变异体碰过的行为，
 *   这个数说不了任何话。所以报召回率时必须同时报变异体数量。
 */

export interface RunOutcome {
  caseId: string;
  status: "passed" | "failed" | "unobservable";
  failKind?: string;
  /** 判据求值时页面停在哪。用来分辨「判错」和「没走到」。 */
  endedAt?: string;
  /** 这条用例声称覆盖的转移（`from->to`）。它的终点就是它该停的地方。 */
  covers?: string[];
}

/** 一条用例的判据：被检查的字面量，以及它是哪一种判据。 */
export interface CaseOracle {
  caseId: string;
  literal?: string;
  /**
   * `text` / `noText` / `url` / …。**必填**，理由见 `NOTICEABLE_BY`。
   *
   * 做成必填而不是可选，是因为「缺了就当匹配不上」和「缺了就当都匹配」都会静默出错，
   * 而这一类静默出错正是这张表要修的那个 bug。让编译器在调用方那里拦住它。
   */
  kind: string;
}

/**
 * 哪一种判据发现得了哪一种变异。
 *
 * 这张表原来不存在，`fromMutantRun` 一律只看 `text` / `noText` 判据的字面量。
 * 后果是 **relink 变异体结构上不可能有「本该失败」的用例**：它改的是 URL，
 * 而能发现 URL 被改的只有 `url` 判据，那类判据当时压根不进匹配。
 * 于是 relink 轮里每一条真实失败都被记成虚报——2026-08-29 那批
 * hide+relink 的精确率与召回率同时为 0，量的不是用例集，是这个记分法自己的边界。
 *
 * 教训跟 `inconclusive` 那次是同一条：**一个指标算得出数，不等于它在量它声称的东西。**
 * 分算子看一眼就露馅了（text 的召回率是 1.000，relink 是 0.000——
 * 真实的用例集不会有这么整齐的分界，有这种分界的是 bug）。
 */
const NOTICEABLE_BY: Record<string, readonly string[]> = {
  text: ["text", "noText"],
  // 控件藏起来，它的文案跟着从 innerText 里消失，所以还是文本判据发现它。
  // 「因为控件没了而走不到那一屏」是可达性问题，已经被 neverArrived 排除了，不在这里算。
  hide: ["text", "noText"],
  relink: ["url"],
  // 少掉一项，条数判据最直接；文案判据在少掉的正好是它引用的那一项时也发现得了。
  dropOne: ["count", "text", "noText"],
};

export interface DetectionCase {
  caseId: string;
  predicted: "passed" | "failed" | "unobservable";
  actual: "passed" | "failed";
  excluded?: boolean;
  excludeReason?: string;
}

/** 基础设施故障是「没有判决」，不是「判错了」——它必须被排除，不能算进任何一格。 */
const infraExcluded = (o: RunOutcome): boolean => o.status === "failed" && o.failKind === "infra";

/**
 * **没走到要验的那一屏，也是「没有判决」。**
 *
 * xUnit 里这两件事分得清清楚楚：failure（断言不成立）与 error（跑到断言之前就出问题了）。
 * 我们此前只有一个 `failed`，于是算精确率时把「没走到」全算成了用例虚报
 * ——**那会系统性地低估精确率，而低估的那部分看起来像用例写得差**。
 *
 * 实测例子：`S-02-5 主人列表页包含 Pets 列标题` 判据是「页面显示 Pets」。
 * PetClinic 的主人列表**确实**有 Pets 这一列（curl 验过），但 PetClinic 没有直达列表的
 * 导航——点 FIND OWNERS 只到搜索表单，要提交搜索才出现列表。于是执行停在
 * `/owners/find`，页面上当然没有 Pets。**用例是对的，产品是对的，是执行没走到。**
 *
 * 判据：这条用例声称覆盖的转移的**终点**，和它实际停下的地址对不上。
 * 用 `covers` 而不是别的，是因为那是用例自己声明的「我要走到哪」——
 * 拿它当预期终点，不需要任何额外的人工标注。
 */
const neverArrived = (o: RunOutcome): boolean => {
  if (o.status !== "failed" || !o.endedAt || !o.covers?.length) return false;
  const ends = o.covers.map((c) => c.split("->")[1]?.split("~")[0]).filter(Boolean) as string[];
  if (!ends.length) return false;
  let path = o.endedAt;
  try {
    const u = new URL(o.endedAt);
    path = u.pathname + (u.hash.startsWith("#/") ? u.hash : "");
  } catch {
    /* 相对地址，原样比 */
  }
  // 停在任何一个声称要经过的终点上，就算到了。
  return !ends.some((e) => path === e || path.endsWith(e));
};

const excludeOf = (o: RunOutcome): { excluded: true; excludeReason: string } | Record<string, never> => {
  if (infraExcluded(o)) return { excluded: true, excludeReason: "基础设施故障：没有判决，不是判错" };
  if (o.status === "unobservable") return { excluded: true, excludeReason: "判据没量到：没有判决，不是判错也不是通过" };
  if (neverArrived(o))
    return {
      excluded: true,
      excludeReason: `没走到要验的那一屏（停在 ${o.endedAt}）：这是 error 不是 failure`,
    };
  return {};
};

/**
 * 干净跑：产品是对的，所以实际情况全是「应该通过」。
 * 这一轮唯一能产生的错误是**虚报**。
 */
export function fromCleanRun(outcomes: RunOutcome[]): DetectionCase[] {
  return outcomes.map((o) => ({
    caseId: o.caseId,
    predicted: o.status,
    actual: "passed" as const,
    ...excludeOf(o),
  }));
}

/**
 * 变异跑：被改坏的那句话是已知的，所以**判据正是那句话的用例应该失败**，别的应该通过。
 *
 * 「判据正是那句话」要分算子看：改文案的只有文本判据发现得了，改链接的只有 URL 判据
 * 发现得了。见 `NOTICEABLE_BY`。
 *
 * 匹配用大小写不敏感的包含关系，理由和注入那边一样：判据里的字面量来自规格
 * （逐字引用界面文案），而变异目标来自图的控件文案（`innerText` 采的，
 * 会套 CSS 的 text-transform）——两者可能只差大小写。
 */
export function fromMutantRun(
  mutant: Mutant,
  oracles: CaseOracle[],
  outcomes: RunOutcome[],
): DetectionCase[] {
  const target = mutant.target.toLowerCase();
  const kinds = NOTICEABLE_BY[mutant.operator] ?? ["text", "noText"];
  const shouldNotice = new Set(
    oracles
      .filter((o) => kinds.includes(o.kind))
      .filter((o) => o.literal && o.literal.toLowerCase().includes(target))
      .map((o) => o.caseId),
  );
  return outcomes.map((o) => ({
    caseId: `${mutant.id}::${o.caseId}`,
    predicted: o.status,
    actual: shouldNotice.has(o.caseId) ? ("failed" as const) : ("passed" as const),
    ...excludeOf(o),
  }));
}

/**
 * 一次完整的检测评估：干净跑一轮 + 每个变异体一轮。
 *
 * 干净跑那一轮**只贡献虚报**（真阴性与假阳性），变异跑贡献真阳性与漏报。
 * 两者合起来才是一个有意义的精确率/召回率——**只有干净跑量不出召回，
 * 只有变异跑量不出虚报**。
 */
export function detectionCases(input: {
  clean: RunOutcome[];
  oracles: CaseOracle[];
  mutantRuns: Array<{ mutant: Mutant; outcomes: RunOutcome[]; applied: number }>;
}): DetectionCase[] {
  const out = fromCleanRun(input.clean);
  for (const r of input.mutantRuns) {
    // 没生效的变异体不进检测：产品其实没被改坏，用例通过是对的，
    // 把它算成「漏报」等于拿工具自己的失败去罚用例集。
    if (!r.applied) continue;
    out.push(...fromMutantRun(r.mutant, input.oracles, r.outcomes));
  }
  return out;
}
