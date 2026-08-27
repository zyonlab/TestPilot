import { expect, it } from "vitest";
import { sumTokens } from "../src/report.js";

// Midscene's own format, copied from a real ai-profile-stats.log.
const line = (ts: string, total: number) =>
  `[${ts}] model, Qwen3.8-27B-4bit, mode, qwen3-vl, ui-tars-version, undefined, prompt-tokens, 2551, completion-tokens, 156, total-tokens, ${total}, cost-ms, 44569, requestId, `;

const T0 = Date.parse("2026-08-19T12:00:00.000+08:00");

it("reads the comma-separated format Midscene actually writes", () => {
  expect(sumTokens(line("2026-08-19T12:30:11.646+08:00", 2707), T0)).toBe(2707);
});

it("counts only the lines inside the run window — the log spans every run ever", () => {
  const text = [
    line("2026-08-19T09:00:00.000+08:00", 9999), // an earlier run
    line("2026-08-19T12:30:11.646+08:00", 2707),
    line("2026-08-19T12:30:58.477+08:00", 2677),
  ].join("\n");
  expect(sumTokens(text, T0)).toBe(2707 + 2677);
});

it("still understands the colon form, in case the format changes back", () => {
  expect(sumTokens('{"total_tokens": 120}', T0)).toBe(120);
});

it("falls back to prompt + completion when no total is on the line", () => {
  expect(sumTokens("[2026-08-19T12:30:11.646+08:00] prompt-tokens, 100, completion-tokens, 20", T0)).toBe(120);
});

it("returns undefined rather than a made-up zero when nothing parses", () => {
  expect(sumTokens("nothing token-ish here", T0)).toBeUndefined();
  expect(sumTokens("", T0)).toBeUndefined();
});
