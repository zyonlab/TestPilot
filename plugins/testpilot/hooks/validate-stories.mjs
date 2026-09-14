#!/usr/bin/env node
/**
 * 门禁之前的那道门：`stories.json` 的形状。
 *
 * 挂在 `pre_tool_use` 上，拦 `write_file`。**校验的是"将要写的内容"，不是已经写好的文件**——
 * PenguinHarness 没有 tool 之后的 hook 点（见 `docs/v3/03-penguin-hooks-契约.md` §1），
 * 所以只能提前一步。好处反而是坏产物根本落不了盘。
 *
 * 不过 → `deny`，zod 的报错原样注回给模型。**不是静默**：静默的校验等于没有校验，
 * 模型会带着一份结构不对的 stories.json 一路往下写用例，
 * 直到某个下游节点报一句看不懂的错。
 */
import path from "node:path";
import { input, answer, abstain, deny, loadRepo, writeFileArgs, zodBrief } from "./lib/tp.mjs";

const NAME = "stories.json";

try {
  const msg = await input();
  const args = writeFileArgs(msg);
  if (!args) abstain();
  // 只管 runs/<id>/stories.json。别的地方叫这个名字的文件不是我们的事。
  if (!/[/\\]runs[/\\][^/\\]+[/\\]stories\.json$/.test(args.file_path)) abstain();

  const runDir = path.dirname(args.file_path);
  // 判决来自共享的 validate.ts（和 MCP 的 write_stories 同一份）；这里只负责把它说成 deny / 记录。
  const { validate } = await loadRepo();
  const v = validate.validateStories(args.content);
  if (!v.ok) deny(runDir, "validate-stories", v.gate, v.reason, v.output);
  // 通过：不给 decision（弃权），只留一条记录。
  // 给 `allow` 会绕过宿主的审批回调——那是安全边界，校验 hook 没有资格替它做主。
  answer({ output: v.output, reason: v.reason });
} catch (err) {
  // 崩溃 = 弃权 = 静默放行（契约 §2）。所以自己把话说清楚：非 0 退出，让 stderr 进 hook 事件。
  process.stderr.write(`validate-stories 自身出错：${err?.stack ?? err}`);
  process.exit(1);
}
