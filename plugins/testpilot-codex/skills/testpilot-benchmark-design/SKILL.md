---
name: testpilot-benchmark-design
description: Designs and calibrates a multi-Case TestPilot capability Benchmark, checks it with F2P/P2P mutation, and records a traceable frozen Formal Baseline into scoreboard.yaml. Use it to build or refine a benchmark under benchmark/<capability>/; it replaces benchmark-design for every TestPilot benchmark and does not optimize the Test Agent.
---

# TestPilot：设计并校准一个基准

**自由度：medium。** 流程（Capability Contract → Pilot → Freeze → Formal Baseline）是定死的，
每一步**里面**的判断是你的。它替代 `benchmark-design`，改了三处：
**打分器换成 `score_run` + `paired_eval`**、**加了 F2P/P2P**、
**加了 `human-labels.json` 的产生流程**。

**这条 skill 改的是 Benchmark，永远不改 Test Agent。** 它自己不跑也不给 Test Agent 打分：
每一次评测都用 `run_subagent` 派出去，并告诉 worker 用 **`testpilot-evaluation`**
（不是 `agent-evaluation`）。**做完 Baseline 就停，不要开始优化。**

## 开始之前

请求里没有 Test Agent、目标能力、期望的基线分数、Pilot 迭代次数上限，就把缺的问出来。
已经给了就直接做，不要让用户重说一遍。
用户显式指定的 `(provider, model_id)` 优先；否则继承当前 Session 的 Provider / Model ID。
**绝不要把 Project 默认值当成隐式的评测运行时。**

## 词表

- **Pilot**：一 Case 一 Run 的评测，用来改进 Benchmark。**没被选中的 Pilot 结果不进 Scoreboard。**
- **Freeze**：Benchmark 的这一版和评测设置不再变动。
- **Formal Baseline**：被选中的那一版完整有效 Pilot 的结果，在那一版冻结、
  且 Agent State 版本没变的前提下记录下来。

## 顺序

1. 验证 Test Agent、目标能力、评测运行时、评测访问权限。
2. 写 **Capability Contract**：要测的可观察过程、常见的更弱行为、
   这个 Benchmark 应当训练出的那种 Agent State 改进。
3. 规划完整的初版 Case 集与配分。每个 Case 私下写清楚：意图行为、
   一个强 Test Agent 会走的捷径、这个 Case 怎么把两者区分开。写完做泄漏检查。
4. 每个 Case 完成一次有效评测。这些合起来是 Pilot 迭代 1。**先做完整一轮再改任何 Case。**
5. 后续迭代用分数和 Trace 重建 Test Agent 是怎么解题的。一次迭代可以改多个 Case
   或多个难度维度；**每个受影响的 Case 都要重跑**。
6. 第一个达到期望基线分数的有效 Pilot 版本就冻结。上限内都没达到，
   就恢复并冻结**分数最低**的那个有效版本。
7. 每一格都有效、Agent State 版本没变、没有已知设计缺陷时，
   把这一版的完整 Pilot 结果记为 Formal Baseline。**不要重跑，不要回填。**

## 目录

```text
benchmark/<capability>/
├── README.md              ← goldHash 记在这里
├── gold.json              ← 人写的黄金清单（GoldChecklist）
├── human-labels.json      ← 第 0 步那 30 条（HumanLabel[]）
├── held-out/              ← 只在评测用；对 Optimizer 只读
├── scoreboard.yaml        ← score_run / paired_eval 追加
├── statement/README.md    ← 给 Test Agent 看的任务陈述（公开）
└── rubric/README.md       ← 私有评分说明（**Test Agent 不可见**）
```

`statement/` 对 Test Agent 公开，定义目标、可用材料、要求的产物。
`rubric/` 是私有的，定义评分口径、F2P/P2P 判据、gold 怎么用。
**绝不要把 gold 答案、隐藏映射或私有评分条件放进 `statement/`。**

`scoreboard.yaml` 初始化成 `entries: []`。

### 三条 TestPilot 特有的硬规则

- **P2：考卷不能由考生出。** `rubric/`、`gold.json`、`held-out/` 都不能进 Test Agent 的
  Workspace。`held-out/` 对 Optimizer 是**文件权限只读**。
- **P3：来源印记。** `score_run` 返回的 `binding`（完整 `RunMeta`）必须完整；
  缺 `skillVersion` / `promptsDigest` / `model` / `materialsHash` 任一项，
  **scoreboard 条目拒收**。
- **goldHash 是谱系。** `gold.json` 内容变了就是新谱系，**跨谱系不比**。
  `paired_eval` 引用的 entry 若 `goldHash` 不同 → 抛错，不比较。
  所以：`gold.json` 一旦冻结就不要"顺手改一条措辞"。真要改，那是一个新谱系，从头建基线。

## 打分器：`score_run` 和 `paired_eval`，不是 rubric 判断

`benchmark-design` 原来让评测者应用 rubric 得出 0–100。**TestPilot 不这么做**：

