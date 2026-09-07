/**
 * Episodic 记忆：这次运行踩了什么坑，从产物里**算**出来，不由模型叙述。
 *
 * 借 commerce-agents 的 `commerce_common/memory.py` 四条机制，不借它的内容（它记顾客偏好，
 * 我们只记 episodic——研究结论：episodic +7.56% p<0.001，semantic 单独不显著）：
 *
 * 1. **事实有形状**：key ≤ 64、value ≤ 200、category 固定枚举、带来源运行的指纹。
 *    此前是自由 markdown，进化器读不了，也没法判「这条是不是同一件事」。
 * 2. **写过滤**：token 形状的字符串（长 base64、`sk-`、`Bearer`、cookie 串、邮箱、9 位以上数字）
 *    一律拒。会话导入的 cookie、网关 key、Penguin 的 claim 链接都可能被模型顺手「记下来」。
 * 3. **抽取是确定性的**：他们用 haiku 从对话抽；我们比它更好做——`gate.json` 的 warn 规则、
 *    `holds.jsonl` 的门禁记录、`scans/<runId>.json` 的 finding 本身就是「这次踩的坑」。
 *    工具生成候选，模型只挑不写；每条候选都带它是从哪个文件算出来的。
 * 4. **注入上限**：进上下文的条数封顶（`TIER_ONE_CAP`），其余按主题取——这一条落在
 *    `testpilot-memory` skill 的文字里，MEMORY.md 索引只列最近的几条。
 *
 * 落盘形状：`agent_state/memory/user/testpilot-episodes.md`（Penguin 的记忆目录）一行一条
 * `- [<runTag>] <category>/<key>: <value>`。Penguin 的记忆是 MEMORY.md 索引 + 主题文件，
 * 所以是 markdown 行而不是 jsonl；hook `validate-memory.mjs` 逐行校验这个形状与写过滤。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const EpisodeCategory = z.enum(["gate", "hold", "scan", "infra", "material"]);

export const EpisodeSchema = z.object({
  key: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9_.-]*$/, "key 用小写字母、数字、_ . -"),
  value: z.string().min(1).max(200),
  category: EpisodeCategory,
  /** 来源运行的 runId 摘要（sha256 前 8 位）：读回来的人知道它是哪次的经验，又不把 runId 当路径。 */
  runTag: z.string().regex(/^[0-9a-f]{8}$/),
  /** 从哪个文件算出来的。候选才有；模型挑了之后照抄。 */
  source: z.string().optional(),
});
export type Episode = z.infer<typeof EpisodeSchema>;

export const runTag = (runId: string): string => createHash("sha256").update(runId).digest("hex").slice(0, 8);

/* ------------------------------------------------------------ 写过滤 */

/** 默认拒绝的形状。config 可追加，不可删。 */
export const EPISODE_BLOCKED_PATTERNS: readonly RegExp[] = [
  /(?:\d[ .()-]{0,2}){8}\d/, // 9 位以上数字（卡号、账号、电话）
  /[^\s@]+@[^\s@]+\.[A-Za-z]{2,}/, // 邮箱
  /\b(?:sk|pk|rk|ak)-[A-Za-z0-9_-]{12,}/i, // API key 形状
  /\bBearer\s+[A-Za-z0-9._-]{16,}/i, // Bearer token
  /[A-Za-z0-9+/=_-]{40,}/, // 长 base64 / JWT 段 / 会话串
  /\b(?:cookie|set-cookie|authorization)\s*[:=]/i, // 头名带值
  /https?:\/\/[^\s]*(?:claim|token|key)=[^\s]+/i, // 带凭证参数的链接（Penguin 的 claim 链接）
];

export const EPISODE_REJECTED_TEXT = "Not saved: an episode holds what went wrong in a run, never a credential, an identifier, or a session string.";

export function episodeRejected(e: Pick<Episode, "key" | "value">, extra: readonly RegExp[] = []): boolean {
  return [...EPISODE_BLOCKED_PATTERNS, ...extra].some((re) => re.test(e.key) || re.test(e.value));
}

/** 校验一条候选或一条模型写的记忆：形状 + 写过滤。不过就抛，理由能进 hook 的 reason。 */
export function validateEpisode(raw: unknown, extra: readonly RegExp[] = []): Episode {
  const e = EpisodeSchema.parse(raw);
  if (episodeRejected(e, extra)) throw new Error(EPISODE_REJECTED_TEXT);
  return e;
}

/* ------------------------------------------------------- markdown 行 */

