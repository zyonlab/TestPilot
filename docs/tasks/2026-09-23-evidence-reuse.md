# 任务 4：探索知识复用与执行验证

## 我先遇到的问题

原实现已经有探索定位表，以及 preparationExperience 的 TTL、候选验证、撤销与不可变上下文。我没有新增经验数据库。本次收紧的是旧定位表按文案 last-wins、缺采集身份、只校验文本与元素个数的路径。任务 2 已有点击开始后抛错不回模型的保护，我保留它并补充回归；定位动作异常还会禁止正式执行层重试，包括显式只读生命周期。

开发中的反例先后抓到了三个接缝：实际执行切换同 URL 环境时不能用运行原始环境授权；next 后密钥变化不能让冻结提示自我比较通过；生成材料不能仅凭文件名挂到最新观察上。测试夹具初版用页面初始化前的变异脚本隐藏按钮，实际未变异；改为本地页面直接渲染变化后的 DOM。隐藏唯一按钮又使页面全空，被既有 readiness 在动作前拒绝；补充固定 Ready 标题后真正抵达定位检查。首次全仓回归加载了修改前的夹具，因此该反例失败，修正后补定向与全仓回归。生产校验没有为测试放宽。

分支 `codex/04-evidence-reuse` 从 `1c3b7a2b0e390eae40d66b1988ef352c2f33658e` 创建。只提交本任务，不 push、不合并、不启动任务 5。

## 数据与执行契约

- source 派发前冻结 `ExplorationAttempt.environmentHash / pageVersion / inputFingerprint`，沿已有 RPC 到采集器并原样回传。环境指纹覆盖实际配置、凭据、headers/query/session/viewport 等；注入钱包的私有身份没有足够冻结契约时为 null。`pageVersion` 是用户声明的被测构建版本，Web 新建运行有可选输入；它不是自动识别出来的产品版本。
- 此时尚无 materialsHash，输入指纹使用已冻结的 source manifest、charter、运行参数、环境和页面版本。已有上传材料的字节摘要进入 manifest。source 生成 `exploration.md` 时就将精确文本与 observation 的引用写入 material revision，后续 freeze 校验字节并封存该 revision；不依赖未来材料哈希，也不把当前环境贴到旧观察上。
- `selectExplorationContext` 沿本运行已封存 material → observation → attempt → manifest 读取；report 必须引用同一 observation，写入者必须是 collector 系统身份。缺失/损坏可选证据只拒绝复用，项目或运行本身不存在仍抛主流程错误。跨项目/run、材料、入口、环境、页面版本、held-out 均不能授权定位复用。
- 只从 charter 明确 none/ui-only 的 activate 目标选点击方法：真实 attempted 观察、可见且 enabled 的目标、同动作与起点的 walked/ok 图边、存在的后态，以及动作前真实 DOM 定位证据缺一不可。失败、blocked、仅模型声明、旧记录、过期或未来时间拒绝。TTL 为 7 天；标签含数字的定位不选，以避免将动态读数当身份。
- 每个选中方法保留 report revision、observation、edge、state、attempt、采集时间、精确 URL、区域/角色、控件与可见结构摘要。没有保存输入值或页面正文；余额、持仓等动态事实不成为复用数据。最多 12 条提示、提示序列化总量 14 KB；最多 40 条拒绝说明，原完整证据仍在已有修订中。
- 同标签不再 last-wins 合并。候选有歧义就回模型。执行前校验实际派发项目/run/材料/环境/入口/登录模式、TTL、当前 URL、唯一元素、可见/未 disabled/未遮挡、文案、区域、角色与当前结构摘要；最后确认仍是刚校验的 DOM 节点。选择器是候选方法，不是当前业务状态证明；原 oracle、前置与生命周期仍独立执行。
- 动作前失效可回模型。click 已尝试后任何异常都记录 action-error、向原错误路径返回且禁止自动重复；不会因尝试已抛异常再交模型点第二次。现有清理和原业务归因保持。

## 准备、正式执行和 UI

准备上下文沿原 experienceContext revision 冻结精确内容、digest 和 sourceRefs；`next` 可见，每次 probe/trial 从其 plan 指向的不可变上下文读取并实际经 RPC 派发。即便 next 后环境/密钥变化，冻结内容不改；实际派发的独立 `locatorRuntimeScope` 使其失效。正式执行按实际 `input.envRef` 解析后的环境快照分发，不用运行原始 envRef 为另一环境背书。

RunResult 新增可选 `evidenceReuse`，包含实际分发上下文与 used/fallback/action-error 事件；继续保存在已有准备/执行回执里。UI 接入准备上下文、准备回执、在线与离线执行详情，显示选中、实际使用、拒绝/回退原因、摘要和来源。只有真实 events 数组才能显示使用次数；尚未执行、旧产物或畸形记录显示未知。中文/英文/日文齐全，不用零模型请求推断命中。React 工作使用 vercel-react-best-practices。

## 验证