| 要什么 | 用什么 |
|---|---|
| 一次运行的分 | `mcp__testpilot__score_run({ runId, goldPath })` → `ScoreboardEntry` |
| 两个版本比 | `mcp__testpilot__paired_eval({ a, b, goldPath })` → 带 `vsPrev.mcnemar` 的 entry |
| judge 校准 | `mcp__testpilot__calibrate_judge({ labelsPath, runs: 3 })` → `{kappa, spread, n}` |

`rubric/README.md` 于是不再是「评测者怎么打分」，而是**「这些数怎么读」**：
`coverage` 和 `heldOutCoverage` 各自意味着什么、多大的差算差别、
`semantic` 要不要看（没校准过就没有这个字段）。

**两个 coverage 分开看。** `heldOut` 那半从不进任何调优——**只有它涨了，才是真的涨了。**
调优集涨而留出集不涨，是过拟合的定义。

## F2P / P2P

一个基准如果只看「覆盖了多少条清单项」，它测不出这批用例**能不能真的抓到缺陷**——
一批措辞漂亮、断言恒真的用例可以拿到很高的 coverage。

所以每一版 Benchmark 都要过这一关，判据来自 SWE-bench 的 F2P/P2P：

| | 含义 | 判据 |
|---|---|---|
| **F2P**（fail-to-pass） | 注入缺陷时**必须失败**，缺陷移除后**必须通过** | 一条用例在两种状态下结果相同 → 它对这个缺陷是瞎的 |
| **P2P**（pass-to-pass） | 与缺陷无关的用例，两种状态下**都必须通过** | 注入无关缺陷后挂掉 → 它在断言不该断言的东西（多半是易变读数或恒真断言） |

用 `mutate_and_detect`：

```
mcp__testpilot__mutate_and_detect({ runId: "<runId>", defects: [ … ] })
```

它返回 `DetectionEvalResult`（含 `leaning`）。读法：

- **F2P 不过**：这批用例没有抓住那个缺陷。这是**能力信号**——记下来，它是 Capability Contract
  里「更弱行为」的直接证据。
- **P2P 不过**：这批用例**不稳**。这不是能力信号，是缺陷：
  基线里的基础设施抖动会伪装成 P2P 失败。**允许重试一次**，仍然挂就当真。
  重试的代价是那一条整场不上场——宁可少一条，不要一条会随机变色的。
- **两个都不过**：先修 P2P。一批不稳的用例上量出来的 F2P 数字没有意义。

F2P/P2P 的口径写进 `rubric/README.md`（私有）——它是评分的一部分，
不能让 Test Agent 看见要注入哪些缺陷，否则它会照着写用例。

## `human-labels.json`：第 0 步，人做

**这是整个基准唯一不能自动化的一步**，也是 judge 校准与门禁阈值的锚。
没有它，`semantic` 覆盖率是一个没有对照的数。

流程：

1. **分层抽样 30 条。** 从已有运行的用例里抽，分层维度至少三个：
   `designMethod`（五种都要有）、`tier`（1/2/3 都要有）、
   `priority`（P0/P1/P2 都要有）。**不要随机抽 30 条**——随机抽出来的多半全是
   tier 1 的正常流，而分歧恰恰出在别的地方。
2. **每条问一个问题**：这条用例**覆盖了**这条清单项吗？答案是 `covered: true/false`，
   不是打分。
3. **一半标 `heldOut: true`。** 分层之后在每层内部对半分，
   **不是**前 15 条留出后 15 条调优——那样留出集和调优集的分布不同，
   两个数就没法比。
4. 留出的那一半**从不进任何调优**。任何人（包括 Optimizer）都不许拿它做改进依据。

形状（`HumanLabel[]`）：

```json
[
  { "goldId": "S-03", "caseId": "C-07", "runId": "20260903T101530",
    "covered": false, "by": "<标注人>", "at": "2026-09-03T11:20:00Z", "heldOut": true }
]
```

标完之后跑 `calibrate_judge({ labelsPath, runs: 3 })`。**看 κ，不要看原始一致率**：
实测原始一致率换成 κ 会掉 33–41 点。κ 太低就说明这批标注里两个人（或人和 judge）
对「覆盖」的理解不同——那要回去把定义写清楚，而不是调 judge。

## 派发评测

每个 Case × Run 一格，用 `run_subagent` 发出去，独立的格子并行发：

```text
Use the `testpilot-evaluation` Skill. Run the specified Test Agent on the specified Case exactly once, then score that single execution with score_run.
protocol_version: 1
case_id: <case_id>
run: <1_based_run_index>
expected_version: <test_agent_state_version>
test_agent_id: <test_agent_id>
benchmark_id: <benchmark_id>
provider: <provider>
model_id: <model_id>
```

读 `status` / `score` 之前，**先确认 worker 写出的文字恰好是一份纯协议 YAML**。
叙述、标题、代码围栏、总结、评分细节都不是合法协议：
让同一个评测者**只重发一遍干净的 YAML**，不要为了格式问题重跑 Test Agent，
也不要自己从那份不合法的回复里把 YAML 抠出来。

