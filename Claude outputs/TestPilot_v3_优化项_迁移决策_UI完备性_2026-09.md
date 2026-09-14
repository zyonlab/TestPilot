# TestPilot v3：可优化项、是否迁出 PenguinHarness、人工 UI 是否完备

> 2026-09-06。目标按你的话定：**产品要摸到第四档——让 agent 能安全地改交易前端**。所有判断以此为准。
> 依据：`server/src/penguin.ts` / `penguinRun.ts`（Penguin 接缝）、`src/pages` 19 屏与 `server/src` 全部路由、`docs/archive/spec/17` 的 80/80 任务记录、`MigratedToPenguin.tsx`、前几轮读过的架构与评测文档。未在你机器上启动 UI，屏幕级结论是从路由、页面文件和文档推断的，标了「推断」。

---

## 0. 第四档到底要什么

把第四档拆成可验收的六项，后面的所有优化项都对着它们排：

| # | 第四档的构成 | v3 现状 |
|---|---|---|
| 1 | 执行便宜且稳定：P0 用例分钟级跑完，flake 有预算 | **缺**：仍逐步视觉调用；BingX 那次 30 条数小时的问题未解 |
| 2 | 领域 oracle：合约不变量作为可称量的 skill/材料 | **缺** |
| 3 | 门禁在代码里而不在提示词里：schema、provenance、gate、批准由人 | **有**，但 C 臂在 Penguin 0.2.9 上不执行 |
| 4 | 自愈退化被抓：断言放松、删测试被计数并拦截 | 设计有（宽严双口径、`degraded[]`），**未出数** |
| 5 | 接进研发循环：coding agent 改完代码自动跑、Stop hook 挡、CI gate | **缺**：MCP 有，但没有任何 coding agent 在调它 |
| 6 | 有账：每条用例每次运行的 token / 美元 / 墙钟；有 scoreboard 条目 | 记账有，**汇总无**；scoreboard 空 |

六项里 v3 真正完成的是第 3 项的一半。**第四档的差距不在架构，在第 1、2、5 项和所有的数。**

---

## 1. 可优化项（按对第四档的贡献排序）

**一、执行层降本（对应 #1，最高优先级）。** 视觉模型只在首跑和自愈时调用；之后走 Midscene 缓存的计划或导出的 Playwright（两条路都已存在：`MIDSCENE_CACHE`、`export.ts`）；劫持 API 的账户状态做成 fixture（刚提交的测试数据工厂）；每条用例落一行 `{tokens, usd, ms, visionCalls, cacheHit}`。验收：30 条 P0 在你的合约 UI 上 **≤10 分钟、连续 5 晚 flake ≤5%**。这是 BingX 失败的直接原因，也是交易所最先付钱的东西。

**二、领域层（对应 #2）。** `REFERENCE-domain-perp.md` + 期货规则进 `materials/`，让用例第一次能「反驳被观察者」。用 `frozenInputsDir` 做「装/卸领域 REFERENCE」的单 skill 配对评测。验收：领域臂对非领域臂在 gold 上的 P0 命中率差异有 McNemar 结论（哪怕不显著也是结论）。

**三、把 C 臂搬到能执行 hook 的运行时（对应 #3，见第 2 节）。** 这是解开 Phase 3「数字好看但是假的」阻塞的唯一办法，不依赖 Penguin 发版。

**四、接线（对应 #5）。** 在你的合约 UI 仓库里装 TestPilot 的 MCP + 一个 Stop hook：agent 改完 `src/` 就必须 `run_case` 对应的 P0 并且 gate 绿才能结束回合。验收：一次录屏——Claude Code 改一个下单面板的精度 bug，被 Stop hook 挡下，修好后放行。这一条录屏抵得上十页架构文档。

**五、出数（对应 #6）。** Formal Baseline n=3、一次消融配对、变异杀掉率含活下来清单、成本汇总表。scoreboard 从空到至少 3 条带完整 binding 的条目。

