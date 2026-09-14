#!/usr/bin/env node
/**
 * 记忆的形状与写过滤。挂在写 `agent_state/memory/user/testpilot-episodes.md` 那一次调用之前。
 *
 * 借 commerce-agents 的 `MemoryWriteFilter`：一条记忆是 preference / 规则，永远不是账号、卡号、
 * 邮箱、token。我们这里是 episodic——一行一条「这次踩了什么坑」，形状是
 * `- [<runTag>] <category>/<key>: <value>`（`packages/testpilot-mcp/src/memory.ts`），
 * 而会话 cookie、网关 key、Penguin 的 claim 链接都可能被模型顺手写进来。
 *
 * 规则 import 的是 MCP 包里的同一份（`validateEpisode` / `parseEpisodeLine`）：
 * `extract_episodes` 生成候选用的是它，这里校验用的也是它。
 */
import path from "node:path";
import { input, abstain, deny, writeFileArgs, answer, loadRepo } from "./lib/tp.mjs";

const FILE = /[/\\]agent_state[/\\]memory(?:[/\\]user)?[/\\]testpilot-episodes\.md$/;

try {
  const msg = await input();
  const args = writeFileArgs(msg);
  if (!args) abstain();
  if (!FILE.test(args.file_path)) abstain();

  const { memory } = await loadRepo();
  const bad = [];
  let count = 0;
  for (const [i, raw] of args.content.split("\n").entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("<!--") || line.startsWith("-->")) continue;
    const parsed = memory.parseEpisodeLine(line);
    if (!parsed) {
      bad.push(`第 ${i + 1} 行不是「- [runTag] category/key: value」的形状：${line.slice(0, 80)}`);
      continue;
    }
    try {
      memory.validateEpisode(parsed);
      count += 1;
    } catch (e) {
      bad.push(`第 ${i + 1} 行被写过滤拒绝（${e.message}）：${parsed.key}`);
    }
  }
  if (bad.length) {
    deny(null, "validate-memory", "schema",
      `testpilot-episodes.md 有 ${bad.length} 行不合规矩：${bad.slice(0, 5).join("；")}${bad.length > 5 ? "；…" : ""}。` +
        `每行一条：- [8位runTag] gate|hold|scan|infra|material/key: value（value ≤ 200 字，不含凭证、邮箱、长串）。` +
        `用 extract_episodes 生成候选再挑，不要自己编 runTag。`,
      { file: "testpilot-episodes.md", valid: false, bad: bad.length });
  }
  answer({
    output: { file: "testpilot-episodes.md", valid: true, episodes: count },
    reason: `testpilot-episodes.md 通过：${count} 条记忆，形状与写过滤都过`,
  });
} catch (err) {
  process.stderr.write(`validate-memory 自身出错：${err?.stack ?? err}`);
  process.exit(1);
}
