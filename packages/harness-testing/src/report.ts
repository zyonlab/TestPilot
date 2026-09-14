// Captures Midscene.js's generated run report so our platform can surface it.
// Midscene writes, under a `midscene_run/` dir: `report/*.html` (one interactive
// HTML report per agent run) and `log/` files (ai-profile-stats.log, ai-call.log).
// This module finds the newest report HTML produced during a run window, copies it
// to a destination path, and makes a best-effort attempt to total the tokens used.
// It never throws: on any error it degrades to omitting tokens or returning `{}`.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";

export interface CapturedReport {
  reportPath?: string; // absolute path where the report HTML was copied (destPath), if found
  tokens?: number;     // best-effort total tokens used during the run (omit if not parseable)
  /** 这一次运行的账：模型调了几次、花了多少毫秒、缓存命中了几次。见 `parseSpend`。 */
  spend?: RunSpend;
}

/**
 * 一次运行花了什么。
 *
 * 「30 条 P0 要几个小时」这件事，此前只有一个 `durationMs` 能看，看不出时间花在哪：
 * 是模型在想（`modelMs`），还是缓存没命中所以每一步都在问模型（`cacheMisses`），
 * 还是缓存有但元素找不到、退回了模型（`cacheStale`）。执行层要降本，先得分得清这三样。
 *
 * 四个数都从 Midscene 自己的日志里按时间窗读出来（`ai-profile-stats.log`、`cache.log`），
 * 和 `parseTokens` 同一个来源、同一条纪律：日志跨运行追加，所以必须按窗口过滤；
 * **并发 > 1 时窗口会重叠，数字会串**——那时 `spend` 记的是这段时间里所有运行的和，
 * 报表要把它标出来而不是当成单条用例的账。
 */
export interface RunSpend {
  /** 模型被调了几次（一次 aiAction 可能是多次调用——这里数的是真实请求）。 */
  modelCalls: number;
  /** 这些调用加起来的毫秒数（模型侧，不含浏览器动作）。 */
  modelMs: number;
  /** 总 token（和 `tokens` 同源，放在一起方便算单价）。 */
  tokens: number;
  /** 计划/定位命中缓存的次数——这些步没有问模型。 */
  cacheHits: number;
  /** 没有可用缓存、问了模型的次数。 */
  cacheMisses: number;
  /** 缓存里有、但页面上对不上（元素变了），退回模型的次数。这是「自愈」发生的地方。 */
  cacheStale: number;
  /**
   * 墙钟拆成六段（runner 侧量，服务端合并进来）。没有它就只知道「二跑还要 40 秒」，
   * 不知道这 40 秒是起浏览器、登录态还是 settle——降本的下一刀要落在哪一段（07 T-28）。
   */
  phases?: RunPhases;
  /**
   * 这份账是怎么归到这条运行头上的（07 T-04）：`runner` = 从跑它的 runner 自己的 Midscene 目录读，
   * 一个 runner 一次只跑一条，精确；`window` = 从共享目录按时间窗读，并发 > 1 时会串。报表把 window 的行标灰。
   */
  attribution?: "runner" | "window";
}

/** 一次运行的墙钟分段。全部是毫秒；没走到的段是 0，不是 undefined。 */
export interface RunPhases {
  /** 起浏览器到页面就绪（含注入钱包、storageState）。 */
  launchMs: number;
  /** 环境登录态步骤。 */
  loginMs: number;
  /** dapp settle 与判据「前」读数。 */
  settleMs: number;
  /** 用例步骤本身。 */
  stepsMs: number;
  /** 判据求值（含接口判据的 settleMs 等待）与链上断言。 */
  assertMs: number;
  /** teardown（postSteps）。 */
  teardownMs: number;
}

// Find the Midscene HTML report produced by a run and copy it to destPath.
export function captureMidsceneReport(opts: {
  midsceneDir: string; // absolute path to the midscene_run dir
  sinceMs: number;     // Date.now() captured just before the run started
  destPath: string;    // absolute path to copy the newest report HTML to
  /** 运行结束的时刻。不给就读到日志末尾——单并发时等价，多并发时会把后面的运行算进来。 */
  untilMs?: number;
}): CapturedReport {
  try {
    const reportDir = `${opts.midsceneDir}/report`;
    if (!existsSync(reportDir)) return {};

    let newest: { path: string; mtimeMs: number } | undefined;
    for (const name of readdirSync(reportDir)) {
      if (!name.endsWith(".html")) continue;
      const path = `${reportDir}/${name}`;
      let mtimeMs: number;
      try {
        mtimeMs = statSync(path).mtimeMs;
      } catch {
        continue;
      }
      if (mtimeMs < opts.sinceMs) continue;
      if (!newest || mtimeMs > newest.mtimeMs) newest = { path, mtimeMs };
    }
    if (!newest) return {};

    mkdirSync(dirname(opts.destPath), { recursive: true });
    copyFileSync(newest.path, opts.destPath);

    const result: CapturedReport = { reportPath: opts.destPath };
    const tokens = parseTokens(opts.midsceneDir, opts.sinceMs);
    if (tokens !== undefined) result.tokens = tokens;
    const spend = parseSpend(opts.midsceneDir, opts.sinceMs, opts.untilMs);
    if (spend) result.spend = spend;
    return result;
  } catch {
    return {};
  }
}

