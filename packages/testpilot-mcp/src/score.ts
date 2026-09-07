/**
 * 打分。**分数由工具算，模型不写分**（架构 §3 的第一条红线）。
 *
 * `scoreRun` 的核心搬自 `server/src/evals.ts`，两处改动，都是 v3 的规格要的：
 *
 * 1. **`loadGold` 找不到就抛。** 老版本是
 *    `goldPath ?? GRAPH_GOLD[graphId] ?? "fixtures/mock-spec/gold-checklist.json"`——
 *    一个静默兜底。它的后果不是「少了一个分数」，是「多了一个对着错清单算出来的分数」，
 *    而那个分数读起来像一次退步。架构 §3 P2 点名要改的就是这个 `??`。
 * 2. **带完整 `binding`。** `RunMeta` 从 `runs/<id>/meta.json` 读，缺任一必填项当场抛
 *    （`runs.ts` 的 `readMeta`）。没有印记的分数进了 scoreboard，就再也分不清它能不能比。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  adjudicateMisses,
  gated,
  mcnemar,
  methodMix,
  judgeModelFromEnv,
  judgePromptDigest,
  scoreCoverage,
  type CandidateCase,
  type GoldChecklist,
  type PairedBinary,
} from "@testpilot/harness-core";
import { Held, agentState, goldHashOf, type RunMeta, type ScoreboardEntry } from "./contracts.js";
import { DEFAULT_RUNS_DIR, readCases, readMeta, resolveRunDir } from "./runs.js";

/**
 * 读一份黄金清单。**没有默认值。**
 *
 * 一份读不出来的清单只有一种诚实的处理：说出来。对着另一份清单算出来的覆盖率，
 * 每一位小数都是对的，而它回答的是另一个问题。
 */
export function loadGold(goldPath: string): { gold: GoldChecklist; path: string; hash: string } {
  const full = resolve(goldPath);
  if (!existsSync(full))
    throw new Error(
      `gold checklist not found: ${goldPath} (resolved to ${full}). ` +
        `There is no default: scoring against a different checklist produces a number that reads like a regression.`,
    );
  const raw = readFileSync(full);
  let gold: GoldChecklist;
  try {
    gold = JSON.parse(raw.toString("utf8")) as GoldChecklist;
  } catch (e) {
    throw new Error(`${full} is not readable JSON: ${(e as Error).message}`);
  }
  if (!Array.isArray(gold.items) || !gold.items.length)
    throw new Error(`${full} has no items — an empty checklist scores everything at zero, which means nothing`);
  return { gold, path: full, hash: goldHashOf(raw) };
}

/** 一条 scoreboard 条目落在运行目录里，供 `paired_eval` 检查谱系。 */
const entryPath = (runDir: string): string => join(runDir, "score.json");

export interface ScoreRunOptions {
  runId: string;
  goldPath: string;
  runsDir?: string;
  semantic?: boolean;
}

export async function scoreRun(opts: ScoreRunOptions): Promise<ScoreboardEntry> {
  const runDir = resolveRunDir(opts.runId, opts.runsDir ?? DEFAULT_RUNS_DIR);
  const binding = readMeta(runDir); // 缺印记就在这里抛，打分不会开始
  const cases = readCases(runDir);
  const { gold, path, hash } = loadGold(opts.goldPath);

  const coverage = scoreCoverage(gold, cases);

  /**
   * 语义覆盖是**第二个数**，不替代第一个。
   *
   * 主 `coverage` 必须可复现，因为「B 比 A 好吗」这个问题全靠它；一个模型坐在测量中间，
   * 同一次运行两次会得出不同的分。所以模型只被问那些确定性规则漏掉的条目，
   * 而且答案单独放一栏、单独标名字（`semantic.ts` 开头的那笔账）。
   */
  const semantic = opts.semantic
    ? await adjudicateMisses(gold, cases, coverage, gated(judgeModelFromEnv())) // 语义裁决走判官模型（P2）
    : undefined;

  const entry: ScoreboardEntry = {
    id: `sb-${Date.now().toString(36)}`,
    at: new Date().toISOString(),
    agentState: agentState(binding),
    goldHash: hash,
    // 冻结输入的指纹从 binding 原样带上，**不在这里重算**——理由同 `materialsHash`：
    // 一份指纹只该有一处算法，那一处是 `run_pipeline`（`inputHashOf`）。缺省即无冻结输入。
    inputHash: binding.inputHash,
    goldPath: path,
    runId: binding.runId,
    coverage: Number(coverage.coverage.toFixed(4)),
    heldOutCoverage: Number(coverage.heldOut.coverage.toFixed(4)),
    cases: cases.length,
    semantic: semantic
      ? {
          // 谁判的、按哪版口径。judge 一变，这一栏与旧条目不可比。
          judge: {
            model: process.env.TP_JUDGE_MODEL?.trim() || process.env.MIDSCENE_MODEL_NAME || "unknown",
            promptDigest: judgePromptDigest(),
          },
          coverage: semantic.coverage,
          heldOutCoverage: semantic.heldOutCoverage,
          matched: semantic.matched,
          stillMissing: semantic.stillMissing,
          calls: semantic.calls,
          tokens: semantic.tokens,
        }
      : undefined,
    // Formal Baseline 由人冻结，不由打分器自封。
    frozen: false,
    binding,
    matrix: {
      gold: gold.items.map((g) => {
        const hit = coverage.hits.find((h) => h.goldId === g.id);
        return {
          id: g.id,
          title: g.title,
          heldOut: !!g.heldOut,
          by: hit ? hit.by : [],
          reach: hit ? ("hit" as const) : ("miss" as const),
        };
      }),
      extras: coverage.extras.map((c) => ({ id: c.id ?? "", title: c.title })),
    },
    methodMix: methodMix(gold, coverage),
    misses: coverage.misses.map((m) => ({ id: m.id, title: m.title, heldOut: !!m.heldOut })),
  };

  writeFileSync(entryPath(runDir), JSON.stringify(entry, null, 2));
  return entry;
}

