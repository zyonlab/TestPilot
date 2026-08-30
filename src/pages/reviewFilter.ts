import type { ArtifactCase, ArtifactStory } from "@/lib/artifact/types";

/**
 * 复核队列的筛选。
 *
 * 为什么单独一个文件：筛选是**纯函数**，而 Review 那个组件已经一千行了。更要紧的是
 * 这段逻辑要能被单独讲清楚——「哪些条目会被留下」是复核者会追问的问题，答案埋在一个
 * 大组件的中段里，没人找得到。
 *
 * 一条约束：筛选**只影响看到什么，不影响选中了什么**。人先筛出一批、全选、再改筛选条件
 * 去看别的，这时之前选中的那批不该被悄悄丢掉——批准的是他选的那批，不是他此刻看得见的那批。
 */

export interface ReviewFilters {
  /** 全文：标题、步骤、期望、前置、故事 id 一起搜。 */
  q: string;
  /** 模块（故事的 activity）。 */
  activity: string;
  /** 设计方法的英文枚举值。 */
  method: string;
  /** 判据强度 "1" | "2" | "3"。 */
  tier: string;
  /** 门禁：block 只看被拦的，warn 看有告警的，none 只看干净的。 */
  finding: "" | "block" | "warn" | "none";
  /** 有没有阶段二的代码。 */
  code: "" | "yes" | "no";
  /** 已决策的要不要看。默认全看——藏起来会让「这一批处理完了没有」变得说不清。 */
  decision: "" | "pending" | "approved" | "rejected";
}

export const EMPTY_FILTERS: ReviewFilters = {
  q: "",
  activity: "",
  method: "",
  tier: "",
  finding: "",
  code: "",
  decision: "",
};

export const isFiltering = (f: ReviewFilters): boolean =>
  Object.values(f).some((v) => v !== "");

/** URL 里用短名字，免得地址栏被撑爆；一个条件为空就不写进去。 */
const PARAM: Record<keyof ReviewFilters, string> = {
  q: "q",
  activity: "fa",
  method: "fm",
  tier: "ft",
  finding: "fg",
  code: "fc",
  decision: "fd",
};

export function filtersFromParams(p: URLSearchParams): ReviewFilters {
  const out = { ...EMPTY_FILTERS };
  for (const k of Object.keys(PARAM) as Array<keyof ReviewFilters>) {
    const v = p.get(PARAM[k]);
    if (v) (out as Record<string, string>)[k] = v;
  }
  return out;
}

/** 就地改一份 params：有值写进去，没值删掉。 */
export function filtersToParams(f: ReviewFilters, p: URLSearchParams): URLSearchParams {
  for (const k of Object.keys(PARAM) as Array<keyof ReviewFilters>) {
    const v = f[k];
    if (v) p.set(PARAM[k], v);
    else p.delete(PARAM[k]);
  }
  return p;
}

/**
 * 一条用例通不通过筛选。
 *
 * 搜索走「所有词都要命中」而不是整串匹配：人搜「电话 必填」时想找的是同时提到这两件事的
 * 用例，不是标题里正好连着写了这四个字的那一条。
 */
export function matches(
  kase: ArtifactCase,
  f: ReviewFilters,
  activityOf: (storyId: string) => string | undefined,
): boolean {
  if (f.method && kase.designMethod !== f.method) return false;
  if (f.tier && String(kase.tier) !== f.tier) return false;
  if (f.code === "yes" && !kase.code) return false;
  if (f.code === "no" && kase.code) return false;

  if (f.decision === "pending" && kase.decision) return false;
  if ((f.decision === "approved" || f.decision === "rejected") && kase.decision !== f.decision) return false;

  if (f.activity && (activityOf(kase.storyId) ?? "") !== f.activity) return false;

  if (f.finding) {
    const all = [...kase.findings, ...(kase.codeFindings ?? [])];
    if (f.finding === "none" && all.length) return false;
    if (f.finding === "block" && !all.some((x) => x.severity === "block")) return false;
    if (f.finding === "warn" && !all.some((x) => x.severity === "warn")) return false;
  }

  if (f.q.trim()) {
    const hay = [
      kase.title,
      kase.expected,
      kase.storyId,
      kase.caseId,
      ...kase.steps,
      ...kase.precondition,
      ...(kase.covers ?? []),
    ]
      .join(" ")
      .toLowerCase();
    for (const word of f.q.toLowerCase().split(/\s+/).filter(Boolean))
      if (!hay.includes(word)) return false;
  }
  return true;
}

/** 故事 id → 模块名。故事地图的横轴也用它，所以只算一次。 */
export function activityIndex(stories: ArtifactStory[] | undefined): (storyId: string) => string | undefined {
  const m = new Map<string, string | undefined>();
  for (const s of stories ?? []) m.set(s.id, s.activity?.trim() || undefined);
  return (id) => m.get(id);
}
