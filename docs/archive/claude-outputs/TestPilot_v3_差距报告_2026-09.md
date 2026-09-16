# TestPilot v3 差距报告（对照 2026 harness 工程调研）

> 对象：`/Users/admin/Midscene/testpilot`，分支 `v3`（本地，未推送；远端只有 main / v2）。
> 读了什么：目录树、193 条提交记录、`docs/v3/history/00-架构.md` 全文、`docs/v3/history/04`、`docs/v3/history/05`、`docs/archive/spec/01`、`benchmark/binance-futures/README.md` 与 scoreboard、`evals/README.md`、`plugins/testpilot/plugin.json` 与 10 个 skill、hooks、`harness-core` / `harness-testing` / `testpilot-mcp` 源码目录、变异算子、CI 配置。约 8 万行，94 个测试文件。
> 对照基准：上一轮调研里 Anthropic（best practices / effective harnesses / harness design）、OpenAI harness engineering、Stripe minions、Cognition、OKX 2026-07 JD、以及 PenguinHarness 本身（Prism-Shadow/penguin-harness，开源 RSI harness）。

---

## 0. 先纠正我上一份 Review 的判断

上一份 Review 说 TestPilot「缺可复现案例、缺数字、缺演示」。这对 GitHub 上那 20 个提交的 v1 是对的，对本地 v3 **错了一半**：v3 缺的不是深度，是**数字**和**可见性**。

v3 已经做到的、在调研里被列为 2026 年 harness 工程核心的东西：

| 调研里的要素 | v3 现状 | 证据 |
|---|---|---|
| 验证优先，判定落在确定性信号上 | **强** | 五种 oracle（text/noText/url/count/delta）+ tier 分层；「None ≠ 0」不可观测不进分母 |
| 考卷不能由考生出（生成与判定分离） | **强** | 打分留在 MCP 工具，模型不写分；`rubric/` 对 agent 不可见；`held-out/` 只读；变异体只从产品事实生成、不看用例 |
| 来源印记 / provenance | **强** | `sourceRefs ⊆ retrieve_spec` 返回段，hook 校验；RunMeta 缺 skillVersion / promptsDigest / model / materialsHash 任一项拒打分 |
| 评测是文件、预判先写 | **强** | `evals/*.json` 两臂只差一件事；`expect` 记录但不断言（「一个会红的评测会被人调到绿为止」） |
| 配对评测与统计纪律 | **机制强，数据空** | McNemar、Cohen's κ、n≥3 报分布——但 `scoreboard.yaml` 是 `entries: []` |
| 确定性门禁（hook）而不是提示词 | **设计强，运行时空** | 6 个 hook 写好并有子进程测试；装着的 Penguin 0.2.9 没有 hook，C 臂 trace 里 hook 事件 0 条 |
| CI 不打 API：回放确定性 + 提示词漂移检查 | **强** | `scripts/replay.mjs` 逐位比对；`check-drift.mjs` 两臂规则逐条认领 |
| 批准永远是人 | **强** | `Decision.decidedByKind ∈ {human}`；agent 写 `decisions.json` 被 hook 拒并计数 |
| 第三方文本围栏（prompt injection） | **强** | `<spec_material>` 围栏；投毒夹具只在 `cases/poison/` |
| 记忆：存 episodic、有形状、有写过滤 | 有 | key/value 上限、category 枚举、token/邮箱拒收 |
| 可观测性 | 有 | Langfuse、事件总线、预算与租约 |
| 单组件消融（每个组件都能被关掉） | **强** | `ABLATABLE`、`frozenInputsDir` 单 skill 进化 |
| 领域知识作为 skill（业务在哪） | **弱** | 10 个 skill 全是通用测试设计方法（等价类/边界/状态转移/决策表），没有一份交易领域 REFERENCE |
| 对外可见的结果 | **无** | 无 scoreboard 条目、无 Formal Baseline、无杀掉率、无成本表、v3 未推送、README 仍是 v1 |

一句话：**这是一个已经把「秤」造好、但一次都还没称过东西的实验室。** 而求职看的是称出来的数字。

---

## 1. 三个决定求职价值的差距

### 差距一：零数字（最急）

193 个提交之后没有一个可以写进简历的数。原因是设计上的 fail-closed（没人复核的 gold 不产生分数——这个原则是对的），加上三件外部阻塞：Penguin 0.2.9 无 hook、`api.runinfra.ai` 连接层约 2/5 失败、思考模式关不掉导致方差大。

