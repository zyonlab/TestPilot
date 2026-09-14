---
name: testpilot-evaluation
description: Runs one specified TestPilot Test Agent on one Benchmark Case exactly once, scores that execution with the score_run MCP tool, and returns one protocol result carrying the tool's own output verbatim. Use it for a single evaluation request from a run_subagent caller; it replaces agent-evaluation for every TestPilot benchmark.
---

# TestPilot：一次评测

**自由度：low。** 这条 skill 存在的**唯一理由**是不让模型写分。
它替代 `agent-evaluation`：那一条让评测者自己应用 rubric 得出 0–100，
在 TestPilot 上这一步必须交给 `score_run`——分数是确定性算出来的，
优化器碰不到它，评测者也碰不到它。

处理来自 `run_subagent` 的**一个**评测请求：把指定的 Test Agent 在一个 Benchmark Case 上
跑一次，用 `score_run` 打分，回传一份协议结果。

上层的 Benchmark Designer 或 Optimizer 拥有所有 Case 与 Run 的循环、并发和后续处理。
本 worker **不处理别的 Case 或 Run，不启动别的评测者或子 agent，不修改任何 Agent 或 Benchmark，
也不写 `scoreboard.yaml`**。Penguin CLI 只用来启动指定的 Test Agent。

**静默工作。** 调工具时不要写进度说明。所有流式与最终回复里，
worker 自己写的文字**只能是最后那份纯协议 YAML**。
不要有叙述、标题、Markdown 围栏、总结、评分细节或任何别的文字。

## 分不是你算的

**这是本 skill 的中心。**

- 分由 `score_run` 返回。你把它**原样**放进协议结果。
- **不要复述**它，不要解释它为什么是这个数，不要说它高还是低。
- **不要改数字**：不要四舍五入到别的位数、不要归一化、不要"修正"一个看起来不对的值。
- `score_run` 拒绝打分（`RunMeta` 缺 `skillVersion` / `promptsDigest` / `model` /
  `materialsHash` 任一项）就返回 `evaluation_failed`。**绝不要自己补一个分顶上去。**
- 一次运行**产物不全**（缺 cases.json 等）同样是 `evaluation_failed`，不是 0 分。
  **评测失败不是零分**——把它记成 0 会让一次基础设施故障看起来像一次能力下降。

## 请求契约

每个字段恰好一个值：

```text
protocol_version: 1
case_id: <case_id>
run: <1_based_run_index>
expected_version: <tested_agent_state_version>
test_agent_id: <test_agent_id>
benchmark_id: <benchmark_id>
provider: <provider>
model_id: <model_id>
```

一个请求代表 Test Agent 的**一次**执行。`run` 标识这次执行，**不是重复次数**。
`provider` 和 `model_id` 都必须非空且指向那个确切的已配置模型。
字段缺失、重复或冲突 → 返回 `invalid_request`，**不要**创建 Workspace 或启动 Test Agent。

请求不完整或不自洽时通过协议返回 `invalid_request`，**不要**反过来问用户。

## 准备

用 Environment 里的 `App Data Dir`：

```text
TEST_AGENT_DIR = <app_data_dir>/agents/<test_agent_id>
BENCHMARK_DIR  = <repo>/benchmark/<benchmark_id>
```

拒绝路径穿越、符号链接逃逸，以及任何解析后落在被请求 Test Agent 之外的路径。
只查被请求的 Agent State、Benchmark 配置与 Case、隔离的 Test Workspace，
以及验证这次执行所需的 Trace。**永远不要读 Project 配置文件、凭证或 vault。**

必需：`agent_state/system_config.yaml`、`<benchmark_id>/statement/README.md`、
`<benchmark_id>/gold.json`。`run` 只是调用方给这次评测的标签，原样返回即可。

Agent State 顶层的 `version`（缺省为 1）必须等于 `expected_version`，否则返回 `version_changed`。
从这个 Target Agent 的配置里读并快照 `model.thinking_level`（字段缺席才用默认 `medium`）。

启动前把 Case 的 `statement/` 与 `rubric/` 下每个文件都快照一份。
在 `<test_agent_dir>/workspaces/` 下建一个唯一的 Workspace，解析成绝对规范路径，
并验证它仍在那个目录下。**只把 `statement/` 拷进去。**

**`rubric/`、`gold.json`、`held-out/` 绝不能进 Test Agent 的 Workspace。**
Test Agent 可以看见 Statement 和它自己的 State，但永远看不到评分口径、
黄金清单或留出集。这是 P2：考卷不能由考生出。

## 跑