/* ------------------------------------------------------------ 配对评测 */

/** 覆盖了哪几条 gold item——配对的单元是**清单项**，不是用例。 */
function coveredIds(gold: GoldChecklist, cases: CandidateCase[]): Set<string> {
  return new Set(scoreCoverage(gold, cases).hits.map((h) => h.goldId));
}

/**
 * 上一次给这次运行打的分。用来查谱系。
 *
 * `score_run` 每次都把条目写回运行目录，所以这里读到的是「这次运行**上一回**是对着
 * 哪份清单打的」。清单变了就是新谱系（P2），而跨谱系的两个数不能相减——
 * 相减出来的差值看起来像一次改动的效果，实际上是换了一把尺子。
 */
function priorEntry(runDir: string): ScoreboardEntry | undefined {
  const p = entryPath(runDir);
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as ScoreboardEntry;
  } catch {
    return undefined;
  }
}

export interface PairedEvalOptions {
  a: string;
  b: string;
  goldPath: string;
  runsDir?: string;
}

/**
 * 两次运行，同一份清单，逐条相减。
 *
 * 配对（within-subject）而不是分两组：清单项之间的差异远大于任何一次改动的效果，
 * 随手分两半，在什么都没改的时候两半就已经不一样了（`paired.ts` 开头那段）。
 *
 * **绕过 agent**（架构 §8）：这个函数直接读两次运行的产物打分，中间没有模型、没有 skill。
 */
