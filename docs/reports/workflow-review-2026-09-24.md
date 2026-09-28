# Workflow 各节点逻辑审查与交易 SPA 生命周期改造建议（2026-09-24）

> 范围：`18bf0b8..3400b8b` 共 27 个提交、148 个文件、约 4300 行（Codex 在本分支连续实施），加上今天换 Claude Code 宿主的两次真实续跑。
> 做法：先弄清每段改动要解决什么，再找实现问题。四个只读审查分节点并行，关键结论我逐条回到代码或接口复核。
> 标记：**✔** 我亲自复核过；**读码** 审查者读代码确认、我没复核；**推测** 没有实证。

## 0. 结论

1. **方向对，但设计门禁在交易 SPA 上结构性地过不了。** 今天 Codex 的 84 条用例得 0 分；Claude 重生成 59 条，离线核仍有 34 条被点到（约 0.42 分，阈值 0.6）。根因不在模型，有两条：
   - 生命周期契约的四层说法互相矛盾；
   - Lifecycle v1 只会描述「新建一条带标签的记录」，这是增删改查类应用的形状，交易 SPA 的大多数状态变化装不进去。
2. **有两处安全边界没兜住，比门禁更急。**
   - 执行和准备阶段没有导航守卫，点击、重定向或弹窗都可能落到主网。
   - Claude 规划器被放行了 `Bash(node *)`，而服务端靠「请求有没有 Authorization 头」判定是人还是模型，所以规划器能用 node 直接发 HTTP，自己批准故事、冻结模块树。
3. **有几处把模型的判断当成了证据。** Explore 里「点了但页面没变」也算完成；模型给的风险分级决定能点什么；发现只要挂一条无关回执就算「有证据」。
4. **项目级持续完善做了很多，但主路径没接通，接上就会坏。** 真实项目里资产 0、快照 0、任务 0。7 条发现各自把同一份复制出来的报告计了 7 次；由它们建增量任务，上下文会超过 180000 字符的上限，而且报错被吞掉了。
5. **`pnpm check:domain-neutral` 是红的（16 处，✔）**，违反 CLAUDE.md「必须绿」。其中「内置 HL 示例」实质上就是用户否决过的「预设」。

## 1. 今天的实测（数字来源）

| 运行 | 做了什么 | 结果 |
|---|---|---|
| `run-a71572af` | Codex 规划，17/17 用例单元完成 | 84 条用例 |
| `run-cc2a7dc5` | 从 gate 分叉，换 Claude 跑 gate | 门禁 0 分；84/84 被警告：`cleanup_unmapped` 83、`readonly_mutation` 42、`resources_missing` 41；执行准入 0/84。宿主读完发现就直接进了 finalize |
| `run-7f9a0801` | 从 cases 分叉，换 Claude 重生成（约 16 分钟） | 59 条（只读 39 / 受控 20），`lifecycleIssues` 离线核 34 条被点到；还没跑 gate |

34 条的构成：ownership / established 判据 / cleanup 判据未绑定身份各 21，`cleanup_unmapped` 22，`establish_unbound` 15，`readonly_mutation` 14，`cleanup_unbound` 12，`source_unbound` 6。
门禁公式：`(1 − 被警告用例/全部) × (1 − 未覆盖动作型准则/动作型准则)`。

为了能换宿主，我改了一处代码：`rerunProjectNode` 接受可选的 `planner`。换宿主只能另开新运行，原运行的规划运行时不变。两次分叉都沿用了原人工审批。改动未提交。

## 2. 各节点：要解决什么，实现有什么问题

### 2.1 source / Explore

**要解决什么**
- 规划改由本机已登录的宿主来做，每次调用都留回执。
- 模型给每个组件做业务解释（功能、预期、风险），决定探索顺序；Tab、弹窗、下拉按同一 URL 下的不同状态来算。
- 点击前重新核对控件（遮挡、标签、区域）。
- 报告区分「尝试了 / 有点击后的状态 / 断言通过」，`partial` 不等于完成。

**问题**

