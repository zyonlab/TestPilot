#!/usr/bin/env node
/**
 * 宣布完成之前，产物必须齐。挂在 `stop` 点上（Claude Code 的 Stop hook 模式）。
 *
 * 这是**唯一可靠的"往回说话"通道**里的第二条：`continue` 的 `input` 直接成为下一个 Task 的
 * user 消息，模型一定读到。（第一条是 `pre_tool_use` 的 `deny` reason。`allow` 的 reason
 * 模型看不见——见 `docs/v3/03-penguin-hooks-契约.md` §3。）
 *
 * 两条自我约束，都是必要的：
 *
 * 1. **只在这次会话确实开过一次运行时才说话。** workspace 里没有 `runs/` 就弃权——
 *    否则任何一次闲聊都会被这个 hook 拽住不放。
 * 2. **注回次数封顶。** 模型不配合时（比如它认定自己做完了），`continue` 会和它来回拉扯，
 *    每一轮都要花钱。计数存在 hook 包自己的 `.state/<session_id>.json` 里
 *    （stop 点的 stdin 没有 scratchpad_dir，只有 session_id 和 trace_path）。
 *    到顶之后仍然记一条 `hook` 事件说"还缺什么"，但不再拦——**报告里要看得见这次没兜住**。
 */
import { existsSync, readdirSync, statSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { input, answer, abstain, workspaceOf } from "./lib/tp.mjs";

const MAX_NUDGES = 3;
const REQUIRED = ["stories.json", "cases.json", "gate.json", "meta.json"];

try {
  const msg = await input();
  if (msg.hook !== "stop") abstain();

  const ws = workspaceOf(msg.trace_path);
  if (!ws) abstain();
  const runsDir = path.join(ws, "runs");
  if (!existsSync(runsDir)) abstain(); // 这次会话没开过运行——不是我们的事

  const runs = readdirSync(runsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ id: e.name, dir: path.join(runsDir, e.name) }))
    .sort((a, b) => statSync(a.dir).mtimeMs - statSync(b.dir).mtimeMs);
  if (!runs.length) abstain();

  const run = runs[runs.length - 1];
  const missing = REQUIRED.filter((f) => !existsSync(path.join(run.dir, f)));

  // 审计产物**不进 runs/**（数据契约 §3：Scanner 的产物独立，可跨运行汇总）。
  const scanPath = path.join(ws, "scans", `${run.id}.json`);
  const scanMissing = !existsSync(scanPath);

  if (!missing.length && !scanMissing) {
    answer({
      decision: "stop",
      reason: `${run.id} 产物齐：${REQUIRED.join(" / ")} + scans/${run.id}.json`,
      output: { runId: run.id, complete: true },
    });
    process.exit(0);
  }

  // 计数
  const stateDir = new URL("./.state/", import.meta.url);
  mkdirSync(stateDir, { recursive: true });
  const stateFile = new URL(`${msg.session_id}.json`, stateDir);
  let n = 0;
  try {
    n = JSON.parse(readFileSync(stateFile, "utf8")).nudges ?? 0;
  } catch {
    n = 0;
  }

  const want = [
    ...missing.map((f) => `runs/${run.id}/${f}`),
    ...(scanMissing ? [`scans/${run.id}.json`] : []),
  ].join("、");

  if (n >= MAX_NUDGES) {
    // 兜不住了。记一条，让报告里看得见，但不再拦。
    answer({
      decision: "stop",
      reason: `${run.id} 仍缺 ${want}，已提醒 ${n} 次，不再拦截`,
      output: { runId: run.id, complete: false, missing: want, nudges: n, gaveUp: true },
    });
    process.exit(0);
  }

  writeFileSync(stateFile, JSON.stringify({ nudges: n + 1, runId: run.id }));
  answer({
    decision: "continue",
    input:
      `这次运行还不完整：缺 ${want}。\n` +
      `顺序是写死的：stories.json → cases.json → 等门禁 hook 放行 → meta.json → 审计写 scans/<runId>.json。` +
      (missing.includes("gate.json")
        ? `\ngate.json 是门禁 hook 写的，不是你写的——你去写 meta.json 的那一刻它就会生成。`
        : "") +
      `\n把缺的补齐再收尾，不要在这里给最终答复。`,
    reason: `${run.id} 缺 ${want}（第 ${n + 1} 次提醒）`,
    output: { runId: run.id, complete: false, missing: want, nudges: n + 1 },
  });
} catch (err) {
  process.stderr.write(`require-gate 自身出错：${err?.stack ?? err}`);
  process.exit(1);
}
