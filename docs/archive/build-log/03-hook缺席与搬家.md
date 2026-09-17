# hook 缺席与搬家 · The missing hook, and moving house

> 2026-09-03 → 2026-09-07 · 出处：`docs/v3/history/00-架构.md §12`「Phase 3 的阻塞」「阻塞已解」；`docs/v3/history/07` T-05～T-09；证据 `docs/v3/evidence/t08-probe-holds.jsonl`

## 中文

**缺席。** 这套 harness 的门禁（schema / 出处 / gate1 / 不可逆动作）全写成 hook：确定性、随 Agent State 走、模型改不了。2026-09-03 C 臂在 PenguinHarness 0.2.9 上真跑了一次（2 故事 / 12 用例 / gate 1.000），trace 里 hook 事件 **0 条**。`pre_tool_use` / `stop` 在发布包里 grep 为 0，上游最新 tag 仍是 v0.2.9，hook 只在 main 的 `changelog/unreleased/`。也就是说校验与门禁一次都没在运行中执行，只靠 SKILL.md 的一句话。在这个状态下做 A vs C 配对评测，比的是「工具内门禁 vs 无门禁」，数字会好看而且是假的。

**搬家。** 三个选项（从 main 构建本地 penguin / 等 0.2.10 / 先做 A 臂内部配对）之外选了第四个：不迁出 Penguin，做**多运行时**。四天里落的东西：

| 件 | 在哪 | 一句话 |
|---|---|---|
| 第二个接缝 | `server/src/claudecode.ts` | 与 `penguin.ts` 同形的四个函数（`startRun / watchRun / readRun / writeDecisions`），`runtimes.ts` 按 `RunMeta.runtime` 分发 |
| 载荷适配器 | `plugins/testpilot/hooks/adapters/claude-code.mjs` | 六个 hook 一行不动；把 Claude Code 的 PreToolUse / Stop 翻成 Penguin 的形状（transcript → trace，`cwd` → workspace）；6 条子进程测试 |
| plugin 打包 | `scripts/build-claude-plugin.mjs` | 从 `plugins/testpilot/` 生成 Claude Code 形态（skills 逐字复制、hooks.json、.mcp.json），`--check` 进 `check:drift` |
| Codex 的门 | `packages/testpilot-mcp/src/write.ts` | Codex 没有 hook，门禁挪进 `write_stories` / `write_cases` 工具，与 hook 共用同一份 `casegen/validate.ts` |

**实证（T-08）。** 一次故意缺 `sourceRefs` 的 Write 被 PreToolUse 拦下，`holds.jsonl` 多一条 `gate=grounding`（标 synthetic，不进统计）；Stop hook 把一个坚持「只写一次不重试」的会话拽了三轮，那是 `require-gate` 的封顶在起作用。一次真 g1 在 Claude Code 上 1 分 48 秒跑完，`meta.runtime: "claude-code"`、binding 齐。

**预判对错。** 预判「hook 搬到 Claude Code 后，C 臂的 trace 里自然会出现 hook 事件」——**只对一半**。Claude Code 的 g1 是 `run_pipeline` 一步完成的，工具自己写盘，hook 在这条路上一次都不会触发；「trace 里有 hook 事件」得靠探针。预判「Codex 臂能跑」——错：这台机器的 Codex 登录的是 ChatGPT 账号，可用模型为零（T-09 blocked）。

**它为什么值得记。** 「门禁在代码里」这句话有一个隐藏前提：那个运行时得肯执行你的代码。运行时换了三个，门禁的实现只写了一份——这是资产和 harness 分开的第一次实证。

## English

**Absence.** Every gate in this harness (schema, provenance, gate1, irreversible actions) is a hook: deterministic, versioned with the Agent State, out of the model's reach. On 2026-09-03 arm C ran for real on PenguinHarness 0.2.9 (2 stories / 12 cases / gate 1.000) and the trace held **zero** hook events. `pre_tool_use` / `stop` grep to 0 in the published package; the newest upstream tag is still v0.2.9; hooks exist only in `changelog/unreleased/` on main. The gates had never executed; only a sentence in SKILL.md stood in for them. A paired A-vs-C eval in that state compares "in-tool gate vs no gate": the numbers would look good and be false.

