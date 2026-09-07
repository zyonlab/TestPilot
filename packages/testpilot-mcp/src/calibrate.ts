/**
 * 校准 judge：它和人有多一致，以及它和**它自己**有多一致。
 *
 * 两个数缺一不可，而项目里此前一个都没有：
 *
 * - **κ**（Cohen's kappa）而不是原始一致率。调研里最硬的一条：原始一致率换成 κ 会掉
 *   33–41 个点。原因是原始一致率把「瞎猜也能对上的那部分」算进去了——在一个九成条目都
 *   判「没覆盖」的集合上，一个永远说「没覆盖」的 judge 能拿 90% 一致率和 κ = 0。
 * - **spread**：同一条判 n 次，有多少条判出了不同答案。单次 pairwise 翻转率实测 13.6%；
 *   一个 κ 很高但 spread 也很高的 judge，它那个 κ 是这一次的运气。
 *
 * 用的是 `adjudicateMisses` **本身**（`harness-core/eval/semantic.ts`），不是它的复制品：
 * 校准一份和线上不一样的提示词，量出来的数不属于线上那个 judge。
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  adjudicateMisses,
  cohensKappa,
  gated,
  judgeModelFromEnv,
  type CandidateCase,
  type CoverageResult,
  type GoldChecklist,
  type GoldItem,
} from "@testpilot/harness-core";
import { HumanLabelSchema, type Calibration, type HumanLabel } from "./contracts.js";
import { loadGold } from "./score.js";
import { DEFAULT_RUNS_DIR, readCases, resolveRunDir } from "./runs.js";

export function loadLabels(labelsPath: string): HumanLabel[] {
  const full = resolve(labelsPath);
  if (!existsSync(full))
    throw new Error(
      `human labels not found: ${labelsPath} (resolved to ${full}). ` +
        `Calibration has no fallback — a judge measured against labels it wrote itself measures nothing.`,
    );
  const raw = JSON.parse(readFileSync(full, "utf8")) as unknown;
  const list = Array.isArray(raw) ? raw : ((raw as { labels?: unknown[] })?.labels ?? []);
  const parsed = HumanLabelSchema.array().safeParse(list);
  if (!parsed.success) throw new Error(`${full} is not HumanLabel[]: ${parsed.error.issues[0]?.message ?? "bad shape"}`);
  if (!parsed.data.length) throw new Error(`${full} holds no labels`);
  return parsed.data;
}

/**
 * 单项判定：这条用例覆盖了这条清单项吗。
 *
 * 做法是给 `adjudicateMisses` 喂一个只含这一条 miss、只含这一条候选用例的输入。
 * 绕一点，但换来的是**同一段提示词、同一套解析、同一条失败即判未覆盖的规则**——
 * 手写一份第二版的单项判定，量的就是那一版，而线上跑的是另一版。
 */
async function judgeOnce(
  gold: GoldChecklist,
  item: GoldItem,
  kase: CandidateCase,
  model: Parameters<typeof adjudicateMisses>[3],
): Promise<boolean> {
  const deterministic: CoverageResult = {
    coverage: 0,
    hits: [],
    misses: [item],
    extras: [],
    heldOut: { coverage: 0, hits: [], misses: [] },
    totals: { gold: gold.items.length, heldOut: 0, cases: 1 },
  };
  const out = await adjudicateMisses(gold, [kase], deterministic, model, { maxCandidates: 1 });
  return out.matched.some((m) => m.goldId === item.id);
}

export interface CalibrateOptions {
  labelsPath: string;
  goldPath: string;
  runsDir?: string;
  runs?: number;
}

export async function calibrateJudge(opts: CalibrateOptions): Promise<Calibration> {
  const runs = opts.runs ?? 3;
  const labels = loadLabels(opts.labelsPath);
  const { gold } = loadGold(opts.goldPath);
  const byGoldId = new Map(gold.items.map((i) => [i.id, i]));
  const model = gated(judgeModelFromEnv()); // 判官≠生成器（P2）

  // 一次运行的用例读一遍就够：标注常常集中在同一次运行上。
  const caseCache = new Map<string, CandidateCase[]>();
  const casesOf = (runId: string): CandidateCase[] => {
    const hit = caseCache.get(runId);
    if (hit) return hit;
    const list = readCases(resolveRunDir(runId, opts.runsDir ?? DEFAULT_RUNS_DIR));
    caseCache.set(runId, list);
    return list;
  };

  const items: Calibration["items"] = [];
  for (const label of labels) {
    const item = byGoldId.get(label.goldId);
    if (!item)
      throw new Error(`label refers to goldId "${label.goldId}", which is not in ${opts.goldPath} — different lineages`);
    const cases = casesOf(label.runId);
    const kase = cases.find((c) => c.id === label.caseId);
    if (!kase) throw new Error(`label refers to caseId "${label.caseId}", which run ${label.runId} does not contain`);

    const votes: boolean[] = [];
    for (let i = 0; i < runs; i++) votes.push(await judgeOnce(gold, item, kase, model));
    const yes = votes.filter(Boolean).length;
    items.push({
      goldId: label.goldId,
      caseId: label.caseId,
      human: label.covered,
      votes,
      // 多数票。偶数次时打平算「未覆盖」——保守的方向是继续报一个缺口，
      // 而不是凭一次五五开的判断宣布覆盖到了。
      judge: yes * 2 > runs,
      unstable: yes !== 0 && yes !== runs,
      heldOut: label.heldOut,
    });
  }

  const { kappa, agreement, confusion } = cohensKappa(items.map((i) => ({ judge: i.judge, human: i.human })));
  const spread = items.length ? Number((items.filter((i) => i.unstable).length / items.length).toFixed(3)) : 0;

  return {
    kappa,
    spread,
    n: items.length,
    runs,
    agreement,
    confusion,
    items,
    note:
      `kappa is chance-corrected agreement between the model judge's majority vote and the human labels; ` +
      `spread is the share of items whose ${runs} judgements were not unanimous. ` +
      `A high kappa with a high spread is a lucky draw, not a calibrated judge.`,
  };
}