export async function pairedEval(opts: PairedEvalOptions): Promise<ScoreboardEntry> {
  const runsDir = opts.runsDir ?? DEFAULT_RUNS_DIR;
  const aDir = resolveRunDir(opts.a, runsDir);
  const bDir = resolveRunDir(opts.b, runsDir);
  const aMeta = readMeta(aDir);
  const bMeta = readMeta(bDir);
  const { gold, path, hash } = loadGold(opts.goldPath);

  /**
   * 谱系检查（契约 §2 拒收规则的后半句）。
   *
   * 两边**这一次**都是对着同一份 `goldPath` 打的，所以真正会出事的是另一种情形：
   * 其中一边此前已经对着**别的**清单进过 scoreboard。那条历史条目和这次的数放在一起，
   * 读的人分不出它们量的不是同一件事。
   */
  for (const [label, dir] of [
    ["a", aDir],
    ["b", bDir],
  ] as const) {
    const prev = priorEntry(dir);
    if (prev && prev.goldHash !== hash)
      throw new Held(
        "lineage",
        `run ${label} (${prev.runId}) was last scored against a different checklist ` +
          `(goldHash ${prev.goldHash} vs ${hash}) — these are different lineages and cannot be compared. ` +
          `Re-score both runs against the same gold.json first.`,
      );
  }

  /**
   * 谱系的第二条判据：冻结输入（数据契约 §2 的补充）。
   *
   * `goldHash` 不同已经在上面拒了。这里再拦一种：两臂**都**从冻结产物起跑，但冻结的
   * 那份上游不是同一份（`inputHash` 都在且不同）。那是喂了不同输入的两场进化实验——
   * 减出来的差混着「输入不同」和「skill 不同」两件事，不属于任何一边。
   *
   * 两边都没有 `inputHash`（冻结机制之前的旧运行，或整条流水线从 docs 起跑）→ 走老路，
   * 比整条流水线。一边有一边无（一臂冻结、一臂没冻结）不在这里硬拒，交给 `note` 说明。
   */
  if (aMeta.inputHash && bMeta.inputHash && aMeta.inputHash !== bMeta.inputHash)
    throw new Held(
      "lineage",
      `run a (${aMeta.runId}) and run b (${bMeta.runId}) were resumed from different frozen inputs ` +
        `(inputHash ${aMeta.inputHash} vs ${bMeta.inputHash}) — these are different evolution experiments and ` +
        `cannot be compared. To compare two candidates of one skill, feed both the same frozen upstream products.`,
    );

  const aCases = readCases(aDir);
  const bCases = readCases(bDir);
  const aCovered = coveredIds(gold, aCases);
  const bCovered = coveredIds(gold, bCases);

  const pairs: PairedBinary[] = gold.items.map((item) => ({
    id: item.id,
    a: aCovered.has(item.id),
    b: bCovered.has(item.id),
  }));
  const m = mcnemar(pairs);

  /**
   * 逐题翻转清单（US-20 的后半句）。
   *
   * McNemar 给三个数：翻了多少条、算不算数。它答不了人接着必然要问的那一句——
   * **是哪几条**。一个 p 值说服不了任何人去合并一版改动；
   * 「B 把这三条捡了回来、却把那一条丢了」可以。
   */
  const flipped = pairs
    .filter((x) => x.a !== x.b)
    .map((x) => ({
      id: x.id,
      title: gold.items.find((g) => g.id === x.id)?.title ?? x.id,
      from: (x.a ? "a" : "b") as "a" | "b",
    }));

  const bCoverage = scoreCoverage(gold, bCases);
  const entry: ScoreboardEntry = {
    id: `sb-${Date.now().toString(36)}`,
    at: new Date().toISOString(),
    agentState: agentState(bMeta),
    goldHash: hash,
    inputHash: bMeta.inputHash,
    goldPath: path,
    runId: bMeta.runId,
    coverage: Number(bCoverage.coverage.toFixed(4)),
    heldOutCoverage: Number(bCoverage.heldOut.coverage.toFixed(4)),
    cases: bCases.length,
    vsPrev: {
      entryId: agentState(aMeta),
      runId: aMeta.runId,
      mcnemar: m,
      flips: flipped.length,
      flipped,
    },
    frozen: false,
    binding: bMeta,
    /**
     * 两臂差了不止一样东西时，说出来而不是替读的人「校正」——没有诚实的事后校正法。
     * 一次同时换了 skill 版本和提示词的比较，减出来的数不属于任何一边。
     */
    note: (() => {
      const moved = bindingDrift(aMeta, bMeta);
      // 两边此前的语义栏若是不同的判官（模型或口径）判的，那一栏不可比——说出来，不悄悄放在一起。
      const ja = priorEntry(aDir)?.semantic?.judge;
      const jb = priorEntry(bDir)?.semantic?.judge;
      const judgeNote =
        ja && jb && (ja.model !== jb.model || ja.promptDigest !== jb.promptDigest)
          ? `; the semantic columns were judged by different judges (${ja.model}@${ja.promptDigest} vs ${jb.model}@${jb.promptDigest}) and do not compare`
          : "";
      if (!moved.length)
        return "the two runs share every binding field — this measures run-to-run variation, not a change" + judgeNote;
      if (moved.length > 1)
        return `the two runs differ on ${moved.join(", ")} — more than one thing changed, so this difference belongs to no single one of them${judgeNote}`;
      return `the two runs differ on ${moved[0]}${judgeNote}`;
    })(),
    matrix: {
      gold: gold.items.map((g) => {
        const hit = bCoverage.hits.find((h) => h.goldId === g.id);
        return { id: g.id, title: g.title, heldOut: !!g.heldOut, by: hit ? hit.by : [], reach: hit ? ("hit" as const) : ("miss" as const) };
      }),
      extras: bCoverage.extras.map((c) => ({ id: c.id ?? "", title: c.title })),
    },
    methodMix: methodMix(gold, bCoverage),
    misses: bCoverage.misses.map((x) => ({ id: x.id, title: x.title, heldOut: !!x.heldOut })),
  };
  return entry;
}

/** 两次运行的印记差在哪。两边差了不止一样东西时，减出来的数不属于任何一边。 */
export function bindingDrift(a: RunMeta, b: RunMeta): string[] {
  const moved: string[] = [];
  if (a.skillVersion !== b.skillVersion) moved.push("skillVersion");
  if (a.promptsDigest.combined !== b.promptsDigest.combined) moved.push("promptsDigest");
  if (a.materialsHash !== b.materialsHash) moved.push("materialsHash");
  if (JSON.stringify(a.model) !== JSON.stringify(b.model)) moved.push("model");
  // 冻结输入的差也算一样东西——两边 inputHash 都在且不同已在上面拒了，能走到这里的
  // 只剩「一臂冻结一臂没冻结」这种混搭；把它摆进 note，别让读的人以为只差了 skill。
  if ((a.inputHash ?? undefined) !== (b.inputHash ?? undefined)) moved.push("frozenInput");
  return moved;
}