| 严重度 | 问题 | 证据 |
|---|---|---|
| 高 | 点了但页面没变也算完成。完成判定只要求 `e.ok && e.to === stateAfter`，自环也满足。真实运行里 T-market 只有一次 `no_effect` 的点击，却被判成 `evidence_complete`，并流进了 `product/model-candidate` | ✔ `explorationEvidence.ts:92-96` |
| 高 | 能不能点，除了一条关键词正则，全看模型填的 `risk`；正则里还写死了 place order、平仓、撤单等交易词 | ✔ `interactive.ts:1610/1691`（domain-neutral 检查的命中项） |
| 高 | 模型给的顺序排在规则包目标前面，把后者饿死了。8 屏预算用在钱包菜单和 Balances 上，持仓、历史两个目标一次都没尝试 | 读码 `interactive.ts:1676-1690`，与真实报告一致 |
| 中 | 规划器失败，或者运行时是 penguin / connected 时，计划为空，只剩规则包目标能点，但运行不报错 | 读码 `explorationPlanner.ts:18`、`interactive.ts:567` |
| 中 | 回到已知状态或到第 5 个新状态后，计划不再刷新，可能提前停成 `exhausted`，而 `exhausted` 被当作正常完成 | 读码 `interactive.ts:2457`、`explorationEvidence.ts:108` |
| 中 | 模型的整段规划 JSON 原样写进了 `exploration.md`，和「只有观察才是证据」的材料混在一起，下游 stories 直接读 | 读码，真实报告佐证 |
| 中 | 按 Escape 被记成一条点击边，「行走转换 7→9」里有一部分是它 | 读码 `interactive.ts:2029-2040` |
| 中 | 可用性检查没先滚动，视口外的控件被删掉，然后记成 `not_found`，看起来像「没有这个功能」 | 读码 `controlScope.ts`，失败场景为推测 |
| 低 | 宿主调用不传截图；取知识时不按 `roles` 过滤；运行取消后宿主子进程不会被中止；探索 skill 仍以 binance 为例 | 读码 |

### 2.2 modules → instructions → stories，以及候选审核

**要解决什么**
- 规则包的 `businessTransitions` 声明前置状态、动作、结果、失败和准备要求，故事按索引绑定成功/失败条件。空表不等于没有这个功能。
- 由假设推出的故事是候选，要人工批准才能进入用例设计。
- 下游重跑时，故事和业务输入都没变，就沿用原批准。
- 等人时把状态真正写进库，宿主退出时收尾干净。

**问题**

| 严重度 | 问题 | 证据 |
|---|---|---|
| 高 | 规划器能冒充人。`reviewerPrincipal` 只要请求不带 `Authorization` 头就当作人；Claude 规划器被放行了 `Bash(node *)`，可以 `node -e 'fetch(...)'` 直接 POST 批准或冻结。CLAUDE.md 记的已知缺口是 MCP 工具那一路；MCP 侧已按 operatorOnly 过滤，缺口挪到了原始 HTTP 这一路 | ✔ `reviewPrincipal.ts:9-12`、`claudecode.ts:131` |
| 高 | 转换之间没有状态衔接。前置条件是自由文本，没有「这个转换产出什么状态、那个转换需要什么状态」，也没有恢复字段；改杠杆、改保证金模式这类持久设置没有还原义务 | 读码 `businessLifecycle.ts:3-9` |
| 高 | 前置条件从故事到用例的传递没有校验。84 条里 46 条少了故事绑定的某条原文前置条件，没有检查报出来；`readiness.requirements` 挂不上「对应哪条前置条件、哪个转换」 | 读码 `workUnits.ts:499-560`、`types.ts:279-284` |
| 中 | 提示词、skill、宿主启动话术、校验器四层仍然不一致：`STORY_CONTRACT` 要求把冲突写成验收条件里的【待确认】，`STORY_PLANNING_CONTRACT` 却要求放进 `requirementDraft`；skill 没提 `businessTransitions`；「role 留空」会被校验器拒收 | 读码 `workflowControls.ts:38` 等 |
| 中 | 审批沿用的「环境一致」其实没验证。`binding.environmentHash` 为 null，只比了 envRef 这个名字，改了环境画像内容也照样沿用 | ✔ 接口实测 null；读码 `storyReview.ts:20` |
| 中 | 审核只有「全部批准」，没有驳回、修改和理由，和用例复核「驳回必须写理由」的口径不一致；导入的故事不进审核 | 读码 |
| 中 | 每个转换绑定都强制至少一条失败条件，同一转换没法拆成一条成功故事、一条失败故事；转换不能带参数（限价/市价、全仓/逐仓） | 读码 `planningContract.ts:33` |
| 低 | 从节点重跑时停在等审核，会丢掉「只跑下一个节点」的断点；重跑的多次写入不在同一个事务里；等冻结模块树时，queued 节点可能没人收尾 | 读码，最后一条为推测 |

