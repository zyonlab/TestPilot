# 05 harness 架构

## 1. 三层 = 三个目录

| 层 | 管什么 | 目录 |
|---|---|---|
| **graph engineering** | 什么被允许继续走：节点、路由、并行、类型校验、图版本 pin | `harness-core/graph` |
| **loop engineering** | 做什么、何时停：迭代节奏、进展判定、连续 K 轮无进展停、有界修复、预算三闸 | `harness-core/loop` |
| **harness engineering** | 在哪跑、能碰什么、崩了怎么办、怎么被看见：进程、能力、护栏、记忆、状态、观测 | `harness-core/harness` |

配套：`obs/`（事件总线·lineage·重放·成本）、`eval/`（gold·覆盖·P-R-F1·配对·消融）、`model/`（上下文预算·前缀装配·结构化输出·串行闸·Fake/Recorded）。

**薄图厚模块**：图只管顺序、检查点、重试、断点、并行；领域逻辑全在图外的模块里。

✅ 已落地（`harness-core/graph`）：节点注册表（`inKind`/`outKind` 管连线、zod 管运行时载荷）、图校验（未知类型 / 类型不匹配 / 悬空输入 / 多入边 / 环，全部在**保存时**拒绝）、DAG 运行时（稳定拓扑序、按节点缓存产物、`only`/`from` 两种部分重跑、断点、预算三闸、消融集、逐节点成本记账、全程 `wf.*` 事件）。
**"耗尽预算"与"跑完了"是两种结束**，运行结果里分成 `budget` 与 `done` 两个状态——把它们混成一个，会让人把半截结果当成完整结果读。

## 2. Domain Pack 契约（core 唯一扩展点）

```ts
type DomainPack = {
  nodes: NodeDef[];             // 带 zod IO 契约
  gates: GateDef[];             // 只打分标记，处置策略由 core 统一
  artifacts: ArtifactSchema[];  // 产物 schema 与版本
  capabilities: CapabilityRecipe[];
  evaluators: EvaluatorDef[];
  prompts: PromptPack;          // 稳定前缀 + 变量后缀
}
```

**复用性三条硬检验**：① `harness-core` 里 grep 不到 `midscene`/`testcase`/`puppeteer`/`断言`；② 20 行的假 Domain Pack（如"合同审阅"）能跑起 hello-world 图并出评测报告；③ 门禁/能力/评测器全部由 Pack 注册，core 一个不内置。

## 3. 节点注册表

每个节点声明 `{ type, params, in, out }`（zod）。画布保存时校验连线类型兼容性——可编辑不等于可乱连。

| 分类 | 节点 |
|---|---|
| 输入源 | `source.spec` / `source.code` / `source.explore` |
| 规划 | `plan.stories` / `plan.decompose` |
| 设计 | `design.equivalence` / `design.boundary` / `design.state-transition` / `design.decision-table` / `design.negative` |
| 门禁 | `gate.textcase` / `gate.code` |
| 生成 | `codegen.case` |
| 执行 | `exec.midscene`（web/ios/android）/ `exec.chain-assert` / `capture.visual` / `capture.perf` |
| 修复 | `repair.loop` |
| 产出 | `emit.artifact` |
| 评测 | `eval.coverage` / `eval.prf` / `eval.paired` |

## 4. 两条工作流

**G1（scale·阶段一）**：`source.* → plan.stories → plan.decompose → design.*（并行展开）→ gate.textcase → emit`
控制形态：确定性 workflow（可复现）；仅 `source.explore` 分支内部是 agent loop。

**G2（单例·阶段二）**：`codegen.case → exec.* → gate.code →（未过）repair.loop → exec.* …→ emit`
控制形态：有界循环。

## 5. 门禁①：文本用例设计规范

| 判据 | 怎么判 |
|---|---|
| 可追溯 | 每条用例 → 唯一 story/requirement；孤儿计数 |
| 结构完整 | 前置/步骤/预期三段齐全，预期唯一且可判 |
| 设计方法覆盖 | 输入域有等价类与边界值；有状态流程有迁移覆盖；组合条件有判定表 |
| 正反配比 | 负例/边界占比 ≥ 阈值 |
| 判定分层 | 每条标 tier1/2/3 并报分布 |
| 去重 | 三元组判重（迁移 / 参数 / 断言） |
| 粒度 | 步数与断言数在区间内 |

**处置：打分 + 标记，不硬拒**；不合格进复核队列并回喂重生成。

## 6. 门禁②：用例代码规范

