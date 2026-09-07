# design 阶段基准

**测哪条 skill：** `designCases`（`testpilot-generate` 里写文本用例的那一步；对应 pipeline 节点 `design`）。

**冻结了什么：** `design` 的上游产物——`nodes/spec.json` + `nodes/stories.json`。
一份冻结的 spec+stories 喂给多个 design 候选，候选之间的分差就归到 design 那一版改动身上。

**量什么：** 给定同一份 stories，design 写出的 cases 覆盖了多少条**该覆盖的验收标准**。
用的尺子是上一层那份整流水线 gold 的同一批清单项，但打分时对着**冻结的 stories** 起跑
（`from:"design", frozenInputsDir`），所以量出来的纯是 design 的手艺，不掺 stories 拆得对不对。

## 现在的状态

| 文件 | 状态 |
|---|---|
| `gold.draft.json` | **草稿，未复核。** 从 `../../gold.draft.json` 派生的 12 条 |
| `gold.json` | **还不存在。** 人复核完 draft 才有——在此之前 `score_run` 没有可打的分 |
| `frozen-inputs/` | **空**（只有 README）。要一次真实运行的 `nodes/spec.json`+`nodes/stories.json` |

fail-closed 和上层一致：没人看过的 `gold.json` 会给一个看起来正常、其实不代表什么的覆盖率。

## inputHash

`inputHash` = 对 `frozen-inputs/` 里被冻结的上游产物（`nodes/spec.json`、`nodes/stories.json`）
做和 `materialsHash` 同一套内容哈希（逐文件 `相对路径 \0 内容 \0`，排序后 sha256 前 16 位）。

**现在算不出来**——`frozen-inputs/` 还是空的。冻结之后它由 `run_pipeline` 算出，写进这次运行的
`meta.json`，并进 `ScoreboardEntry.inputHash`。冻结产物一旦定下，把值记在这里：

```
inputHash: <待冻结后回填>
```

它变了就是**换了输入的另一场实验**：`paired_eval` 拒绝把两个 `inputHash` 不同的候选相比。

## 怎么跑

```
# 冻结上游（跑到 stories 停，把 nodes/ 复制进来）
run_pipeline({ stage:"g1", materialsDir:"<binance materials>", outDir:"runs/freeze", stopAfter:"stories" })
cp runs/freeze/nodes/spec.json runs/freeze/nodes/stories.json frozen-inputs/nodes/

# n≥3 个 design 候选，同一份冻结输入
run_pipeline({ stage:"g1", from:"design", frozenInputsDir:"<此目录>/frozen-inputs",
               outDir:"runs/cand-1", skillVersion:"…", materialsDir:"<binance materials>" })

# 打分 / 配对
score_run({ runId:"runs/cand-1", goldPath:"<此目录>/gold.json" })
paired_eval({ a:"runs/base-1", b:"runs/cand-1", goldPath:"<此目录>/gold.json" })
```

`materialsDir` 仍要给：`run_pipeline` 用它算 `materialsHash`（来源印记的一部分），
即便 `design` 这一步的输入来自 `frozenInputsDir`。

## 为什么这一层能有尺子而 stories / scanner 不能

覆盖率量的是「该被想到的验收标准有没有被写进用例」——那正是 **design 的产物**（cases）
能直接对照的东西。stories 的产物是「拆出来的故事」，scanner 的产物是「审计发现」，
两者都没有现成的清单能确定性地对照（见各自 README）。所以 design 是三层里唯一能
**直接**复用整流水线 gold 的一层。