### 2.3 cases → gate → finalize

**要解决什么**
- 用例建了东西要清理，只清理本次执行建的资源（身份里带 `${env.TP_LIFECYCLE_ID}`）。
- 清理要在屏幕上验证，丢了回执就记 unknown。
- 设计质量（门禁分）和能不能执行（执行准入）分两层。

**问题**

| 严重度 | 问题 | 证据 |
|---|---|---|
| 高 | 契约四层自相矛盾，这是今天 84/84 的直接原因。单元契约要求「开关、模式切换、离开的 Tab 都**必须**写 postSteps 还原」，校验器却对只读用例带 postSteps 判 `readonly_mutation`，对不对应资源的 postStep 判 `cleanup_unmapped` | ✔ `workUnits.ts:832` 对 `lifecycle.ts:53/64` |
| 高 | 门禁要的那个数没交出去。校验器要求建立步骤、建立判据、清理步骤、清理判据都写出 identity，skill 只对 ownership 说了；返回示例里没有 `lifecycle` 字段；修复单只给一个 issue 名，不说哪一步、该改成什么 | ✔ `SKILL.md:184-185` 对 `lifecycle.ts:56-63`；读码 `prompts.ts:176`、`workUnits.ts:844` |
| 高 | 不写 lifecycle 反而得分更高：缺了只记 info，写了但不全记 warn；修复轮里模型删掉它就能过 | ✔ `gate.ts:200` |
| 高 | Lifecycle v1 只有两档，交易 SPA 的状态大多落不进去（见 §3） | ✔ `lifecycle.ts:6-26` |
| 高 | 「环境做不到」和「设计写错」一样扣分。按契约如实标 blocked 的用例照样是 warn，一条 warn 就让整条用例被扣分 | 读码 `gate.ts:696`、`readiness.ts:6-9` |
| 中高 | 门禁失败后没有回到 cases 的路。宿主启动话术只写了 `cases → gate_run → finalize_run`；finalize 在门禁没过时抛 `gate_not_passed`，运行就卡在那里；单元尝试 5 次后不再重开 | 读码 `skill-launch.ts:38`、`runStages.ts:341`；今天宿主的行为印证了这一点 |

### 2.4 g2（执行准备）→ execution

| 严重度 | 问题 | 证据 |
|---|---|---|
| **最高** | 导航越界没修（交接 §4G）。导航边界只在 `explorationEntryUrl` 有值时安装，也就是只在 Explore 里生效；执行和准备阶段没有请求拦截，也没有新窗口监听；`denyHosts` 只在创建运行时检查入口 URL | ✔ `session.ts:31-39/314`、`workflowOps.ts:43` |
| 中 | 清理失败没有持久补偿。遇到待处理资源就以 `infra_error` 停下，但没有遗留资源清单；每次身份都是新 UUID，下一轮认领不了上一轮的遗留 | 读码 `workflowExecution.ts:280`、`run.ts:189` |
| 中 | 多步前置做不了。准备配方的清理字段被限定为空，副作用只允许 none/ui-only；受控用例带准备步骤会被拒。反过来，只读用例的准备步骤完全不受限 | 读码 `preparationChecks.ts:34`、`run.ts:306` |
| 中 | 执行准入可被绕过：标为 `host-prepared-v1` 的产物跳过 `executionBlockers`，完全依赖 g2 | 读码 `workflowExecution.ts:125` |

### 2.5 项目级持续完善与评测

**要解决什么**
- 知识版本化，人工采纳。
- clean / incremental / rebuild 三种运行明确隔离。
- 各阶段撞到的新东西回收成候选发现。
- 由任务 DAG 驱动全局增量规划和定向探索。
- 版本对比，加人工评价。

**问题**

