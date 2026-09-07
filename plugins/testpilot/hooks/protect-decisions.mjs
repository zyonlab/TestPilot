#!/usr/bin/env node
/**
 * 决定只能是人写的。
 *
 * `runs/<runId>/decisions.json` 是审计台写回的复核决定，下一个 session 的 `read_decisions`
 * 读它决定哪些用例进 g2。它唯一合法的写入口是 server 的决定路由。一个 agent 用 `write_file`
 * 或 `edit_file` 去碰它，无论内容多合理，都是在给自己的用例盖「已批准」的章——
 * 借 commerce-agents 的规矩：预览卡片批不了任何东西，聊天里打的「同意」什么也不设；
 * 批准的标记只能来自宿主代码。
 *
 * 同一道门也护着 `holds.jsonl`（门禁记录）与 `gate.json`（门禁报告）：
 * 它们是**关于**这次运行的记录，由 hook 写，不由被记录的那一方写。
 */
import path from "node:path";
import { input, abstain, deny, writeFileArgs } from "./lib/tp.mjs";

const PROTECTED = /[/\\]runs[/\\][^/\\]+[/\\](decisions\.json|holds\.jsonl|gate\.json)$/;

try {
  const msg = await input();
  let file;
  if (msg.hook === "pre_tool_use" && msg.tool_name === "edit_file") {
    try {
      file = JSON.parse(msg.arguments ?? "{}")?.file_path;
    } catch {
      abstain();
    }
  } else {
    const args = writeFileArgs(msg);
    if (!args) abstain();
    file = args.file_path;
  }
  if (typeof file !== "string") abstain();
  const m = PROTECTED.exec(file);
  if (!m) abstain();
  const name = m[1];
  const who = name === "decisions.json" ? "审计台的决定路由" : "门禁 hook";
  deny(path.dirname(file), "protect-decisions", "workspace",
    `${name} 不由 agent 写：它是${name === "decisions.json" ? "人的复核决定" : "关于这次运行的门禁记录"}，只由${who}写入。` +
      `你要的结果（用例被批准 / 门禁通过）只能通过把用例写好来得到，不能通过写这个文件。`,
    { file: name });
} catch (err) {
  process.stderr.write(`protect-decisions 自身出错：${err?.stack ?? err}`);
  process.exit(1);
}