**六、被测对象换成可控的。** Binance demo 有 WAF、会话过期、活行情、结算时点——staging 那套老问题换了个壳。Formal Baseline 用自己的合约 UI 或本地 fork，Binance demo 只留演示。这一条同时服务 #1 和 #6。

**七、工程卫生。** 工作树 197 处未提交改动、v3 未推送；`server` 跑 Node 22 而 Penguin 要 Node 24 导致 shell-out 到 nvm 绝对路径（`penguin.ts` 自己记了这是权宜）；`.data-selftest/secret.key`、`.env.tmp` 推送前脱敏；`docs/spec` 与 `docs/refactor` 归档只留 `docs/v3`。这些不产生能力，但每一项都在拖慢前六项。

**八、模型端点。** 思考关不掉、连接 2/5 失败，导致方差和白跑。至少一臂换到能关思考的端点或另一模型族，否则 n=3 的散布里有一半是网关的。

不建议再做的：新的屏、新的导航、新的图（画布已经让位给队列，对的）、Penguin 之外第三个自进化机制、把 Langfuse 升回评测平台。

---

## 2. 要不要从 PenguinHarness 迁出

**结论：不「迁出」，改成「多运行时」，但把 Claude Code 立为 C 臂的主运行时，Penguin 降为进化实验臂。** 理由分三层。

**技术上迁移成本很低，因为你把接缝切得很干净。** `server/src/penguin.ts` 是领域服务和 harness 之间「唯一的接缝」，往上只暴露四个函数（起跑、读产物、监听、写决定），往下是 shell-out 到 `penguin run` CLI，产物从运行目录读而不是从子进程 stdout 读。写一个 `claudecode.ts` 做同样四个函数——shell-out 到 `claude -p --output-format stream-json`，装载 plugin，MCP 走 `.mcp.json`——工作量与 Phase 0 相当，而且 Claude Code 的 stream-json 是真正的事件流，比 Penguin CLI「只在结束时打一行 JSON」更好接。`RunMeta` 加一个 `runtime` 字段，P3 的来源印记就把运行时也钉住了。skill 直接复用，hook 需要一个载荷适配器（前一轮说过），Codex 无 hook 则把门禁挪进 MCP 写工具里。

**产品上 Penguin 的独特价值只有一样：`agent-optimization` 能自动改 `agent_state/`。** 这是自进化那条线，是你作品里值得演示的能力，但不是第四档的构成要素——第四档的六项没有一项需要自进化。而 Penguin 的代价是实打实的：0.2.9 无 hook（门禁只剩指令）、Node 24 only、`:7364` 的 API 无公开契约、单个早期开源项目的供应商风险。你的 Phase 3 已经被它挡了一次。

**求职上，Claude Code 是雇主在用的东西。** OKX JD 写的是「agent harnesses、reusable skills」，Coinbase 写的是「Claude Code、Cursor、Codex」。「同一份 skill + gold + MCP 跑在 Penguin / Claude Code / Codex 三个运行时上，比 gate、覆盖率、成本」这张表，只有你能做，而且它直接回答「领域资产能否脱离 harness 存在」。

**具体怎么分工：** 生产用途（夜间回归、CI gate）跑确定性的 pipeline 臂；coding agent 接线（Stop hook、`run_case`）走 Claude Code；Penguin 保留为「优化器实验」——当你要演示「让 agent 改进 skill」时用它，并且它改出来的 skill 版本必须回到 Claude Code 上用同一份 gold 重新计分才算数。Codex 作为第二模型族做稳健性对照。触发条件：Penguin 两周内没有带 hook 的发布，Claude Code 立即成为 C 臂默认；否则两者并行。

**迁移会暴露的一个洞：** `MigratedToPenguin.tsx` 把工作流运行、画布、配对评测、变异、进程、能力、模型端点、提示词模板这些「这台机器怎么跑的」的屏交给了 Penguin 的 `:7364` 操作台。Claude Code 没有这样的操作台。所以一旦 Claude Code 成为主运行时，trace 和成本的可视化只剩两条路：Langfuse 作为汇聚点（上一轮结论：留、降级），或者你的审计台自己画 `events.jsonl`。这也是「Langfuse 还要不要」那个问题的真正答案——取决于你迁不迁。