| 严重度 | 问题 | 证据 |
|---|---|---|
| 高 | 主路径接上就坏。7 条发现每条 7 个引用，指向同一份复制出来的报告（115KB）；增量上下文会超过 180000 字符上限，报错又被 `.catch(()=>{})` 吞掉，界面只显示 queued | ✔ 接口实测 7×7；读码 `projectDiscoveries.ts:13`、`projectIncremental.ts:17/22`、`projectAssetRoutes.ts:23` |
| 高 | 发现的证据门槛太宽：任何由 system 写入、kind 为 report 的 revision 都算（`knowledge/*` 用户材料也满足），模型的话挂一条无关回执就成了「有证据」；还能用未审核的发现建任务 | 读码 `projectDiscoveries.ts:10`、`projectTasks.ts:15` |
| 高 | Web 运行一律不再绑定「领域参考」。`projectRunMode` 有值时跳过 `bindDomainReference`，而新建表单现在全走运行计划。可能是有意用知识库版本取代它，但代码和文档都没说 | ✔ `workflowOps.ts:113` |
| 高 | domain-neutral 检查是红的（16 处）：`knowledgeLibrary.ts:11-14` 内置 HL 示例；`NewRunForm.tsx:35` 按 HL 域名判断；`NewProjectDialog.tsx:78` 写死 HL 的项目名和地址 | ✔ |
| 中 | clean 隔离没做全：`selectRunMemory` 不看 `reuseExperience`；准备经验的 scope 哈希不含 lineage | 读码 `runStages.ts:151`、`preparationExperience.ts:18` |
| 中 | 规划器能改知识库：`save_knowledge_library` 不查操作者、不留审计；没指定规则包的运行会用上最新一版，可能是模型写的 | 读码 `knowledgeLibrary.ts:28`、`registry.ts:65` |
| 中 | 后续任务可能卡死在 blocked，没有恢复路径；incremental 实际是整条流水线重跑，加上参考文本 | 读码 |
| 口径 | 这批改动实质上做了 CLAUDE.md 列为「冻结不做」的自进化/经验库。09 §7 记着用户 09-20 的授权，但 CLAUDE.md 没更新 | 待你确认 |

## 3. 根因归纳

1. **同一份契约写在多处，各处说法不一致。**
   - 同一条规则分散在提示词、skill、宿主启动话术、单元契约、校验器五处，每次只改其中几处。交接 §4A 的故事契约、今天的 postSteps，都是这个病。
   - 门禁要的那个数没交给模型，模型只能猜；过去三次都是说清楚之后立刻对上（见记忆 [[门禁要的那个数要交出去]]）。
2. **状态模型是增删改查应用的形状。** Lifecycle v1 和 businessTransitions 都在描述「新建一条记录，再删掉」。交易 SPA 的真实形态是另外几种：
   - 大量默认值和持久设置（杠杆、保证金模式、下单单位、滑点、止盈止损默认值）；
   - 每个市场只有一个的持仓；
   - 屏幕上不显示自定义标签的挂单；
   - 不可逆的手续费和资金费；
   - 生命周期后段的功能要多步前置（平仓要有持仓，撤单要有挂单，加保证金要有逐仓持仓）。
3. **模型的声明被当成了证据。** 「点了但没变」算完成，模型填的 risk 决定能点什么，规划 JSON 混进观察材料，发现只要挂一条回执就成立。都违反了「只有观察才是证据」。
4. **安全边界只在入口检查。** denyHosts 只查入口 URL，是人还是模型只看请求头，都假设对方守规矩。

## 4. 改造建议（结合上一轮讨论）

### 4.1 按状态种类分开处理，替代 v1 的两档

