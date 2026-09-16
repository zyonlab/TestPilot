# 本地 UI 重构与 Hyperliquid 验收

更新：2026-09-10。本次已改动生产 React UI、服务和执行器。原型仍作为设计参考；下述结果来自本地真实模型与浏览器，不是原型模拟。

## 当前落地的闭环

工作台选择项目和 run → Explore 采集 → 产品结构与用户故事 → 用例设计 → 规则门禁 → 复核/修订 → 准备批准版本 → Midscene 执行 → 报告与证据。

- 入口：[实际工作台](http://localhost:5300/#/?open=canvas&project=prj-mtveukwc-1001&run=run-38041ca0-630b-44d5-bca4-9f47623400a4)。API 在 5301。
- 项目：Hyperliquid Testnet；目标 `https://app.hyperliquid-testnet.xyz/trade`。
- run：`run-38041ca0-630b-44d5-bca4-9f47623400a4`。Explore 有 8 屏上限，产出 6 个模块、6 条故事、22 条用例。这个范围不包含登录、连接钱包或交易提交。
- 复核：16 条批准，6 条因过弱的通用值判据被拒绝。审核备注声明为本地自动化验收，不能作为真人 Gold 标注。
- 最终完整执行：16 条实际尝试，15 通过、1 失败、0 环境错误，耗时 4 分 53 秒，30 次转发到执行模型的请求。保留首次完整执行的 12 通过 / 4 失败及全部中间尝试。

## 实际执行记录

以下属于同一 Explore run 的七次执行尝试。修订、视口与执行上下文策略有变化，不能当成同一冻结配置下的七次重复实验。请求数包含执行层缓存的影响，不等于整个规划过程的模型用量。

| 执行 ID 前缀 | 范围 / 实际尝试 | 通过 | 非环境失败 | 环境错误 | 转发请求 | 处理或结论 |
| --- | --- | --- | --- | --- | --- | --- |
| exec-bf31e5ab | 全部 16 / 8 | 3 | 4 | 1 | 12 | 初始 SPA 空白等问题，结果保留 |
| exec-cbf93d1a | 全部 16 / 2 | 1 | 0 | 1 | 1 | 模型 HTTP 400 |
| exec-6026ae62 | C-02 / 1 | 0 | 0 | 1 | 1 | 明确分类为 context_limit |
| exec-4b29b4c1 | C-02 / 1 | 1 | 0 | 0 | 2 | 可见区域动作上下文复验通过 |
| exec-4703fa1a | 全部 16 / 16 | 12 | 4 | 0 | 33 | 暴露视口和含糊观察步骤 |
| exec-c5e8a001 | 修订后 4 / 3 | 1 | 1 | 1 | 5 | 视口解决；等待上下文仍超限 |
| exec-aadc35e3 | 全部 16 / 16 | 15 | 1 | 0 | 30 | 最终结果；C-14 保留为待审差异 |

最终执行：`exec-aadc35e3-3db8-4b0b-bc53-d9525711c8ef`；结果版本：`rev-cf30f6da-16c5-4eaf-a2bf-20e4e236e002`。Desktop 1440 × 1000；16 条批准版本形成独立编译物料。C-14 当前 Portfolio 截图没有生成用例预期的五项字段，需核对观察来源与账户状态，不能据此直接断言交易产品有缺陷。

[打开实际执行报告](http://localhost:5300/#/?open=runs&project=prj-mtveukwc-1001&run=run-38041ca0-630b-44d5-bca4-9f47623400a4&artifact=rev-cf30f6da-16c5-4eaf-a2bf-20e4e236e002) · [最终结果 JSON](../evidence/hyperliquid-refactor-2026-09-10/final-execution.json) · [C-14 页面证据](../evidence/hyperliquid-refactor-2026-09-10/c14-portfolio-evidence.png)

## UI 与服务改动

| 用户操作 | 已落地行为 | 主要文件 |
| --- | --- | --- |
| 从整体查看一次运行 | Flow 首页、历史 run 选择、桌面七节点总览、绿/红/灰节点、最新产物优先、同屏详情 | WorkflowBench、NodeDetail、useProjectRuns |
| 新项目 / 新运行 | 项目下拉新增；Spec 文本上传、Explore URL/屏数；Code 禁用；产物语言单独选 | NewProjectDialog、NewRunForm、workflowOps |
| 模块下钻 | 故事产物内的模块图；选择主/子模块联动故事，复核复用同一范围 | ProductStructure、ProjectReview |
| 审阅 / 修订 | 队列与详情、弱判据提示、批量审批、更新形成新 revision；筛选改变清空批量选择 | ProjectReview、approvedRuns |
| 查看物料与证据 | 正文、用例、结构、代码、门禁和执行报告专用展示；失败优先、报告直达对应用例并支持刷新；来源 revision、导出及截图 | RevisionViewer、GateReport、ExecutionReport |
| 断点与继续 | 未尝试节点才能新增断点，服务端在节点开始前停止；同 run 跨进程重启恢复 | workflowControls、runStages、penguinRun、MCP begin_stage |
| 调试执行 | 选择一个或多个已批准用例，生成对应执行物料后执行；选择与编译范围必须一致 | ExecutionControls、compiledReadiness |
| 设置与外壳 | 八项菜单，侧栏收起，语言/theme；双模型连接测试；环境新增测试视口 | AppNav、ModelProfiles、ModelConfig |
| 报告 / 基线 / 评测 | 报告与基线菜单分组分开；记分板默认当前项目，研究历史单独选 | surfaces、WorkflowReports、Scoreboard |

材料与领域知识随 run 保存。节点按声明的角色范围返回知识，详情显示已加载 Skill 的真实 SHA256。这里仍是共享规划会话的角色分工；不能把名称显示说成独立 agent 上下文隔离，也没有通用 finance Skill 包导入/执行能力。

## 真实联调暴露的问题与处理

| 问题 | 证据与修复 | 结果口径 |
| --- | --- | --- |
| SPA DOM 就绪但页面空白 | `/outcomes` 初始 0 字符，约 4.5 秒后渲染；执行器复用探索器的页面稳定检测 | 空白页面归环境失败，不当作产品断言失败 |
| 低成本模型上下文超限 | HTTP 400 经脱敏分类为 context_limit；动作、等待、断言统一使用可见区域元素树 | 不修改被测 DOM；原始观察证据另存；缓存策略升级为 context-v4-viewport |
| 执行前置页面丢失 | 解析批准用例的显式页面前置条件，校验同源与冲突 | C-02 从 /outcomes 开始，其他页面同理 |
| “View …” 被理解成点击 | C-14/C-16 定位歧义；C-17 误入详情 | 通过新用例修订改成 waitFor；保留 expected/oracle；编译物料也生成 aiWaitFor |
| 默认视口导致市场字段截断 | C-12 在 1024px 下缺 Funding / Countdown；1440px 复验通过 | 项目设置新增宽高；Desktop 1440 环境冻结到后续执行，不能把两种环境混成同一轮 |
| 取消后晚到结果覆盖状态 | 回归测试捕获 cancelled 被进度更新覆盖 | 先检查取消，再记进度；保留取消状态 |
| 单条切回整批仍使用旧范围 | 按创建时间找最近代码，在复用旧 revision 时选错 | 按 G2 最近成功事件选择代码，并核对选择的批准 revisions |
| 页面细节 | 下拉固定 25px 导致文字裁切；旧“未运行数量”误当待审数量；审核失效显示滞后 | 高度随内容；移除错误徽标；401 触发重新解锁；翻译函数稳定，避免详情请求循环 |

C-14 的后续实际断言仍发现 Portfolio 当前可见字段与采集来源描述不一致。保留失败与截图，需审阅来源时效、页面状态及采集边界，不直接认定为产品缺陷，不通过修改 expected 来消除失败。

## 数据重置与隔离

旧活动数据已移出服务目录，离线备份在 `/Users/admin/Midscene/testpilot-local-backups/before-hyperliquid-20260910T104128Z/application-data`。新活动数据只保留模型配置与本地凭据所需文件后重建；server/.env 未改动。当前用户项目是新建的 Hyperliquid Testnet，UI 验收临时空项目已删除。

研究基准、既有 Gold/human-labels/held-out/rubric 和历史评审文档保留。研究历史在记分板显式切换，不应出现在当前项目的运行列表中。未连接钱包、提交交易、提交 Git 或发布代码。

## 验证与证据

- [数据重置记录](../evidence/hyperliquid-refactor-2026-09-10/data-reset.json)
- [断点暂停与续跑](../evidence/hyperliquid-refactor-2026-09-10/paused-run.json)
- [16 项实际 UI 检查](../evidence/hyperliquid-refactor-2026-09-10/final-ui-checks.json)：新项目、项目往返、缺失/跨项目 run、上传预览、三语言切换、主题、收起/窄屏、七个其他主菜单；无浏览器页面异常。
- [观察步骤修订](../evidence/hyperliquid-refactor-2026-09-10/observation-revisions.json)：记录原 revision，expected/oracle 保持相同。
- [首次完整执行原始结果](../evidence/hyperliquid-refactor-2026-09-10/full-execution.json)
- [全部实际执行摘要](../evidence/hyperliquid-refactor-2026-09-10/workflow-summary.json)
- [检查点完整性](../evidence/hyperliquid-refactor-2026-09-10/checkpoint-integrity.json)：同 run 续跑保留原观察、材料、指令和故事版本及内容哈希。
- [验证索引](../evidence/hyperliquid-refactor-2026-09-10/README.md)：真实模型尝试、UI 检查、拦截请求的异常分支测试分别记录。

检查命令：`pnpm typecheck`、`pnpm test`、`pnpm test:hooks`、`pnpm check:drift`、`pnpm build`。最终退出结果和用例数在同目录 README；不将一次失败后未复验的检查写成通过。

## P 台账的边界与下一步

本轮是产品主链路的工程切片，不等于 28 项完整验收全部关闭。P-01/06/25/02/07/09/10/03/04/28/17/20 已有实施证据，仍按各项剩余验收记 doing。

- P-01/06/25：补齐所有旧深链与归档兼容、完整三语言文案；宿主 Explore 与 Web 使用同一来源契约；探索的模型/环境/费用完全按 run 冻结。
- P-02/03/05：当前只有层级和跨模块引用的兼容字段；完整 ProductBundle v2、声明级来源、千级图与分页、同源离线产品包仍待实施。
- P-07/27：知识包和 Skill 包管理、ContextManifest、按工具权限隔离的独立角色上下文。当前节点返回知识范围不等于模型已经忘记上游共享上下文。
- P-08/09/10：不可变 workflow 定义、通用 only/from/selected 子图与新的 NodeAttempt；本轮完成的是节点前断点/同 ID 续跑、执行用例子集，不应混称任意节点编排完成。
- P-26：多入口产品模型的实体对齐、冲突裁决、baseRevision 并发和影响传播尚未实现。
- P-28：基线当前参照/审批记录、新 workflow execution 的完整基线投影；旧基线和套件/趋势仍有原数据模型，需继续统一。
- P-12/17/20：旧宿主安装能力保留，未把这次 Web 验收写成三宿主全部重跑；评测入口仍需正式 manifest 投影及更多异常分支验收。

## 论文与自进化

这次验证证明了一个实际 Explore→生成→审核→执行→报告路径，暴露了可重复的执行适配问题。它不能证明专业领域覆盖、自进化收益、人工审阅效率或发表水平。

6 个模块/22 条用例主要来自未登录公共界面，不覆盖下单、保证金、精度、只减仓等核心金融规则。门禁 100% 是现有规则评分，不是测试有效率或产品覆盖率。6 条弱判据被本轮复核拒绝，说明规则门禁需要继续做语义校验研究。

Gold 提供独立评分依据；记分板呈现绑定条件下的结果；Penguin 配套 UI 组织候选与晋级。本轮没有自动晋级策略，也没有新增真人标注或正式论文对照。P-13～24 的协议、独立缺陷家族、留出与真人条件继续保留。