const LINE = /^- \[([0-9a-f]{8})\] ([a-z]+)\/([a-z0-9][a-z0-9_.-]*): (.+)$/;

export function formatEpisode(e: Episode): string {
  return `- [${e.runTag}] ${e.category}/${e.key}: ${e.value}`;
}

/** 解析一行；不是这个形状就返回 undefined（调用方决定是拒还是跳过）。 */
export function parseEpisodeLine(line: string): Episode | undefined {
  const m = LINE.exec(line.trim());
  if (!m) return undefined;
  const parsed = EpisodeSchema.safeParse({ runTag: m[1], category: m[2], key: m[3], value: m[4] });
  return parsed.success ? parsed.data : undefined;
}

/* -------------------------------------------------------------- 抽取 */

const readJson = <T>(p: string): T | undefined => {
  try {
    return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as T) : undefined;
  } catch {
    return undefined;
  }
};

const clip = (s: string, n = 200) => (s.length <= n ? s : s.slice(0, n - 1) + "…");
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "x";

/**
 * 从一次运行的产物里算出候选。**每条都说得出它从哪来**；没有产物就没有候选，不编。
 *
 * - `gate.json`：每条 warn 规则一条候选，value 带命中数与一条例子；
 * - `holds.jsonl`：每道 gate 一条候选，value 带被拦次数与最后一次的理由；
 * - `scans/<runId>.json`：每种 finding kind 一条候选。
 */
export function extractEpisodes(opts: { runId: string; runDir: string; scanPath?: string }): { runTag: string; candidates: Episode[]; skipped: string[] } {
  const tag = runTag(opts.runId);
  const candidates: Episode[] = [];
  const skipped: string[] = [];
  const push = (raw: Omit<Episode, "runTag">) => {
    try {
      candidates.push(validateEpisode({ ...raw, runTag: tag }));
    } catch (e) {
      skipped.push(`${raw.category}/${raw.key}: ${(e as Error).message}`);
    }
  };

  const gate = readJson<{ score?: number; findings?: Array<{ rule: string; severity: string; message: string; caseId?: string }> }>(join(opts.runDir, "gate.json"));
  if (gate?.findings) {
    const byRule = new Map<string, Array<{ message: string; caseId?: string }>>();
    for (const f of gate.findings) if (f.severity === "warn") (byRule.get(f.rule) ?? byRule.set(f.rule, []).get(f.rule)!).push(f);
    for (const [rule, fs] of [...byRule.entries()].sort((a, b) => b[1].length - a[1].length)) {
      const ex = fs[0];
      push({
        category: "gate",
        key: `gate.${slug(rule)}`,
        value: clip(`${rule} ×${fs.length}（gate ${gate.score ?? "?"}）；例：${ex.caseId ? ex.caseId + " " : ""}${ex.message}`),
        source: "gate.json",
      });
    }
  }

  const holdsPath = join(opts.runDir, "holds.jsonl");
  if (existsSync(holdsPath)) {
    const byGate = new Map<string, Array<{ reason?: string; hook?: string }>>();
    for (const line of readFileSync(holdsPath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const h = JSON.parse(line) as { gate?: string; reason?: string; hook?: string };
        const g = h.gate ?? "?";
        (byGate.get(g) ?? byGate.set(g, []).get(g)!).push(h);
      } catch {
        // 一行坏记录不拦抽取
      }
    }
    for (const [g, hs] of byGate) {
      const last = hs[hs.length - 1];
      push({
        category: "hold",
        key: `hold.${slug(g)}`,
        value: clip(`被 ${g} 门拦 ${hs.length} 次（${last.hook ?? "hook"}）；最后一次：${(last.reason ?? "").split("。")[0]}`),
        source: "holds.jsonl",
      });
    }
  }

  const scan = opts.scanPath ? readJson<{ findings?: Array<{ kind: string; caseId: string; evidence: string }> }>(opts.scanPath) : undefined;
  if (scan?.findings) {
    const byKind = new Map<string, Array<{ caseId: string; evidence: string }>>();
    for (const f of scan.findings) (byKind.get(f.kind) ?? byKind.set(f.kind, []).get(f.kind)!).push(f);
    for (const [kind, fs] of byKind)
      push({
        category: "scan",
        key: `scan.${slug(kind)}`,
        value: clip(`${kind} ×${fs.length}；例：${fs[0].caseId} ${fs[0].evidence}`),
        source: "scans",
      });
  }

  return { runTag: tag, candidates, skipped };
}

/** 进上下文的条数上限：MEMORY.md 索引只列这么多，其余按主题文件取。 */
export const TIER_ONE_CAP = 8;
