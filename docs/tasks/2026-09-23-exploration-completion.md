# 任务 3：探索完成依据与报告可观测性

我先发现两处会让证据失真的接缝：旧报告把 `attempted`、`skipped_equivalent` 当终态，而且未知停止原因可能得到 complete；失败挽救按项目固定文件名读取，也没有核对本轮身份。继续核对发现 `interactiveSession` 还会给执行 ID 加时间后缀，旧读路径与实际写路径并不保证相同。

本任务分支为 `codex/03-exploration-completion`，从任务 2 的 `9a1a7f2953a839a2dcf71e4c61271155abcaf125` 创建；`git merge-base --is-ancestor` 已核对。只做任务 3，本地提交，不推送、不建 PR、不合并，也未启动任务 4。

## 我改了什么

- `domain/explorationEvidence.ts` 定义尝试身份和完成评价，`domain/report.ts` / `tracker.ts` 使用评价重算 terminal、frontier 和计数。完成分母仅为 charter 声明目标；无 charter 时分母为 null，空目标和缺证据为 unknown。
- 看见目标必须有实际状态和归一化后的控件快照匹配。尝试必须关联同动作、同起始状态且实际走过的图转移；交互完成还要求成功转移指向存在的后态。只读目标由其所在状态的可见控件证据满足，不强迫点击。
- 引用检查覆盖观察、状态、转移及目标。只有失败、等价跳过、缺后态、坏引用、阻塞，以及 Offline / 未知停止原因都不能完成。只有已声明目标有证据且停止为 dry / exhausted 才可能完成；实际屏数或轮数已达预算仍保持 partial。
- 业务断言通过独立显示“未采集”，不把 `graph.ok`、可见变化或点击成功算作业务验收。历史 `transitionsAsserted` 字段保持兼容，只表示记录到变化的转移。
- 进展复用采集器的状态抽象与稳定状态 ID，提供去重抽象状态、实际成功转移及重复结果动作（包含重复失败）。控件数字归一化复用已有抽象；低新颖度不用于断言全产品完成。原有限轮数和时间预算保持有效。
- 每次探索有随机 attemptId、runId、projectId、entryUrl、scopeHash、startedAt。工作流在派发前保存 `exploration/attempt`，经 index / RPC 传到采集器并原样回传。半成品写到本次 UUID 对应路径；挽救核对全部身份字段、URL、采集时间、非空材料和正屏数。损坏、无标识 legacy、旧 run、不同目标、不同尝试均不接纳，历史文件不改写。
- `server/explorationResults.ts` 在服务端重算评价，不能直接落下游自报 complete。无结构化证据的半成品保存 unknown 摘要，不编空图；产品模型候选仅使用有图回执支持的 attempted 观察。
- 现有 `ArtifactDocument` / `RevisionViewer` 展示范围、分母、停止原因、完成和缺口依据、断言未采集、进展及未访问入口。逐目标展开可读观察和引用，`ExplorationGraph` 显示同源 `sfg:edge:N` / 状态 ID。旧报告缺 assessment 显示未采集/未知，原始回执留在明确标记的折叠区。新增文案三语齐全。

## 验证记录

所有数字来自本 worktree 的实际命令输出，未用测试网业务结果代替合成验证。

| 命令 / 范围 | 结果 |
|---|---|
| `pnpm test` 最终全仓回归 | 185 个 Vitest 文件通过，1612 项通过，1 项既有历史图缺失条件跳过；MCP 另有 4 项 Node 测试通过 |
| harness 定向 `exploration-completion` + `domain-report-model` | 53 通过、1 既有跳过；新增完成评价反例 31 项 |
| server `exploration-source` | 6 通过：真实 source 续跑/账本落档、正常回执身份、部分失败、跨尝试/目标/无身份拒绝；浏览器边界和后续规划用测试替身 |
| server `exploration-partial` | 19 通过：本次读取、六个来源字段、损坏/空/旧时间/旧文件、首次失败与 checkpoint |
| `vitest --config vitest.reading.config.ts` | 23 项 SSR 通过，其中 5 项覆盖服务端评价→报告→UI、三语、伪完成重算、旧报告及无 charter 边界 |
| `pnpm --filter testpilot-server exec tsx scripts/test-local-exploration.ts` | 真实本地 Chrome 3 个合成场景：入口 1 屏；采到 1 屏后故障可挽救；首屏前失败无挽救；本地模型端点请求 0 次 |
| `pnpm typecheck` / `pnpm build` | 通过；i18n 2476 个词条引用命中 |
| `pnpm test:hooks` | 26 通过 |
| `node --test scripts/test/*.test.mjs` | 7 通过 |
| drift / domain-neutral | 通过；没有修改 skill 或提示词版本 |
| host parity（使用 server 的 tsx） | 188/192，97.9%；待做 4、UI 专属 12，与原边界相同 |
| `node scripts/replay.mjs` | 1 次冻结运行逐位相同 |
| `git diff --check` | 通过 |

首次全仓回归的唯一失败是隔离测试对 `server/.env` 执行 realpath，而新 worktree 不存在该文件。我建立不含凭证的本地忽略占位文件后复验该 5 项测试全部通过，之后全仓回归通过；没有为此修改产品代码或读取原工作区凭证。回归结束后的“缺失结构化目标证据必须显示未采集而非未找到”收口，另跑上述定向、SSR 和 typecheck 通过。

`node scripts/cost-report.mjs` 因本 worktree 没有真实执行账库而退出 2。这一任务没有跑业务用例，不从单测库生成假成本报告。SSR 出现既有 Tailwind content 配置提醒，构建通过。

## 边界

- 我没有声称未知全站覆盖，也没有引入熵、泊松或新颖度硬门禁。
- 本地浏览器场景只是采集器与失败挽救的合成验证，不是 Hyperliquid 测试网业务验收。
- 挽救保留已有文字材料与来源，不是断点续跑；缺失状态图、交互回执与断言仍显示 unknown / 未采集。
- 观察到的动作结果与产品业务断言是不同证据。报告不提供未经执行的业务通过计数。