---

## 3. 人工通过 UI 访问的功能是否完备

**先说结论：对「人复核 agent 产物」这个角色，UI 已经超过完备；对「人拥有第四档的判定资产」这个角色，缺三块。**

`docs/archive/spec/17` 的 80 项任务全部 done（P0 事实与正确性 25、P1 画对 11、P2 队列换画布 7、P3 七屏 11、P4 chat 作为条目 composer 5、P5 后端 21）。19 个页面、约 130 条 API。按人的四类工作核对：

**按例外复核（完备）。** `review` 批次、逐条 patch、approve、regenerate、gap-case；`pending` 只出待办；`reviewFilter`；holds 计数；chat 作为条目上的 composer 而不是独立聊天（P4 的选择正确，符合「不要自己造 chat」）。

**校准判官（完备）。** `audit/:runId/labels` 收人工标注、`calibration` 算 κ（n<10 不显示）、`scan` 独立审计、`diff`。

**基线与隔离（完备）。** 视觉基线三联图批准、性能基线批准、pending-baselines、quarantine 与 quarantine-log、flakiness 重算、trends、traceability、code-line、delivery、export 与 preflight、datasets、environments 会话捕获/导入、secrets vault。这一组是 v1/v2 积累下来的，覆盖了夜间回归「早上人看什么」的全部动作。

**缺的三块（对第四档而言）：**

第一，**gold 的生命周期没有 UI。** gold 是「人的交付物」，但从 `gold.draft.json` 到复核、写 `match` 规则、标 `heldOut`、冻结出 `goldHash`，整条路是编辑 JSON 文件；`src` 里 `heldOut` 出现 36 次是读，不是编辑流程。第四档里 gold 是最核心的人工资产，它需要一屏：草稿逐条过 checklist（删易变读数、收紧 match）、标留出、冻结并显示谱系哈希、以及**过时检测**（条目挂到路由/组件，代码变了标出该复核的条目——这是我前面提的 gold 腐烂问题，目前完全没有）。

第二，**记分板和来源印记不可见。** `scoreboard` 在 `src` 里只出现 2 次，`skillVersion` 0 次。人看不到「哪一版生成器、哪个模型、哪个运行时、在哪条谱系上得了几分」，也就没法在 UI 里做「接受这一版 skill 前推」的决定——单 skill 进化的第 5 步「接受才前推」目前没有人机界面。它不需要复杂：一张表，每行一个 binding，可按 goldHash 分组，可选两行做 paired。

第三，**成本没有汇总屏。** `BudgetDrawer` 看单次预算，缺「每条用例每次运行」的成本表和跨运行趋势。第四档要向业务方证明「30 条 P0 每晚 X 美元」，这个数现在要从 `events.db` 手算。

一个不缺但要警惕的：19 屏对一个人的项目太多了。`00-架构.md` 计划导航 11→7，我没能从 `AppNav.tsx`（全走 i18n 键）确认是否已收；即便收了，Onboard、ProductMap、ChainConfig、ModelConfig、CodeLine、Delivery 这些屏在第四档的六项里没有一项用到。建议不删，但从主导航降到设置里，让首屏只剩复核、审计、运行报告、基线、记分板五件事。

---

## 4. 一句话排序

先让 30 条在自己的合约 UI 上十分钟跑完（#1），再用 Claude Code 跑 C 臂把 hook 真的执行起来（#3），然后写领域 REFERENCE 做第一次有意义的配对评测（#2），录一段 Stop hook 挡下 agent 的视频（#5），最后把 gold 生命周期和记分板补成 UI（第 3 节的两块）。Penguin 留着，但不再等它。

---

**附：一件需要你处理的事。** 我用 `git status` 读你仓库时，git 在 `.git/` 下留了一个 0 字节的 `index.lock`（你的桌面端不允许我删除文件，我已请求删除权限，若未批准请你手动 `rm /Users/admin/Midscene/testpilot/.git/index.lock`），否则你下一次 git 操作会报 `index.lock: File exists`。抱歉。