调研里所有可引用的 harness 案例都以数字开头：OpenAI 5 个月 100 万行 1500 PR；Anthropic 单 agent $9 / 20 分钟 vs 完整 harness $200 / 6 小时；Cognition 合并率 34% → 67%。你的对应物应该是三组：

1. **Formal Baseline**：binance-futures gold（goldHash `9adf397fde985380`）上 A 臂 n=3 的覆盖率中位数与散布、gate 分、每次运行的模型成本与墙钟。
2. **一次配对评测**：不要等 C 臂 hook。你自己在 `00-架构.md §12` 已列出选项三「A 臂内部配对（消融、n≥3）」——现在就做，比如 `REFERENCE-oracle.md` 装上 vs 卸掉（这正是它被设计成可选文件的原因），报 McNemar。
3. **变异杀掉率 + 活下来的清单**：四个算子（text/hide/relink/dropOne）对 gold 用例集的杀掉率，并按你自己的规矩同时报活下来的。`docs/archive/spec/14` 里已有一个 0.600（12 条子集、零模型调用）——把它做成正式条目。

这三组数任何一组出来，TestPilot 就从「平台」变成「结果」。

### 差距二：业务是空心的（最关键，也是你问的「harness 怎么和业务结合」在你自己仓库里的答案）

`benchmark/binance-futures/README.md` 里你自己写了最准确的一句：**「对着观察写的用例只能发现产品变了，永远不可能发现产品错了——观察不可能反驳被观察者。」** 这就是业务缺席的症状。当前流水线的输入是探索产物（观察），skill 是通用测试方法，于是整套 harness 对「永续合约」一无所知：它不知道数量要按 stepSize 截断、不知道全仓/逐仓切换后可用余额要重算、不知道强平价公式、不知道资金费率倒计时是易变读数而 maker/taker 费率规则不是。

**业务进入 harness 的位置恰好是你已经建好的两个插槽：**

- **意图**进 `gold.json`（人写的交付物）和材料层——把 Binance 期货公开交易规则（下单精度、杠杆档位、保证金模式、强平逻辑、订单类型与 TIF）作为 `materials/` 的一部分，`derivedFrom` 从 `exploration` 变成 `exploration + rules`。这一步让用例第一次有资格「反驳被观察者」。
- **领域判断**进 skill：新增 `testpilot-design/REFERENCE-domain-perp.md`（或独立 `testpilot-domain-perp` skill），内容是只有做过合约前端的人才写得出的规则：哪些读数是易变的必须过滤（价格、倒计时、资金费率、24h 量）、哪些不变量必须断言（精度、步进、杠杆上限、模式切换后的重算、下单被拒时的文案）、状态机的合法迁移。**它是可选文件，所以天然是一臂**——「装上领域 REFERENCE vs 不装」就是你下一次单 skill 进化的题目，用你已有的 `frozenInputsDir` + `paired_eval` 跑。

这一改动的求职意义：它把你两年 BingX 经验变成一份可以被配对评测称量的文件。面试里「领域知识让 agent 生成的合约用例 P0 命中率从 X 到 Y」比任何「我熟悉永续合约」都硬。

### 差距三：不可见（最容易补）

- v3 只在本地；GitHub 的 TestPilot 是 v1（20 提交、1 star）；博客里写着「我自己没跑过完整的循环」。外界看到的你和这个仓库里的你是两个人。
- 提交信息与文档是我这两周读到的最好的一手工程写作——「记下三次白跑」「因果是干净的，但我那条规则漏掉了登录」「一次什么都没跑的运行报告说它成功了」「这个目录被删过一次」——第一人称、有数字、先写失败。这恰恰是「AI 味」的反面。它们现在锁在私有分支里。
- 推送前要处理：`.data-selftest/secret.key`、`packages/harness-testing/.env.tmp`、`server/.env`、`~/.penguin` 的 key 引用；`git status` 里几十个未提交的修改与重命名先收敛成干净提交。

---

## 2. 次级差距

**Web3 路径在 v3 里退场了。** 注入钱包与链上断言（`exec/injectedWallet.ts`、`exec/wallet.ts`）还在，但 v3 的唯一基准是 CEX 的 demo 页，dapp 路径没有基准、没有 gold。对 DEX 岗位这是最直接的证据缺口。补一个 `benchmark/perp-dex-anvil/`（Anvil fork 上的开源 perp 或 swap 前端），让链上回执作为 tier 1 oracle 真正进入记分板。

