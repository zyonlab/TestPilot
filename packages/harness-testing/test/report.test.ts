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

/* ---- spend: 一次运行的账 ---- */
import { sumSpend } from "../src/report.js";

const cacheLine = (ts: string, msg: string) => `[${ts}] ${msg}`;

it("spend: 从两份 Midscene 日志里按窗口读出调用数、毫秒、token 与缓存三态", () => {
  const stats = [
    line("2026-08-19T09:00:00.000+08:00", 9999), // 上一次运行，不算
    line("2026-08-19T12:30:11.646+08:00", 2707),
    line("2026-08-19T12:30:58.477+08:00", 2677),
  ].join("\n");
  const cache = [
    cacheLine("2026-08-19T09:00:01.000+08:00", "cache hit, type: plan, prompt: x"), // 上一次
    cacheLine("2026-08-19T12:30:05.000+08:00", "no cache file found, path: /x.cache.yaml"),
    cacheLine("2026-08-19T12:30:06.000+08:00", "no unused cache found, type: plan, prompt: click"),
    cacheLine("2026-08-19T12:30:40.000+08:00", "cache hit, type: locate, prompt: the button"),
    cacheLine("2026-08-19T12:30:41.000+08:00", "cache hit, type: plan, prompt: click"),
    cacheLine("2026-08-19T12:30:50.000+08:00", "rectMatchesCacheFeature error: Error: No matching element rect found for the provided cache feature"),
  ].join("\n");
  const s = sumSpend(stats, cache, T0);
  expect(s.modelCalls).toBe(2);
  expect(s.tokens).toBe(2707 + 2677);
  expect(s.modelMs).toBe(44569 * 2);
  expect(s.cacheHits).toBe(2);
  expect(s.cacheMisses).toBe(1);
  expect(s.cacheStale).toBe(1);
});

it("spend: untilMs 把后一次运行挡在窗口外——多并发时这是唯一能分账的办法", () => {
  const stats = [line("2026-08-19T12:30:11.646+08:00", 100), line("2026-08-19T13:30:11.646+08:00", 100)].join("\n");
  const until = Date.parse("2026-08-19T13:00:00.000+08:00");
  expect(sumSpend(stats, "", T0, until).modelCalls).toBe(1);
  expect(sumSpend(stats, "", T0).modelCalls).toBe(2);
});

it("spend: 什么都没读到就是全零，不是 undefined——账本的零是真的零", () => {
  expect(sumSpend("", "", T0)).toEqual({ modelCalls: 0, modelMs: 0, tokens: 0, cacheHits: 0, cacheMisses: 0, cacheStale: 0 });
});