| 种类 | 例子 | 义务 | 在屏幕上怎么认出它 |
|---|---|---|---|
| 界面临时状态 | Tab、弹窗、下拉、订单类型、输入框里的值 | 不用还原；每条用例由执行器开新页面，只读用例可以随便动 | 不需要 |
| 会话状态 | 连接或断开钱包、切网络 | 执行器每条用例开头重置，用例里不写 | 不需要 |
| 设置 | 杠杆、全仓/逐仓、下单单位、滑点、止盈止损默认值 | 开始前把原值从屏幕读进变量，改完还原成这个变量，再核对屏幕 | 身份是「哪个市场 + 哪项设置」 |
| 资源·生成 | 能自己起名字的实体 | 保留 v1 的 `${env.TP_LIFECYCLE_ID}` | 标签在屏幕上 |
| 资源·属性 | 挂单 | 准备器生成一个看得见的唯一值（远离盘口不会成交的限价 + 固定数量）；开始前证明它不存在，清理后再证明它不存在 | 这个唯一值在屏幕上 |
| 资源·格位 | 持仓 | 开始前证明该市场没有持仓，清理后再证明为空 | 身份是市场 |
| 不可逆副作用 | 手续费、资金费 | 只声明，不要求还原；余额按相对值判断（`volatileReadings`） | — |

- 哪些设置会保存、持仓按市场各算一个、挂单靠价格认出来，这些是 Hyperliquid 特有的，**写进规则包**（比如新加 `stateKinds`）。代码只实现上面几类通用做法，domain-neutral 检查能保持通过。
- Lifecycle 升到 v2，v1 继续能读。

### 4.2 多步前置：用例只声明前提，由项目级准备做法来建

- 用例声明前提，比如「需要 HYPE 多头逐仓持仓」，从 `businessTransitions` 推导。这需要先给转换补上「产出什么状态 / 需要什么状态」（对应 §2.2 的高危问题）。
- 用例的 steps 只写被测动作。
- 前提由项目级的准备做法来建，一种做法多条用例共用；谁建的谁清理，按相反顺序清。
- 准备失败，用例标**阻塞**，不标失败。
- 项目里还没有某种准备做法，就回收成一条发现或项目任务。这能让 §2.5 那套机制接上一条真实的主路径。

### 4.3 门禁与流程

- **分开计分。** 契约写错，扣设计分；环境做不到，记为就绪阻塞，不扣设计分，但不许执行。缺 lifecycle 至少和写错同级，不能比写了还便宜。
- **修复单写清楚。** 报出是哪一步、该用什么字面量、应该对应哪个资源。
- **门禁失败时回到 cases 修。** 宿主启动话术和 finalize 都要把「门禁 blocked → 领被重开的单元 → 再跑门禁」写成明确的路径。
- **契约只留一份真源。** 生命周期那段契约只写在一处，其他层引用它，由 `check:drift` 守住。

## 5. 建议顺序

| 优先级 | 做什么 | 理由 |
|---|---|---|
| P0 | 执行和准备阶段装上全程导航守卫（主框架导航 + 新窗口，命中 denyHosts 就中止）；规划器去掉 `Bash(node *)`，或让审批类路由拒绝来自宿主工作区的请求 | 安全红线；前者会花主网上的真钱 |
| P1 | 统一契约：删掉「离开的 Tab 必须还原」；UI 瞬态和会话态不写 postSteps；把 identity 要出现的四个位置交给模型；缺 lifecycle 按 warn 计；门禁失败回到 cases。然后从 cases 用 Claude 重跑验分 | 改动小，直接对应今天 34 条里的大部分（估计，要重跑确认） |
| P1 | Explore：自环点击不算完成；规划 JSON 不写进观察材料；规则包目标不被模型顺序饿死；把领域词移进规则包，让 domain-neutral 检查转绿 | 证据纯度；仓库规矩 |
| P2 | Lifecycle v2（§4.1）加规则包 `stateKinds`；转换补上「产出 / 需要的状态」 | 数据契约变更，需要你拍板 |
| P3 | 前提声明加准备做法（§4.2），连带 g2 的清理字段、遗留资源清单 | 最大的一块；这之后才谈得上跑交易生命周期 |
| P4 | 项目层：发现按内容去重、收紧证据门槛、别吞报错、补上 clean 隔离的漏项、知识库写入要人来做；决定领域参考和知识库的关系 | 真实项目还没用上它，先别扩大 |

## 6. 需要你决定