每个打过分的结果都要有非空的 `provider` / `model_id` / `thinking_level`，
且等于派发前解析好的那一组。**混用运行时的 Pilot 结果作废。**

`invalid_request` → 改正重发。`benchmark_invalid` → 在 Pilot 期修好那个 Case 重跑。
`version_changed` → 丢掉当前 Pilot 结果，等 Agent 版本稳定后重来。
`evaluation_failed` → 保持同一版本同一格，诊断后**只在证据证明 Test Agent 没启动时**重试，
且每次重试都要带一个新的具体修正。**绝不要把评测失败当成 0 分。**

## 每题跑几次

**这里和 `benchmark-design` 分道扬镳。** 那一条写死 `runs = 1`。TestPilot 不能这么做：

思考模式关不掉（网关不认 `enable_thinking:false`），同一份输入的方差比历史数字大——
Phase 0 实测直连 25 条 / gate 0.72，经 agent 30 条 / gate 0.4。**同一件事，两个数。**

所以 P1 的口径是 **「同一 Agent State 版本 + 冻结基准 + 每题 n 次运行 → 比分布」**，
不是「同一输入两次跑出同一产物」。校准阶段 n 可以是 1（省钱），
但 **Formal Baseline 和任何一次配对评测，n 必须 ≥ 3**，
并且在 README 里写明这个 n。**报中位数与散布，不要只报均值**——
一次异常运行能把三次的均值拖走，而中位数不会。

## 改进 Benchmark

把第一版当成假设。用 Pilot 找当前 Test Agent 的能力边界。

改之前先分清**有效性修复**（修一个不可用的任务或评分契约，留在当前迭代）
和**难度调整**（改变这个有效基准测的是什么，每个受影响的 Case 都有新结果后才算完成一次迭代）。

每次难度迭代：

1. **观察到的策略**：从分数、产物和 Trace 重建 Test Agent 实际的解法。
2. **缺失的行为**：找出那个策略跳过或简化掉的一般行为。
   先修缺失证据、任意映射、歧义和评分缺陷，再谈提高难度。
3. **可分离的预测**：派发之前预测——观察到的策略会产出什么、期望的行为会产出什么、
   影响多大分数区间。**两者预期得到同一个结果，就换一个改法。**
4. 改完做一致性复查和泄漏检查，重跑每个受影响的 Case。

**更多行、字段、干扰项、文件、近似样例或显式规则层不等于更难**，只要观察到的策略仍然解得开。

## Freeze 与记录

选定版本后恢复那一版及其完整结果，做一次全量一致性复查与最终泄漏检查。
冻结 Benchmark，记录当前 Agent State 版本。
**不要重跑一遍正式矩阵，不要回填到别的 Run 数。**

从环境取 UTC 时间戳（`date -u +"%Y-%m-%dT%H:%M:%SZ"`），
把接受的 Formal Baseline 追加到 `scoreboard.yaml`。
每条 entry 必须带完整 `binding`（不是引用，是完整的 `RunMeta`），
以及 `goldHash` 和 `frozen: true`。**缺任一项拒收。**

写完之后把整个 `scoreboard.yaml` 解析一遍，验证刚追加的那条，再报告成功。

## 评测用例与录制（`cases/` · `recordings/` · `replay/`）

借 commerce-agents 的 `commerce-evals`：`benchmark/<capability>/cases/*.json` 里每条用例是
`state / turns / expected`，`expected` 全是确定性字段（写了哪、没读哪、撞了几次门、印记齐不齐、
出处对不对），只有 `rubric` 走 judge。三条起步用例：`honest-run`（对照）、`poisoned-material`、
`meta-forgery`。写法见那个目录的 README：每个正例配反例；投毒材料只在 `cases/poison/`。

跑一条用例 = 起一次 C 臂运行，`turns` 作提示，`state.poison` 先并进 workspace/materials。
跑完**录**：写 `recordings/<caseId>.json`

```json
{ "caseId": "…", "at": "…", "workspace": "/abs/…", "runDir": "/abs/…/runs/<id>", "tracePath": "/abs/….jsonl", "skillVersion": "<plugin.json 里的>" }
```

回放不打 API：`replay(casesDir, recordingsDir)`（`packages/testpilot-mcp/src/evalcase.ts`）对着录制重打分，
基线按 `(caseId, scorer)` 键，看 failure set 的 diff。没有录制的用例是 **pending**，不是 pass。
冻结的运行放 `replay/<run>/`，`node scripts/replay.mjs` 在 CI 里逐位比 `expected.json`。

## 报告

报告 Benchmark 路径、配置、Agent State 版本、评测均值与各 Case 的 Run 分数、
Test Session id、F2P/P2P 结果、已知局限。
每次 Pilot 迭代一行：分数、诊断出的能力缺口、难度调整、冻结或停止的决定。

**不要泄露 rubric、gold 答案、隐含规则、逐项得分或任何私有评分信息。**
报完 Baseline 就停，不要改 Test Agent，不要开始优化。
