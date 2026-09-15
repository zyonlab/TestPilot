/**
 * 多运行时的分发（07 P2）。`penguinRun.ts` 的接线只认这四个函数，不认识哪个后端。
 * 新增一个运行时 = 照 `penguin.ts` 的形状再写一份，在这里登记一行。
 */
import * as penguin from "./penguin.js";
import * as codex from "./codex.js";
import * as claudecode from "./claudecode.js";
import type { HostRuntime } from "@testpilot/harness-core/model-profiles";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

/** Repository adapter support, not a claim about the currently installed host version. */
export const runtimeModelCapabilities: Record<HostRuntime, {
  adapterImplemented: boolean;
  managedPlannerConfig: boolean;
  generationEntry: "skill-stages" | "unimplemented";
}> = {
  penguin: { adapterImplemented: true, managedPlannerConfig: true, generationEntry: "skill-stages" },
  "claude-code": { adapterImplemented: true, managedPlannerConfig: false, generationEntry: "skill-stages" },
  codex: { adapterImplemented: true, managedPlannerConfig: false, generationEntry: "skill-stages" },
};

export type RuntimeName = HostRuntime;

export interface Runtime {
  name: RuntimeName;
  startRun: typeof penguin.startRun;
  watchRun: typeof penguin.watchRun;
  readRun: typeof penguin.readRun;
  writeDecisions: typeof penguin.writeDecisions;
}

const RUNTIMES: Record<RuntimeName, Runtime> = {
  codex: { name: "codex", startRun: codex.startRun, watchRun: codex.watchRun, readRun: codex.readRun, writeDecisions: codex.writeDecisions },
  penguin: { name: "penguin", startRun: penguin.startRun, watchRun: penguin.watchRun, readRun: penguin.readRun, writeDecisions: penguin.writeDecisions },
  "claude-code": { name: "claude-code", startRun: claudecode.startRun, watchRun: claudecode.watchRun, readRun: claudecode.readRun, writeDecisions: claudecode.writeDecisions },
};

export const isRuntimeName = (v: unknown): v is RuntimeName => v === "penguin" || v === "claude-code" || v === "codex";

/** 不认识的名字直接报错，不悄悄退回 Penguin——退回的那次运行会被记成另一个运行时的分数。 */
export function getRuntime(name: unknown): Runtime {
  if (name === undefined || name === null || name === "") return RUNTIMES[defaultRuntimeName()];
  if (!isRuntimeName(name)) throw new Error(`未知的运行时：${String(name)}（可用：${Object.keys(RUNTIMES).join(" / ")}）`);
  return RUNTIMES[name];
}

/**
 * 默认运行时：`TP_AGENT_RUNTIME`（不与老的 `TP_RUNTIME=graph|penguin` 开关混用）。
 *
 * 不设时是 Claude Code（2026-09-16 初步交付的决定）：公开用户不必为了 Web 发起生成去装
 * Node 24 和 Penguin；Penguin 仍可显式选，属于实验性。
 */
export const defaultRuntimeName = (): RuntimeName => (isRuntimeName(process.env.TP_AGENT_RUNTIME) ? process.env.TP_AGENT_RUNTIME : "claude-code");

const availability = new Map<string, boolean>();
/**
 * Web 发起时这个规划运行时在本机起不起得来。只查可执行文件在不在、能不能回版本号，
 * 不查登录态——没登录的 Claude Code 会在运行里报错，那条错会原样落到 source 之后的节点上。
 * 创建运行时就拒掉起不来的，比探索跑完几分钟之后才失败强。
 */
export function plannerRuntimeAvailable(name: RuntimeName): boolean {
  const bin = name === "claude-code" ? claudecode.claudeBin() : name;
  const key = `${name}:${bin}`;
  const cached = availability.get(key);
  if (cached !== undefined) return cached;
  let ok = false;
  try {
    if (name === "claude-code") ok = spawnSync(bin, ["--version"], { timeout: 15_000, stdio: "ignore" }).status === 0;
    else if (name === "penguin") ok = existsSync(penguin.penguinBin());
  } catch { ok = false; }
  availability.set(key, ok);
  return ok;
}