用已验证的 Penguin CLI。先解析 `PROJECT_DIR`，再推导并验证 `PROJECT_ID`，
再推导并验证 `PENGUIN_HOME`——**分成独立的 shell 语句，按这个顺序**，
不要压到一行，不要在输入还不存在时就推导它。启动前确认 `PROJECT_ID` 等于
`PROJECT_DIR` 的 basename，`PENGUIN_HOME` 等于它的 dirname。

```bash
PROJECT_DIR="<app_data_dir>"
PROJECT_ID="$(basename "$PROJECT_DIR")"
PENGUIN_HOME="$(dirname "$PROJECT_DIR")"
export PENGUIN_HOME
penguin run \
  --message "Read README.md in the current Workspace and complete the task exactly as specified there." \
  --provider "<provider>" --model-id "<model_id>" --project-id "$PROJECT_ID" \
  --agent-id "<test_agent_id>" --workspace "<absolute_unique_workspace_path>" --approve allow-all
```

用确切的 Agent、Project、绝对 Workspace 路径和模型对。**两个模型参数一个都不能省**，
也不要回落到 Project 默认值。启动失败时，只有当**未改动的 Workspace 与 Trace 证据证明
Test Agent 根本没启动**才重试；每次重试都要基于新的诊断并应用一个具体的修正，
**绝不要原样重跑同一条失败的命令**。没有新的修复手段、需要外部配置、
或者不确定 Test Agent 有没有启动时，返回 `evaluation_failed`。

跑完之后验证 State 版本、配置里的 `thinking_level` 和两个目录快照都没变。
变了 → `version_changed`（前两者）或 `benchmark_invalid`（后者）。

## 打分：调工具，别自己判

在 Test Agent 的 Workspace 里找到这次运行的 `runs/<runId>/`，然后：

```
mcp__testpilot__score_run({ runId: "<runId>", goldPath: "<benchmark_dir>/gold.json" })
```

它返回一个 `ScoreboardEntry`（未 frozen），里面有 `coverage`、`heldOutCoverage`、
`binding`（完整的 `RunMeta`），校准过的话还有 `semantic`。

**这就是分。** `score` 字段取 `coverage`，按 `0..100` 的刻度就是 `coverage × 100`，
**保留两位小数，不做别的加工**。

`score_run` 抛错 → `evaluation_failed`，失败原因原样带回（但不要带任何 rubric 内容）。

`duration_ms` 取自根 Test Session。`cost` 只从那个 Session 及其直接引用的子 Trace 里
**已经记录好的**最终累计用量或成本算；**绝不要去查价目表或按外部价格推算**。
数据拿不到就写 `cost: null`——**缺成本不影响分数有效性**。

## 回传

把要求的 YAML 作为 worker 唯一写出的文字返回。**不要用反引号或 Markdown 围栏包住它。**

调用方说格式不合法时，用这个 Session 里已有的结果**只重发一遍干净的协议 YAML**：
不要再调工具、不要重启 Test Agent、不要重新打分、不要加解释。

打过分的结果：

```text
protocol_version: 1
status: ok
case_id: <case_id>
run: <run>
expected_version: <version>
provider: <actual_provider>
model_id: <actual_model_id>
thinking_level: <configured_thinking_level>
score: <coverage × 100，两位小数>
cost: <number_or_null>
duration_ms: <non_negative_integer>
session_id: <test_session_id>
run_id: <runId>
coverage: <score_run 返回的 coverage，原样>
held_out_coverage: <score_run 返回的 heldOutCoverage，原样>
gold_hash: <score_run 返回的 goldHash，原样>
agent_state: <score_run 返回的 agentState，原样>
```

最后五行是 TestPilot 加的，`agent-evaluation` 没有：**它们是 P2 和 P3 的落点**。
`gold_hash` 变了就是新谱系，跨谱系不比；`agent_state` 是两臂唯一允许不同的那一件事。
两个 coverage 分开报，是因为 `held_out` 那半从不进任何调优——
**只有它涨了，才是真的涨了。**

评测失败：

```text
protocol_version: 1
status: failed
case_id: <case_id_or_null>
run: <run_or_null>
expected_version: <version_or_null>
provider: <provider_or_null>
model_id: <model_id_or_null>
thinking_level: <thinking_level_or_null>
failure_code: <stable_failure_code>
```

四个失败码：

- `invalid_request`：请求不完整或不自洽。
- `benchmark_invalid`：Statement、gold.json 或评分契约无效。
- `version_changed`：Test Agent 版本与请求不符，或在评测过程中变了。
- `evaluation_failed`：启动无法安全修复，或 Trace 绑定 / `score_run` 失败。

失败时**绝不要**带上分数、成本、时长、Session id、私有数据或优化建议。
