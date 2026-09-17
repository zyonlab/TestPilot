import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionIdOf, isHookBlock, nodeEventsOf, writeMcpConfig, claudeArgs, runMessage } from "../src/claudecode.js";
import { getRuntime, isRuntimeName } from "../src/runtimes.js";

/** T-05：第二个接缝的纯函数部分——不起 claude 也能钉住的那些。 */
describe("claudecode 接缝", () => {
  it("session_id 只从 system/init 那一行取", () => {
    expect(sessionIdOf({ type: "system", subtype: "init", session_id: "abc" })).toBe("abc");
    expect(sessionIdOf({ type: "assistant", session_id: "abc" })).toBeUndefined();
  });

  it("hook 拦截 = 带 is_error 且像 hook 说的话的 tool_result", () => {
    const blocked = { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "PreToolUse hook blocked: cases.json 不符合 CaseBundleSchema" }] } };
    const ok = { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "written" }] } };
    expect(isHookBlock(blocked)).toBe(true);
    expect(isHookBlock(ok)).toBe(false);
  });

  it("MCP 工具调用翻成 NodeEvent：节点名去掉前缀", () => {
    const line = { type: "assistant", message: { content: [{ type: "tool_use", id: "x", name: "mcp__testpilot__run_pipeline", input: {} }, { type: "tool_use", id: "y", name: "Read", input: {} }] } };
    const ev = nodeEventsOf(line, "r1");
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ runId: "r1", node: "run_pipeline", phase: "start" });
  });

  it(".mcp.json 写在 workspace 下，带 TP_RUNS_DIR 与 TP_RUNTIME；内容没变第二次不写", () => {
    const ws = mkdtempSync(join(tmpdir(), "tp-cc-"));
    const a = writeMcpConfig(ws, { TP_PROJECT_ID: "p1" });
    expect(a.written).toBe(true);
    const cfg = JSON.parse(readFileSync(join(ws, ".mcp.json"), "utf8"));
    expect(cfg.mcpServers.testpilot.env.TP_RUNS_DIR).toBe(join(ws, "runs"));
    expect(cfg.mcpServers.testpilot.env.TP_RUNTIME).toBe("claude-code");
    expect(cfg.mcpServers.testpilot.env.TP_PROJECT_ID).toBe("p1");
    expect(existsSync(cfg.mcpServers.testpilot.args[0])).toBe(true);
    expect(writeMcpConfig(ws, { TP_PROJECT_ID: "p1" }).written).toBe(false);
  });

  it("claude 的参数：print + stream-json + verbose，MCP 只允许 testpilot 的", () => {
    const args = claudeArgs("go", "/ws", "/plug");
    expect(args.slice(0, 2)).toEqual(["-p", "go"]);
    expect(args).toContain("stream-json");
    expect(args).toContain("--verbose");
    expect(args).toContain("mcp__testpilot__*");
    expect(args[args.indexOf("--mcp-config") + 1]).toBe("/ws/.mcp.json");
    expect(args[args.indexOf("--plugin-dir") + 1]).toBe("/plug");
    expect(claudeArgs("go", "/ws")).not.toContain("--plugin-dir");
  });
});

describe("运行时分发", () => {
  it("不给就是默认运行时（不设 TP_AGENT_RUNTIME 时是 Claude Code）；不认识的名字报错而不是退回", () => {
    const saved = process.env.TP_AGENT_RUNTIME;
    delete process.env.TP_AGENT_RUNTIME;
    try { expect(getRuntime(undefined).name).toBe("claude-code"); } finally { if (saved !== undefined) process.env.TP_AGENT_RUNTIME = saved; }
    expect(getRuntime("claude-code").name).toBe("claude-code");
    expect(() => getRuntime("gemini")).toThrow(/未知的运行时/);
    expect(isRuntimeName("codex")).toBe(true);
  });
});

describe("runMessage（07 T-12）", () => {
  it("消融开关写进起跑那句话，否则两臂一模一样", () => {
    const m = runMessage({ materialsDir: "/m", outDir: "/o", limit: 3, ablate: ["domain-reference"], generationMode: "pipeline" });
    expect(m).toContain("`ablate` = [\"domain-reference\"]");
    expect(runMessage({ materialsDir: "/m", outDir: "/o" })).not.toContain("ablate");
  });

  it("消融开关写进 .mcp.json 的 env（TP_ABLATE），空串即清掉", () => {
    const ws = mkdtempSync(join(tmpdir(), "tp-ablate-"));
    writeMcpConfig(ws, { TP_ABLATE: "domain-reference" });
    expect(JSON.parse(readFileSync(join(ws, ".mcp.json"), "utf8")).mcpServers.testpilot.env.TP_ABLATE).toBe("domain-reference");
    writeMcpConfig(ws, { TP_ABLATE: "" });
    expect(JSON.parse(readFileSync(join(ws, ".mcp.json"), "utf8")).mcpServers.testpilot.env.TP_ABLATE).toBe("");
  });
});
