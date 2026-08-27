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
}

// Find the Midscene HTML report produced by a run and copy it to destPath.
export function captureMidsceneReport(opts: {
  midsceneDir: string; // absolute path to the midscene_run dir
  sinceMs: number;     // Date.now() captured just before the run started
  destPath: string;    // absolute path to copy the newest report HTML to
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
