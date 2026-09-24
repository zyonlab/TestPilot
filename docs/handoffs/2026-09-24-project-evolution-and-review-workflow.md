# TestPilot 项目持续完善、宿主规划及审核工作流交接

> 本文覆盖本次连续改造，包含前期节点评测/知识库接入、项目级资产与任务、以及随后真实运行暴露的三次审核/状态修复。代码与本机运行状态分开记录。较早文档与本文冲突时，以本文的“最新审批规则”和实际源码为准。

## 1. 接手先看

- 仓库：`/Users/admin/Midscene/testpilot`。
- 当前分支：`codex/preserve-reviewed-stories-on-rerun`；文档编写前 HEAD：`e9b716c`。此分支包含之前顺序实施的功能和修复，不要只切回早期集成分支。
- 本地 main 和本地记录的 origin/main 均为 `18bf0b8`。本轮新增提交尚未合入 main；本次没有 fetch，不把该远端跟踪记录当作远端实时状态。
- Web：`http://localhost:5300`；服务端：`http://localhost:5301`。服务已重启加载最新审批沿用代码。
- 项目：`prj-mu96i5c2-1001`，Hyperliquid Testnet。
- 当前应跟进的运行：`run-a71572af-1d1a-494c-aea9-264230ba5c10`。
- [打开当前工作流](http://localhost:5300/#/?open=canvas&project=prj-mu96i5c2-1001&run=run-a71572af-1d1a-494c-aea9-264230ba5c10)。当前工作是用例设计，不是实际交易执行。
- **当前已在 gate 前按断点暂停，接手先读状态，不要先重启服务、清库或再创建重复运行。**

### 当前状态快照

采集时间：**2026-09-24 14:25:46（UTC+8）**。

- 运行状态：`paused`；`error` 为空。
- source / modules / instructions / stories / cases 均为 `done`。
- cases：**17/17 个设计单元完成**，pending 0、claimed 0、failed 0；完成时间 14:25:28。
- 用例汇总产物：`validated/cases`，版本 `rev-65094c0f-2be9-433d-9a04-84f756a261a7`。
- gate：`blocked`，消息 `Breakpoint: paused before execution`；controls.pausedAt 为 `gate`。这是计划断点，不是本次故事审批失败。
- 保留断点：gate / finalize / g2 / execution；尚未取得设计门禁结果或执行结果。
- 故事审核 pending=false，沿用来源 `run-6cdca041-556d-46fd-81e0-68a2fc3293a6`，沿用证明 `rev-5835a9b5-19a2-431d-ab98-dc94eedd54ed`。
- 项目资产版本 0、快照 0、任务 0、候选发现 7。

写文档过程中 cases 从进行中变为完成；本文最终状态以上述采集时刻为准。

这些数字来自实际 HTTP API。17 个用例设计单元对应故事，不等于最终只有 17 条用例。运行会继续变化，先重新读取 API 再决定下一步。

### 工作区未提交内容

本轮开始前就存在用户清理旧资料留下的删除项，本次未恢复、未混入功能提交：

- `benchmark/hyperliquid-testnet/` 下 README、catalog、domain-reference、gold.draft、materials/rules。
- `materials/hyperliquid-testnet-2026-09-20/` 下旧规则、探索、来源和构建资料。
- `evals/domain-perp.json`。
- `docs/reports/hyperliquid-case-review-2026-09-20.md`、`hyperliquid-source-verification-2026-09-20.md`。
- 另有既存未跟踪文件 `docs/reports/codex-web-explore-smoke-2026-09-24.md`，没有顺手提交。

不要执行 `git reset --hard`、`git restore .` 或直接 `git add -A`。当前示例来自源码内置库，不依赖恢复这些旧物料。涉及旧 fixture 的全仓测试可能因此失败，先确认依赖，不能为让测试绿而悄悄恢复用户删除的数据。

## 2. 用户目标与设计取舍

用户想要的是持续积累产品测试知识，而不是每次运行独立生成一堆互不关联的文件：

1. Explore 要理解交互组件及业务状态，探索弹窗、下拉、Tab，解释它们可能属于什么业务能力。
2. 故事覆盖完整生命周期：例如平仓、增加保证金需要非空持仓，撤单需要可撤销订单。空表不能被解释为没有该功能。
3. 准备/执行某个用例时发现其他业务能力，要回收到项目层规划，不能硬塞进当前用例或降低验收要求。
4. 项目保存版本化资产和增量任务，运行固定输入、执行有限工作并留下证据。
5. 用户可比较不同输入/实现版本下的产物，并记录人工质量判断。
6. 完全重跑有明确入口，不靠清空项目实现，也不隐式复用历史答案。
7. Web 使用本机已登录的 Codex / Claude Code 启动独立任务；不是复用本桌面聊天会话。

没有采用 Gemini 建议中的泊松步数风险门禁、用熵值自动认定探索饱和等数学包装。当前以可核验目标、状态转换、出处、输入身份、预算和人工语义判断为依据；不宣称定位幻觉率归零、提速 50% 或 RAG 相关度 90%。

## 3. 已实现的功能与入口

### 3.1 知识库、内置示例与宿主连接

- 新建测试运行中的领域知识、规则包改为固定版本下拉，带 **Hyperliquid Testnet 内置示例**。
- 聊着填/宿主可以创建新的知识版本；内置示例只读，修改后另存。
- 示例用于解释结构和业务范围，不当作当前页面的已验证事实。
- 没有可选运行证据时，不再显示无实际选项的证据下拉。
- Web 展示本机宿主登录/选中状态；规划由所选宿主执行，视觉定位与动作仍由 Midscene 执行模型承担。
- 知识库由服务端管理（如 `domain_knowledge`、规则包存储），不是要求用户手填一个任意文件路径。

代码：`server/src/knowledgeLibrary.ts`、`plannerHost.ts`、`fieldDraft.ts`、`codex.ts`；`src/components/PlannerHost.tsx`、`workbench/KnowledgeSelect.tsx`、`NewRunForm.tsx`。

### 3.2 Explore 的业务与组件状态规划

- 源节点将固定领域知识、规则包和当前组件上下文交给宿主规划。
- 控件计划区分功能解释、预期、风险；Tab/弹窗/下拉是同一 URL 下的不同状态，不能只数 URL。
- 动态计数归一化保留原标签及空/非空差异；执行前重新检查目标的标签、可见性、区域，不接受含糊定位回退。
- 报告保存目标尝试、观察、证据引用、状态转换、未覆盖原因、预算停止原因；`partial` 不等于完成。
- 模型规划输出只是候选解释，不等于业务断言已验证。

代码：`server/src/explorationPlanner.ts`、`workflowOps.ts`；`packages/harness-testing/src/domain/explorationEvidence.ts`、`packages/harness-testing/src/exec/explorationScope.ts` 及领域规则实现；`plugins/testpilot/skills/testpilot-explore/`。

### 3.3 生命周期故事与候选需求审核

- 规则包可声明 `businessTransitions`：前置状态、动作、结果、失败/恢复、准备要求。
- 故事绑定转换及对应成功/失败验收条件索引；门禁检查结构覆盖、前置条件、引用与候选标记。
- 已有订单、非空持仓等缺失状态放入观察/准备缺口，不因此删掉业务能力。
- `observationLinks` 区分 observed / partial / unobserved；没有证据不能冒充观察到。
- 假设可以生成待确认的候选业务预期：条件放 `story.acceptance`，`requirementDraft` 仅放 `reason` 和 `questions`。
- 人工审核前，不能进入用例设计。候选故事不是产品已验证行为，也不是可以直接执行的失败判据。
- UI 展示生命周期前置条件、覆盖与候选审核内容。

代码：`packages/harness-testing/src/domain/businessLifecycle.ts`、`casegen/planningContract.ts`、`casegen/types.ts`；`server/src/workUnits.ts`、`storyReview.ts`、`workflowControls.ts`；`BusinessLifecycle.tsx`、`BusinessLifecycleInputs.tsx`、`StoryRequirementsReview.tsx`。

### 3.4 节点输入/输出比较与开发评测

- 迭代评测页可固定两侧节点产物及来源，阅读输入/输出，比较变化，保存全局或节点维度人工评价与理由。
- 记录实际加载实现、上下文/来源；缺历史身份时标记未知或诊断比较，不补造采集身份。
- 项目资产库另有同资产版本比较：内容并排、结构指标、输入/环境一致性、人工 better/worse/tie/incomparable 记录。
- 数量、AC 数、转换声明数等是结构指标，不自动选优，也不替代语义覆盖或实际执行。
- 开发回归入口 `pnpm eval:node-quality --node all`；测试按各节点契约选取，不用一个最终总分掩盖上游退化。

代码：`server/src/artifactComparisons.ts`、`projectComparisons.ts`、`scripts/eval-node-quality.mjs`；详见 [节点评测交接](2026-09-23-node-eval-development.md)。

### 3.5 项目级持续完善：六项顺序任务

| 任务 | 核心实现 | UI / 边界 |
|---|---|---|
| 资产版本 | `projectAssets.ts`：不可变版本、来源、父版本、依赖、内容哈希、candidate/adopted/superseded/rejected | 物料页登记候选、比较、人工采纳/拒绝、保存快照；expectedHead 防并发覆盖 |
| 运行计划 | `projectRunPlans.ts`：固定选择版本、配置指纹、幂等启动 | 从头生成 clean、基于快照 incremental、独立建档 rebuild；先预览再启动 |
| 发现回收 | `projectDiscoveries.ts`：Explore/准备/执行系统回执支持的候选发现，按身份归并引用 | 分清观察与假设；重复回执不算独立证据；held-out 禁止回流 |
| 项目任务图 | `projectTasks.ts`：快照、目标资产、依赖、租约、预算、影响分析 | 领取前校验依赖和当前资产版本；状态 pending/claimed/review/done/rejected/blocked |
| 全局增量规划 | `projectIncremental.ts`：宿主读取固定项目上下文，提出候选修订和后续任务 | 审核任务、采纳资产分开；source 任务实际调用定向 Explore |
| 比较与验收 | `projectComparisons.ts`、闭环与 UI 脚本 | 两轮增量机制、隔离和人工比较已测试；真实模型质量收益另验 |

项目是长期知识/任务的归属；运行是一次有输入绑定的执行记录。反馈回路展开为新任务代次，执行任务本身保持 DAG，不往旧任务添加反向边。

#### 运行方式的实际语义

- **clean**：仅使用本次选择的知识与规则，不注入旧生成资产，不读准备经验；不删除历史，也不重置交易账户。
- **incremental**：显式引用固定资产快照；历史产物作为参考材料，不把历史观察当当前页面状态，不自动批准新业务预期。
- **rebuild**：建立独立 `line-*` 资产命名空间，主线和新线的快照/依赖隔离。
- **继续运行**：同一 run 从缺失节点接着做。
- **从此节点重跑**：新建 run，复制固定上游产物，从指定节点开始；最新故事审批例外见下一节。
- **重跑已审核测试**：仍使用原有批准用例的执行入口，不等同于重新生成。

计划预览后项目、环境、所选宿主、模型配置或 skill 指纹发生变化，启动前要求重新规划。指纹只保存摘要，不把密钥写进文档。

#### 调度与执行的真实边界

- 项目任务默认最多尝试 2 次，上限 3 次；依赖代次最多 4 层。
- 普通规划租约约 5 分钟，定向探索最多 15 分钟；迟到 worker 不得提交。
- 增量上下文上限当前为 180000 字符，宿主规划超时 240 秒；过大时要求拆任务。
- 提案最多 10 个资产修订、6 个后续任务；固定基版本、证据引用和依赖必须通过校验。
- source 任务需要只读规则包，不会凭一个发现获得下单/开仓授权，不自动建立交易 fixture。
- 后续任务在审核后显式生成，有去重记录；不是一个常驻无限自愈后台。
- 两轮闭环自动测试采用受控宿主回复，证明流转正确，不能冒充真实模型语义提升。
- **当前真实项目尚未登记/采纳项目资产或创建增量任务**，仅自动收集了 7 条发现。项目功能的闭环主要在隔离测试项目验收。

API 根路径：`/api/projects/:projectId/assets`，下有版本、快照、plans、discoveries、tasks、impact、compare、comparisons。UI 为 `ProjectAssetLibrary.tsx` 与 `ProjectEvolution.tsx`。MCP 新增 `tp_assets` 读取入口，发现上报在 `tp_stage`；人工审查动作仍是操作者入口。

## 4. 最容易再踩的坑及修复

### A. 修改 skill/单元合同，却漏掉宿主启动话术

真实运行 `run-a32ef71b-d7b8-4295-9c7e-75dc5d1f6cd2` 曾在 stories 失败：服务端要求候选业务转换带验收条件，启动话术却说“假设永远不能成为验收条件”。宿主提交空条件遭拒后请求例外，未提交节点完成回执。

修复：`server/src/runtime/skill-launch.ts` 首次启动和 `penguinRun.ts` 续跑共用 `STORY_PLANNING_CONTRACT`，明确候选条件的位置和审核停止点。没有放宽覆盖校验器。真实重跑 4/4 个故事单元完成，共 17 条候选故事。

经验：提示词是协议的一部分。改策略时一起检查 skill、host launch、resume、claim_unit、服务端 validator，不能只改模型看到的其中一层。

### B. 节点显示正在启动，底部却显示完成

`run-b80a64b0-5796-4cf6-9583-7f6e3ab15dc1` 的案例设计被故事审核拦住，宿主退出，但 cases 仍是 queued；收尾原来只处理 running。底部在失败运行中忽略 queued，又选中了 stories/done。

修复：

- `beginStage` 遇候选审核缺失时持久化 waiting_review/blocked，再返回停止结果。
- 不在事务里“先写状态、再 throw”，否则写入会回滚。
- 宿主退出收尾同时处理 queued/running。
- `displayNodePhase` 防止已停止运行保留启动动画；`progressNode` 优先跟随受阻或待审核节点。
- 原错误保留为诊断，当前 `error` 清除，不能为了显示正确删除历史证据。

### C. 从用例节点重跑，又让用户审核完全相同的故事

早期设计禁止任何审批继承，虽然避免了误审批，却让正常重跑陷入重复确认。上一轮先只修正状态，用户再次操作证明还需要修复语义。

**最新规则（覆盖较早文档的笼统“不继承审批”）：**

`inheritStoryApproval` 只在系统记录的下游 fork（cases/gate）上工作，并同时验证：同项目、故事内容哈希一致、直接复制来源、固定业务材料/知识/模块/探索证据/环境/目标绑定一致、可追溯至真实人工审批。连续重跑递归验证审批链，防止循环。新故事或业务输入变化不继承。

- 新记录名：`review/story-requirements-inherited`，创建者为 system。
- 保留原故事、原人工审批、来源运行引用；不伪造一条新的 human 审批。
- **不继承用例审批、测试通过或执行/交易授权。**
- UI 显示“故事和业务输入未变，已沿用原人工审批”及来源运行。
- 修复旧 fork 的显式续跑也可校验沿用；必须先处理故事审批，再计算 checkpoint.next，避免拿到旧的 stories 待审核检查点。

代码核心在 `storyReview.ts` / `workflowOps.ts`。最新真实运行已沿用 `run-6cdca041-556d-46fd-81e0-68a2fc3293a6` 的人工审批并开始 cases。

### D. 输入哈希不能只算资产快照

相同快照、不同任务目标和发现证据，是不同规划输入。`projectIncremental.ts` 已将实际序列化上下文纳入 inputHash；否则版本比较会错误地认定输入相同。

### E. 隔离不能只做 UI 开关

clean 在真正的知识注入/准备经验读取处落实；rebuild 同时隔离资产 key、快照、依赖和发现任务的 lineage。held-out 禁止进入发现库和可复用资产。不要给历史数据补身份、补通过记录来提高复用命中率。

### F. 观察状态不能冒充业务规则

空/非空订单、持仓和历史数据是组件状态与业务生命周期共同作用。打开一个 Tab 不代表相关业务结果被验证。AC 数量、状态数和目标完成度不可互相替代。不能用固定“至少几步”证明生命周期完整。

### G. 真实执行环境的旧问题仍需跟进

历史记录见 [交易测试网验收](2026-09-23-testnet-business-validation.md)：实际准备阶段曾从测试网跳到被禁止的主网域名，入口检查没有覆盖后续导航。该批已中止，交易闭环未完成。本轮没有该硬导航边界的修复验收，继续正式交易试跑前必须重新核对代码和验证点击、重定向、新窗口、会话复用路径。

另一次旧烟测遇到浏览器导航超时，HTTP HEAD 200 不能说明浏览器可访问。不能把本次 Explore 成功外推为所有交易路径可执行。

## 5. 真实运行链与产物

| 运行 | 用途 / 已确认结果 |
|---|---|
| `run-649b674f-af70-4703-a266-b113da240fe6` | 旧对照，继承早期 Explore；不是本次 fresh Explore |
| `run-1f857e7d-661e-4e3c-888d-c02e7e76870b` | 本轮通过 Web+Codex 新建 clean 计划，Explore 落盘，后续模块候选生成 |
| `run-a32ef71b-d7b8-4295-9c7e-75dc5d1f6cd2` | 故事启动合同冲突复现与修复；4 个单元完成、17 条候选，后由用户审核 |
| `run-b80a64b0-5796-4cf6-9583-7f6e3ab15dc1` | cases 启动被审批拦截，queued/完成显示矛盾；已修正状态 |
| `run-6cdca041-556d-46fd-81e0-68a2fc3293a6` | 当前 fork 的已审核来源运行 |
| `run-a71572af-1d1a-494c-aea9-264230ba5c10` | 当前运行，已沿用经过验证的故事审批，17/17 个用例设计单元完成，暂停在 gate 前；以顶部快照为准 |

关键标识：

- 新 Explore plan：`plan-e77441b7-12dd-4bdd-8927-a78f0a81e56f`。
- 新 Explore 报告：`rev-36cbeb13-820c-4d90-885e-8bc88eae15c9`。
- 旧对照报告：`rev-6179c922-661f-4a73-a864-6db48a1ba6e3`。
- 当前故事：`rev-f7b480f0-12bb-430c-b1b9-fef0aa975dfe`。
- 当前审批沿用证明：`rev-5835a9b5-19a2-431d-ab98-dc94eedd54ed`。

### Explore 的提升与限制

同为 8 屏预算，交互目标完成 5/8 → 6/8，抽象状态仍为 9，行走转换 7 → 9；两次都为 partial，业务断言通过数未采集。本次补到了账户、币对选择和高级订单，但持仓和历史标签页未尝试，屏预算耗尽。自动收集 7 条候选发现（5 条组件线索、2 条缺口）。

规则包版本从 `2026-09-24.2` 到 `.3`，实时账户/页面状态不受控，不能归因成纯模型提升。四次 Codex 规划约 113/24/101/116 秒，宿主回传合计 103717 tokens，source 约 7 分 44 秒；不能宣称提速。下单、持仓、加保证金和清理闭环尚未由本轮执行验证。

## 6. 验证过什么，没验证过什么

下表为各次变更的实际验证，存在重叠，不能加总成“独立测试总数”。

| 范围 | 记录 |
|---|---|
| 项目持续完善相关服务端回归 | 7 文件、61 项通过；最后隔离修改后项目模块 17 项复验 |
| 增量输入身份修正 | 闭环 9 项复验 |
| MCP registry / gateway | 10 项通过 |
| 故事启动合同修复 | 服务端 12 项 + 规划/转换 6 项通过 |
| 启动状态修复 | 服务端 10 项 + UI 阅读 17 项通过 |
| 审批沿用最新修复 | 服务端 11 项 + UI 3 项通过 |
| 静态检查 | 最新全工作区 typecheck、i18n、Web build 通过 |
| 其他 | Codex 插件源副本一致性、host-parity 在对应轮次通过；未声称最新整仓全套重跑 |

实际 Chrome 验收：

- 临时项目隔离后端：候选登记、采纳、快照、发现选择、任务创建、人工比较保存、三种运行模式；桌面与窄屏。
- 实际项目：Web 选择 Codex、新建 clean 计划、启动 Explore；新发现可见。
- 故事修复：候选审核 UI 替代旧错误；cases 状态修复后底部跟随故事待审核。
- 最新审批沿用：来源运行提示可见，重复确认按钮不存在；API 显示 stories done / cases running。

本机临时证据（可能被系统清理，不是持久测试资产）：

- `/var/folders/6v/n907vgj107g_rg7d_6hmb7fw0000gn/T/tp-evolution-ui-wk9d1F/`
- `/tmp/tp-evolution-rerun-plan.png`
- `/tmp/tp-evolution-live-discoveries.png`
- `/tmp/tp-stories-candidate-review-fixed.png`
- `/tmp/tp-case-review-state-fixed.png`
- `/tmp/tp-story-approval-inherited.png`

较早全仓测试数见 9 月 23 日交接，不能当作当前全部变更后的整仓验收。此前删掉旧 fixture 后也出现过依赖缺失，不要掩盖。

## 7. 接手建议顺序

1. **先读取当前暂停状态及 cases 回执。** 17/17 单元已经完成，无需为了查看产物再点击“从此节点重跑”。后续继续原运行的 gate；保留 finalize/g2/execution 的审核与断点边界，不把本次文档交接当作自动继续指令。
2. 检查已完成的真实 cases 产物：保留已审核故事、成功/失败分支、前置状态、出处、观察缺口；不能只看用例条数。
3. 若再次失败，区分宿主进程/网络、指令冲突、单元结构门禁、业务待确认，先记录原因，不靠降低验收条件跑通。
4. 结合 7 条项目发现，明确哪些是预算缺口、哪些需要订单/持仓 fixture。选择并采纳合适的项目资产、保存快照，再演练真实项目的两轮增量；当前该项目尚无资产快照，不要声称已经完成真实全局自愈。
5. 要进入正式交易准备，先解决/验证持续导航边界，确认资源归属、状态准备授权和清理契约；单纯继续设计用例不意味着授权任意交易。
6. 做质量对照时固定输入与环境，保留不同规则包、状态、模型/实现、成本的差异；先结构测试与人工复核，再少量真实业务验证。
7. 合并前整理当前分支及用户未提交删除项，评审最新审批沿用例外、补当前完整验证记录，再按用户授权提交/合并。不要误把旧集成分支当最新 HEAD。

### 常用只读查询

```bash
curl -s 'http://localhost:5301/api/projects/prj-mu96i5c2-1001/workflow-runs/run-a71572af-1d1a-494c-aea9-264230ba5c10'
curl -s 'http://localhost:5301/api/projects/prj-mu96i5c2-1001/workflow-runs/run-a71572af-1d1a-494c-aea9-264230ba5c10/progress?node=cases'
curl -s 'http://localhost:5301/api/projects/prj-mu96i5c2-1001/workflow-runs/run-a71572af-1d1a-494c-aea9-264230ba5c10/story-requirements'
curl -s 'http://localhost:5301/api/projects/prj-mu96i5c2-1001/assets'
curl -s 'http://localhost:5301/api/projects/prj-mu96i5c2-1001/assets/discoveries'
```

### 相关测试命令（按变更选取，不必每次全跑）

```bash
pnpm typecheck
pnpm build
pnpm --filter testpilot-server exec vitest run test/project-evolution.test.ts test/project-assets.test.ts test/project-asset-routes.test.ts test/story-review.test.ts test/workflow-controls.test.ts
pnpm --filter testpilot-server exec vitest run --config vitest.reading.config.ts test/story-requirements.checks.tsx test/artifact-reading.checks.tsx
pnpm --filter @testpilot/harness-testing exec vitest run test/business-transition-planning.test.ts test/planning-contract.test.ts
pnpm --filter testpilot-mcp exec vitest run test/host-registry.test.ts test/run-gateway.test.ts
pnpm --filter testpilot-server exec tsx scripts/verify-project-evolution-ui.ts
pnpm build:codex-plugin --check
pnpm check:host-parity
```

浏览器集成脚本使用临时 TP_DATA_DIR 和端口，要求前端 5300 可用；不会调用模型或操作真实 SUT。数据通常在 `server/.data`，可由 TP_DATA_DIR 覆盖；host-workspaces 中有运行 trace。不要把私有 run grant、钱包、模型密钥或完整环境文件贴进交接。

## 8. 提交与文档索引

| 提交 | 作用 |
|---|---|
| `5596130` / `1dc9592` / `9110baa` / `c70413a` | 节点评测、UI、状态探索、开发回归 |
| `40db186` / `03526eb` / `e5ff3f1` | 新建运行文案、证据选择、版本知识库 |
| `f595568` / `ae1f211` | 本机宿主接入、Explore 组件业务规划 |
| `e7347b3` / `a5cbf80` / `b2c8e70` / `2355429` | 候选审核、生命周期模型/规划/UI |
| `faae5b9` / `14b9110` / `92d56ee` | 项目资产、运行计划、发现 |
| `a04ee3e` / `17471cb` / `201834d` | 项目任务 DAG、增量规划、比较与验收 |
| `a6209ce` | 输入身份包含任务与发现上下文 |
| `3e45c54` | 统一宿主首次/续跑的候选故事合同 |
| `293a96b` | 审核受阻状态、queued 收尾、底部状态选择 |
| `88a42e5` | 验证未变更输入后沿用真实故事审批 |

详细记录：

- [项目六项任务](../tasks/project-evolution/README.md)
- [项目持续完善实现与真实 Explore 验收](../reports/project-evolution-implementation-2026-09-24.md)
- [候选故事合同冲突修复](../reports/story-candidate-contract-fix-2026-09-24.md)
- [审批沿用最新规则](../reports/story-approval-inheritance-2026-09-24.md)
- [节点评测交接](2026-09-23-node-eval-development.md)
- [历史真实交易执行边界问题](2026-09-23-testnet-business-validation.md)

**交接判断：功能链及主要 UI 已接通，真实 Explore 与故事阶段已验证；当前用例设计 17/17 单元完成，暂停在 gate 前，门禁与执行尚未验证。项目级真实增量闭环、完整交易生命周期执行及同条件质量/速度提升尚不能宣布完成。**