**Moving.** Beyond the three options (build penguin from main / wait for 0.2.10 / pair inside arm A first) I took a fourth: stay on Penguin and add **runtimes**. Four days produced a second seam with the same four functions (`server/src/claudecode.ts`, dispatched by `runtimes.ts`), a payload adapter that leaves all six hooks untouched and translates Claude Code's PreToolUse / Stop into Penguin's shape (transcript → trace, `cwd` → workspace; six subprocess tests), a plugin builder whose `--check` is wired into `check:drift`, and, for Codex which has no hooks, the gate moved into `write_stories` / `write_cases` MCP tools sharing one `casegen/validate.ts` with the hooks.

**Evidence (T-08).** A deliberately provenance-less Write was blocked by PreToolUse and recorded in `holds.jsonl` (`gate=grounding`, marked synthetic); the Stop hook dragged a "write once, never retry" session through three rounds, which is `require-gate`'s cap working. A real g1 finished on Claude Code in 1:48 with `meta.runtime: "claude-code"` and a complete binding.

**Prediction vs outcome.** "Once hooks run on Claude Code, arm C's trace will naturally contain hook events": half right. The Claude Code g1 completes in one `run_pipeline` call and the tool writes the files itself, so no hook fires on that path; the evidence has to come from a probe. "The Codex arm will run": wrong. This machine's Codex is signed in with a ChatGPT account and has zero usable models (T-09 blocked).

**Why it is worth recording.** "Gates live in code" carries a hidden premise: the runtime has to be willing to execute your code. Three runtimes, one implementation of the gates. That is the first evidence that the assets and the harness are separable.

## 2026-09-08 补记：三运行时的表终于有了两列

同一份 skill（2026-09-03.1）+ gold（casegen，16 条）+ MCP + 材料 + 模型（`qwen3.8-flash`@dashscope），Penguin 与 Claude Code 各 n=3，`limit 3`（`evals/runtime-compare.json`）：

| 运行时 | gate | coverage | tokens（MCP 内） | 墙钟 |
|---|---|---|---|---|
| Penguin 0.2.9（无 hook） | 1.00 / 0.94 / 0.86 | 0 / 0.17 / 0 | 44–48k | 161s / 456s / 927s |
| Claude Code（hook 执行） | 1.00 / 1.00 / 0.94 | 0.08 / 0.17 / 0 | 39–53k | 162s / 207s / 207s |

三对 McNemar p 全 1.0，翻转 1 / 5 / 1 条。**预判对错**：「覆盖率差不到一个条目」对；「Claude Code 臂 sourceRefs 更齐」判不了（13/16/8 vs 7/17/6，重叠）——而且 g1 走 `run_pipeline` 一步写盘，hook 在这条路上根本不触发，所以「hook 拦出来的差」没有机会出现；「Claude Code 臂更慢」错，慢的是 Penguin 自己的 agent 回合（第 3 次 927 秒里 MCP 只调了 4 次模型）。

**出乎意料的**：Penguin 上跑出来的分缺 `runtime`——MCP 的 `TP_RUNTIME` 从没进过 Penguin 的 mcpServers env，第一遍三条按「缺 binding 拒收」重跑；`bindingDrift` 也不认 runtime，paired 的 note 把两个运行时说成「同一 binding 的抖动」。这两处都是「表里没有这一列，就没人发现这一列一直是空的」。

**English.** Same skill + gold + MCP + materials + model, n=3 per runtime: all three McNemar pairs give p = 1.0 (1 / 5 / 1 flips). Prediction "coverage within one item" held; "Claude Code arm has more complete sourceRefs" is undecidable (13/16/8 vs 7/17/6) and structurally could not show, because g1 writes in one `run_pipeline` call and no hook fires there; "Claude Code arm is slower" was wrong, the slow arm is Penguin's own agent turns (927s with only 4 model calls inside MCP). Surprise: Penguin-side scores had no `runtime` in their binding because `TP_RUNTIME` never reached Penguin's MCP env, and `bindingDrift` did not treat runtime as a binding field. A column nobody prints is a column nobody notices is empty.