所有数字来自本 worktree 实际命令输出，未以模拟模型结果冒充产品验收。

| 检查 | 结果 |
|---|---|
| `pnpm test` 最终回归 | 188 个 Vitest 文件；1661 项通过，1 项既有历史图缺失条件跳过；MCP Node 测试另 4 项通过 |
| harness 定向 locators / locator-evidence / locator-run | 41 项通过 |
| server 真实 evidence-reuse-flow | 13 项通过，含新采集完整链路、DOM 反例、真实环境切换/密钥旋转和材料篡改 |
| workflow-execution 定向 | 16 项通过，含旧快照无 context 回退且不恢复裸 hints |
| reading SSR 配置 | 4 个文件、26 项通过，含三语已选/未知/真实使用/畸形回执 |
| `pnpm typecheck` / `pnpm build` | 通过；2519 个三语词条引用均有效 |
| `check:domain-neutral` / `check:drift` | 通过；两个宿主副本与 skill 真源一致，无 skill 改动 |
| `pnpm --filter testpilot-server exec tsx ../scripts/check-host-parity.mjs` | 188/192，4 个既有 todo，12 条 UI 专属；不为根 PATH 改依赖 |
| `pnpm test:hooks` / `node --test scripts/test/*.test.mjs` | 26 / 7 项通过 |
| `node scripts/replay.mjs` | 1 个冻结运行分数与 expected 逐位相同 |
| `git diff --check` | 通过 |

最终全仓日志 `/tmp/tp04-full-final.log`；类型/构建日志 `/tmp/tp04-types-verified.log`、`/tmp/tp04-build-verified.log`；UI `/tmp/tp04-ui-verified.log`。SSR 保留既有 Tailwind content 警告，不影响断言，生产构建通过。首次失败全仓仅为前述变异夹具未生效；最终再次全仓通过，未继续重复扩测。

本地服务端测试 `server/test/evidence-reuse-flow.test.ts` 使用真实 SQLite 修订链、真实 Chrome、runner 子进程与 RPC，执行 source dispatch → runObserve → 生成材料封存 → next → probe → trial → prepared bundle → 正式 execute。它没有手工构造“完美 hint”。人工批准由测试的明确 human fixture 调用，未降低生产门禁。

同一合成页面、同一屏幕 oracle 的对照：启用提示 passed、实际 used=1、role-proxy forwarded=0；禁用提示 passed、实际向本地 HTTP 模型模拟器 forwarded=1。模拟器返回预定点击坐标，不是视觉模型推理；这些数字验证派发与调用统计，不能用来估计真实 VL 性能或承诺 50% 提升。

反例包括失败/阻塞/无图/仅声明/缺后态、过期/未来时间、缺身份、跨项目/run/material/env/route/pageVersion、同标签歧义、实际隐藏/disabled/改文案/重复元素、目标替换、点击生效后异常只调用一次、实际切换同 URL 环境、next 后密钥旋转仍保留精确上下文、held-out、null/损坏报告/缺 manifest/sourceRefs，以及材料字节被改后禁止伪挂来源。动态 UI 证据只作当前动作验证，不缓存成业务事实。

任务 2 的 `server/scripts/verify-case-lifecycle.ts` 原先以裸选择器省去模型调用；新生产契约拒绝这类未追溯提示。本任务更新脚本为真实 Midscene/RPC + 本地 HTTP 模拟模型驱动 Create/Delete，保留成功清理、业务失败但清理成功、归属不符不清理三个原场景。实际重跑三项通过：请求数分别 2、2、1，共 5 次，归属不符仍为业务 passed、总体 failed、1 个 pending。证据目录 `/var/folders/6v/n907vgj107g_rg7d_6hmb7fw0000gn/T/tp-lifecycle-runner-ZNJpBE/` 留有 results.json 与截图；命令日志 `/tmp/tp04-lifecycle.log`。没有伪造采集身份，也没有恢复不安全兼容。

## 支持边界

本次验证对象是本地合成 UI，不是测试网业务验收。注入钱包身份未冻结时明确 unknown，仍走现有模型；没有证明 Hyperliquid 带钱包提示复用有效。主网 denylist、testnet-only、UI-only、人工门禁未改，未读写 Gold、held-out 或人工标签。

缺显式页面版本、没有声明低影响目标/有效图证据的通用探索、旧报告、跨 run、显式未登录模式、变化的环境或 DOM 都保守回退。这会降低命中率，但不会把未知状态升级为成功证据。声明版本仍需使用方真实维护；当前 DOM 校验不能证明整个页面业务状态完全相同，也不是对所有动态页面的正确性证明。

共享可变 fixture 的准备与恢复仍不支持，任务 2 边界不变。本次未改用例 oracle、Gold/held-out 或人工标签，也未给缓存增加修改业务规则的能力。

本任务完成时所有受控改动均进入独立本地提交，工作树 clean；SHA 由最终交接消息提供。母任务可从该提交继续任务 5，本任务不自行启动。