| 维度 | 判据（`ts-morph` / `jscpd` / eslint 规则） |
|---|---|
| 模块化 | `cases/` 只表达意图；页面细节在 `actions/`；业务流在 `flows/` |
| 可复用 | 公共片段被引用而非复制；重复率 < 阈值 |
| 可参数化 | 数据与逻辑分离；支持 env/secret/params/数据行 |
| 易 scale | 新增一条用例的增量代码量上限；无裸 sleep；无魔法值；用例独立可乱序重跑 |
| 断言质量 | 断言密度下限；tier1 优先程序判（DOM 文案/数值/链上状态） |
| 可执行 | **在真实目标上跑绿**（唯一的硬门） |

## 7. loop：有界与归因

1. 预算三闸：calls / usd / ms，任一耗尽即停；"耗尽"与"干完"是两种结束，报告必须分得开。
2. 修复循环：次数上限 + **连续 K 轮无进展即停**（上限存在 ≠ 有界）。
3. 失败归因先于修复：`infra`（超时/崩溃/环境，实测占比最大）/ `locate`（找不到目标）/ `assert`（判据不成立）。
4. 无审批下的防退化：每轮修复 diff 分类落盘（结构 / 选择器 / 等待 / **断言语义变更** / **用例删除**），报告给**宽口径与严口径双通过率**；退化标记跟着用例走。

## 8. harness：调度、记忆、能力、护栏

- **调度**：硬前置（未完成则做不了，失败沿边传染）与软前置（完成更好，跨故事顺序）分开；软前置只等"还活着"的状态。
- **记忆分层**：工作记忆（任务内，不落盘）/ 情景记忆（events，只复盘不喂模型）/ 语义记忆（多次独立观察后提升为可共享事实，有过期）。共享有代价：一次误判固化会传染后续全部任务，故有 promote 门槛与 staleness。
- **能力**：声明式 recipe `{ id, kind, start, healthcheck, 注入, 断言原语, stop, cleanup }`，监工托管。
- **护栏** ✅ 已落地（`harness-testing/src/guard.ts`）：域名白名单 + 不可逆动作拦截。默认**只拦"非白名单主机上的不可逆步骤"**，不阻断正常运行——一道会误伤日常工作的门会被直接关掉。拦下必须给理由（返回 403 + `GUARD_IRREVERSIBLE` + 命中的那句步骤），**不许静默跳过**：静默跳过会变成"这条用例验过了"，那是假绿灯。它挡的是「手滑拿生产跑全量」，不是一个想绕过它的人。

## 9. obs / eval

- **lineage**：每节点的 prompt、响应、耗时、token、模型版本、图版本、消融配置全落盘，支持 `replay <wfRunId>`。
- **配对评测**：同一批题跑两版相减（McNemar 精确检验，小样本不用卡方近似）。阶段一量 Coverage；阶段二量可执行率与 P/R/F1（Fail 为正类），并报**滑向误报还是漏报**。
- **消融**：`ABLATE=memory,softdeps,oracle,designmethod,repair,sharespill` 一关跑一遍配对比。没进清单的组件=没打算证明它。
- **成本记账**：按进程 × 节点 × 组件三维记 calls/tokens/耗时/估算成本。

## 10. 本地模型适配（Qwen3.8-27B-4bit）

短板是并发一多就慢、上下文一长就慢，因此写进 core 而不是让每个节点各自小心：

1. **全局串行闸** ✅ 已落地：`core/model` 的 `Gate` + `ModelLease`。网关持有唯一的闸，子进程通过 `acquireModel`/`releaseModel` 借槽位（`lendGate`），**持槽进程崩溃时由网关归还**，否则一个槽位会永久丢失、之后所有模型调用排队等死。默认并发 1（`MODEL_CONCURRENCY`），与浏览器并发解耦；网关自己的代码生成/refine 走同一个闸。
2. **上下文预算一等公民**：每节点声明份额，按份额裁剪，余量再分配（`sharespill`，可消融）；长材料分块+摘要+汇总。
3. **前缀稳定装配**：强制「稳定前缀（system+方法说明+schema）+ 变量后缀」（实测 9000 token 里 6144 命中前缀缓存）。
4. **宁可多次短调用**：设计方法展开按"一次一个故事/一个输入域"切。
5. **guided decoding**：zod → JSON Schema 下发，压掉"抽不出代码"类失败。
6. **Fake / Recorded 模型**：`FakeModel`（确定性桩）与 `RecordedModel`（VCR 回放，语料取自 lineage）。`pnpm test` 秒级离线；`pnpm test:live` 才打真模型。