1. **挂单和持仓的身份**：用「看得见的唯一值 / 市场格位」（§4.1），还是如实标 blocked，不跑交易类用例？
2. **Lifecycle v2 和转换状态衔接**这两个数据契约变更做不做，放在 P1 之后还是一起做？
3. **Explore 规划 JSON**：是只保留在规划回执里（我建议这样），还是保留在材料里、但标成「假设」？
4. **内置 HL 示例**：它和「没有预设」的决定冲突。移到仓库外的示例目录（按路径导入），还是在 CLAUDE.md 里改口径？
5. **项目级持续完善**已经超出 CLAUDE.md 的「冻结不做」：更新 CLAUDE.md 承认它，还是停在现状、只修 P4 的缺陷？
6. **领域参考**：被运行计划绕过，是有意用知识库取代它吗？

## 附：证据

- 运行：`run-a71572af`（Codex 原运行）、`run-cc2a7dc5`（Claude 跑 gate）、`run-7f9a0801`（Claude 重生成用例），项目 `prj-mu96i5c2-1001`。
- 离线核验：对 `run-7f9a0801` 的 `validated/cases`（`rev-fdc9ae3a…`）逐条调用 `lifecycleIssues`。
- 门禁产物：`run-cc2a7dc5` 的 `validated/gate`（`rev-f79cc138…`）。
- 宿主流水：`plugins/testpilot/hooks/.state/b9af7852-….trace.jsonl`（gate 阶段 21 轮，2 次工具报错）。

## 实施结果（同日晚，按 §5 顺序）

决定：§6 的问题按报告里的推荐走——身份用「可见唯一值 / 格位」；v2 与状态衔接一起做；规划 JSON 只留在规划回执；内置示例改为 `examples/` 数据驱动（不删功能）；项目层只修缺陷不扩范围；领域参考在运行计划下也冻结绑定。

| 项 | 改动（主要文件） | 测试 |
|---|---|---|
| 导航守卫 | `exec/session.ts::installHostGuard`、`run.ts` 越界即失败、`procs.ts` 把 `DENY_HOSTS` 给 runner | `host-guard.test.ts`（真浏览器：链接/302/window.open）、`run-host-guard.test.ts` |
| 宿主冒充人 | `server/src/runtime/hostActorTag.ts`，接入 claudecode/codex/penguin | `host-actor-tag.test.ts` |
| Lifecycle v2 | `exec/lifecycle.ts`（v1 归一化）、`casegen/lifecycleContract.ts`、`gate.ts`（缺失=warn+提示）、`workUnits.ts`、`prompts.ts`、design skill、`LifecycleDetail.tsx` | `lifecycle-v2.test.ts` 等 |
| 门禁被拦回到 cases | `runtime/skill-launch.ts` | `story-review.test.ts` |
| 前提状态 | `domain/businessLifecycle.ts`、`rules.ts`、`types.ts`、`gate.ts` requires-state、`readiness.ts`、`preparationChecks.ts` 受控配方、`preparation.ts`、`run.ts` 补偿 | `prerequisite-states.test.ts`、`recipe-compensation.test.ts`、`preparation.test.ts` |
| 故事侧 | `storyReview.ts`（环境画像、驳回）、`planningContract.ts`（单侧绑定）、`workUnits.ts`（角色）、`workflowControls.ts`/`modulePlan.ts`（契约对齐）、`workflowOps.ts`（断点、驳回意见） | `story-review.test.ts`、`web-claude-planner.test.ts` |
| Explore | `interactive.ts`（代码块 JSON、入口重拍、恢复路径记 tracker、dry 前回退、未覆盖目标优先、规划不进材料、restore 边）、`explorationEvidence.ts`（no_effect、`applyPlanningGaps`）、`explorationResults.ts`、`controlScope.ts`、`explorationPlanner.ts`/`plannerHost.ts` | `exploration-completion`、`explore-host-plan`、`explore-hit-test`、`exploration-planner` |
| 领域中立 | `examples/hyperliquid-testnet/example.json`、`server/src/examples.ts`、`knowledgeLibrary.ts`、前端示例入口 | `knowledge-library.test.ts` |
| 项目层 | `projectDiscoveries/Tasks/Incremental/RunPlans/AssetRoutes.ts`、`runMemory.ts`、`preparationExperience.ts`、`knowledgeLibrary.ts`、`rulePacks.ts` | `project-evolution-fixes`、`project-isolation-fixes`、`project-plan-domain-reference` |

实跑数字见 `docs/v3/09` §7 同日（晚）一条。