**运行时耦合风险。** PenguinHarness 是外部开源项目，hook 在发布包里缺席就是例子。你同时保留了 A 臂（自研 `run_pipeline` for 循环）和 C 臂（Penguin skill），这其实是资产，要把它讲成资产：**同一份领域 skill / hook / oracle 跑在两个 harness 上，harness 换了资产还在**。不要让 harness-core 「退役大半」得太干净，留作 A 臂对照。

**模型端点绑定。** `qwen3-8-flash-next` 思考关不掉、方差大、连接 2/5 失败，这些都进了文档，很好；但作为作品，至少一臂换成 Claude/GPT 家族跑一次 n=3，证明结论不依赖单一模型（也回应你自己写的「judge 要换模型族」）。

**成本账没有汇总。** `model/budget.ts`、`lease.ts` 记了每次花费，但没有一张「每条用例的模型成本 / 墙钟 / 视觉调用次数」表。调研里每个案例都报成本，OKX JD 写的「enable a small team to operate at the scale of a much larger group」要的就是这张表。

**文档 > 代码的风险。** `docs/spec` 17 篇 + `docs/refactor` 19 篇 + `docs/v3` 6 篇，加上三份 README。Thoughtworks 对 spec-driven 的警告（markdown 审阅负担超过代码审阅）在这里成立。`00-架构.md` 已宣布是唯一真相源，那就把 spec/refactor 归档到 `docs/archive/`，对外只留 v3 的 6 篇。

**一人 8 万行。** 导航 11→7、复核队列→审计台的 UI 重构还在路线图上；每一个未完成的面都在稀释「结果」。接下来四周不应再加面，只应出数。

**未验证项**：我没有在你机器上跑 `pnpm typecheck` / `pnpm test`，CI 是否全绿以仓库为准。

---

## 3. 把它讲给面试官

**30 秒版**：「我做了一个 AI 生成并执行 E2E 用例的 harness，被测对象是币安合约交易页。核心不是生成，是称量：黄金集由人写、打分由确定性工具算、模型不写分；每个组件都能被关掉做配对评测；变异体从产品事实生成、不看用例；CI 只做回放不打 API。」

**3 分钟版**加三组数字（差距一）和一个故事（`evals/README.md` 的三次白跑：报告全绿、产物为空，根因是约束解码里可选键被模型跳过——这就是 2026 面试题「AI 哪里错了、你怎么发现的」的标准答案）。

**对 OKX JD 逐句对应**：「agent harnesses」→ A/C 双臂；「reusable skills」→ plugin 10 个 skill + 版本与 digest；「E2E automation」→ Midscene + 注入钱包；「evaluation pipelines」→ evals/ + paired_eval + κ；「teaching AI agents to maintain tests」→ 自愈双口径 + 有界修复 + `docs/archive/spec/01` 里「自愈收敛率宽口径 70% / 严口径 50%」的引用与你自己的度量。

---

## 4. 四周计划（替换上一份 Review 里旗舰 #1 的前半段）

| 周 | 做什么 | 出什么数 |
|---|---|---|
| 1 | 清理工作树、脱敏、推送 v3；跑 Formal Baseline A 臂 n=3 | 覆盖率中位数/散布、gate、成本、墙钟 |
| 2 | A 臂内部配对：`REFERENCE-oracle` 装/卸；变异四算子跑 gold 集 | McNemar 结果；杀掉率 + 活下来清单 |
| 3 | 写 `REFERENCE-domain-perp.md` + 期货规则进材料；冻结上游后单 skill 配对 | 领域 REFERENCE 带来的 P0 命中率变化 |
| 4 | 英文 README（v3）、3 分钟录屏、4 篇 build log（三次白跑 / 目录被删 / hook 缺席 / 领域臂结果）；更新简历数字 | 可引用的作品页 |

第 5 周起再考虑 dapp 基准与换模型族；Penguin hook 什么时候来不影响以上任何一项。

---

## 5. 回到你的问题：harness 怎么和业务结合

用你自己的仓库回答：harness 是 `packages/` 和 `plugins/` 里那些与产品无关的机制——检索、围栏、门禁、打分、变异、回放。**业务是三个文件**：`materials/`（产品的事实与规则）、`gold.json`（人对「什么算测对了」的意图）、`REFERENCE-domain-*.md`（领域判断）。前者你已经造得很硬，后三个里你只填了一个半。填满它们，然后用 harness 称一称「填之前 vs 填之后」，这个差值就是「业务结合」的可量化定义，也是你简历上最值钱的一行。