/**
 * Tokens spent during ONE run.
 *
 * Two things this has to get right, both learned the hard way:
 *   * the log format is `total-tokens, 2707` — comma separated, not `total_tokens: 2707`.
 *     A parser that only knew the colon form silently returned undefined for every run
 *     since the beginning, which is why nothing ever had a token count.
 *   * these log files are append-only across ALL runs, so the lines must be filtered by
 *     the run window. Summing the file would report the project's lifetime spend as if it
 *     belonged to the last run.
 */
export function parseTokens(midsceneDir: string, sinceMs: number): number | undefined {
  const path = `${midsceneDir}/log/ai-profile-stats.log`;
  if (!existsSync(path)) return undefined;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  return sumTokens(text, sinceMs);
}

/** Exported for testing: the format is Midscene's, so it deserves pinning down. */
export function sumTokens(text: string, sinceMs: number): number | undefined {
  let total = 0;
  let found = false;
  for (const line of text.split("\n")) {
    const at = line.match(/^\[([^\]]+)\]/);
    if (at) {
      const ts = Date.parse(at[1]);
      // A line without a parseable timestamp is kept: dropping it would under-report,
      // and under-reporting cost is the direction that hides problems.
      if (Number.isFinite(ts) && ts < sinceMs) continue;
    }
    const m =
      line.match(/total[_-]?tokens["']?\s*[,:=]\s*(\d+)/i) ??
      line.match(/["']?total[_-]?tokens["']?\s*[:=]\s*(\d+)/i);
    if (m) {
      total += Number(m[1]);
      found = true;
      continue;
    }
    // No total on this line: fall back to prompt + completion.
    const parts = [...line.matchAll(/(?:prompt|completion)[_-]?tokens["']?\s*[,:=]\s*(\d+)/gi)];
    if (parts.length) {
      for (const p of parts) total += Number(p[1]);
      found = true;
    }
  }
  if (!found || !Number.isFinite(total) || total <= 0) return undefined;
  return total;
}

/** 一次运行的账。任一日志缺失时返回能读到的那部分；两份都没有返回 undefined。 */
export function parseSpend(midsceneDir: string, sinceMs: number, untilMs?: number): RunSpend | undefined {
  const read = (name: string): string | undefined => {
    const path = `${midsceneDir}/log/${name}`;
    if (!existsSync(path)) return undefined;
    try {
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  };
  const stats = read("ai-profile-stats.log");
  const cache = read("cache.log");
  if (stats === undefined && cache === undefined) return undefined;
  return sumSpend(stats ?? "", cache ?? "", sinceMs, untilMs);
}

/** 行首时间戳在窗口内才算这次的。没有时间戳的行保留（和 `sumTokens` 同一条纪律：少报是藏问题的方向）。 */
function inWindow(line: string, sinceMs: number, untilMs?: number): boolean {
  const at = line.match(/^\[([^\]]+)\]/);
  if (!at) return true;
  const ts = Date.parse(at[1]);
  if (!Number.isFinite(ts)) return true;
  if (ts < sinceMs) return false;
  if (untilMs !== undefined && ts > untilMs) return false;
  return true;
}

/**
 * Exported for testing. 两份日志的格式都是 Midscene 的：
 *   ai-profile-stats.log  `[ts] model, X, mode, Y, ..., total-tokens, 2745, cost-ms, 17040, ...`
 *   cache.log             `[ts] cache hit, type: plan, ...`
 *                         `[ts] no unused cache found, type: locate, ...`
 *                         `[ts] rectMatchesCacheFeature error: ...`（缓存在、元素对不上）
 */
export function sumSpend(statsText: string, cacheText: string, sinceMs: number, untilMs?: number): RunSpend {
  const spend: RunSpend = { modelCalls: 0, modelMs: 0, tokens: 0, cacheHits: 0, cacheMisses: 0, cacheStale: 0 };
  for (const line of statsText.split("\n")) {
    if (!inWindow(line, sinceMs, untilMs)) continue;
    const tok = line.match(/total[_-]?tokens["']?\s*[,:=]\s*(\d+)/i);
    const ms = line.match(/cost[_-]?ms["']?\s*[,:=]\s*(\d+)/i);
    if (!tok && !ms) continue;
    spend.modelCalls += 1;
    if (tok) spend.tokens += Number(tok[1]);
    if (ms) spend.modelMs += Number(ms[1]);
  }
  for (const line of cacheText.split("\n")) {
    if (!inWindow(line, sinceMs, untilMs)) continue;
    if (/\] cache hit,/.test(line)) spend.cacheHits += 1;
    else if (/\] no unused cache found/.test(line)) spend.cacheMisses += 1;
    else if (/rectMatchesCacheFeature error/.test(line)) spend.cacheStale += 1;
  }
  return spend;
}
