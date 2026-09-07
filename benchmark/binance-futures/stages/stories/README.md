# stories 阶段基准

**测哪条 skill：** `planStories`（`testpilot-generate` 里从材料拆用户故事的那一步；pipeline 节点 `stories`）。

**冻结了什么：** `stories` 的上游产物——`nodes/spec.json`（`composeSpec` 的输出，即 `docs`→`spec` 之后那份）。
一份冻结的 spec 喂给多个 stories 候选，候选之间的差就归到 planStories 那一版改动身上。

## ⚠️ 这一层的尺子还没有实现

design 层能直接复用「验收标准覆盖率」，因为 design 的产物（cases）能逐条对照清单。
**stories 的产物是「拆出来的故事」，没有现成的确定性清单能对照它。** 所以这里
**先不放 `gold.json`**（放了也是硬编一个测不出东西的假尺子，违反 fail-closed）。

### 打算怎么量：gold 项的 story 命中率

整流水线那份 gold（`../../gold.json`，定稿后）里每条清单项都带一个 `story` 字段
（如 `S-01`），指向它**应当由哪条用户故事覆盖**。于是一把自然的尺子是：

> planStories 拆出的故事集，能对上多少条 gold 项所要求的 `story`？
> = 命中的 `story` 数 / gold 里出现过的不同 `story` 数。

要落地它还差两件没定的事，**别在定之前硬编**：

1. **「对上」怎么判定。** 拆出来的故事 id 是 `story_1`、`story_2`…（探索/生成器自起），
   和 gold 的 `S-01` 不是同一套命名。需要一条确定性的对齐规则（按标题关键词？按覆盖的
   路由/转移？），而这条规则本身要人复核——否则又变成一把模型说了算的尺子。
2. **一份 `gold-stories.json` 的形状。** 大概是 `[{ story:"S-01", mustCover:[路由/转移 id], anyOf:[标题关键词] }]`，
   但要等对齐规则定了才知道该带哪些字段。

### 在尺子落地前的退路：下游冻结

不必等这把尺子。换一版 stories，**design 用旧版跑**，看**端到端**覆盖率（对 `../../gold.json`）
动没动——把 stories 的好坏折射到最终数字上。这就是「下游冻结」：

```
# 候选 stories → 冻结它 → 用旧版 design 跑到底 → 对整流水线 gold 打分
run_pipeline({ stage:"g1", from:"stories", frozenInputsDir:"frozen-inputs", outDir:"runs/story-cand-1", … })
score_run({ runId:"runs/story-cand-1", goldPath:"../../gold.json" })
```

代价：这个数掺了 design 的手艺（虽然 design 版本固定），不如独立尺子干净；好处：现在就能跑。
详见 `../../../../docs/v3/04-单skill进化.md`。

## inputHash

冻结之后，`inputHash` = 对 `frozen-inputs/nodes/spec.json` 做和 `materialsHash` 同一套哈希，
由 `run_pipeline` 算出并写进 `meta.json` / `ScoreboardEntry`。现在 `frozen-inputs/` 是空的，算不出。
冻结后回填：

```
inputHash: <待冻结后回填>
```

## 现在的状态

| 文件 | 状态 |
|---|---|
| `gold.json` | **不做**——尺子未实现，见上。硬编一份等于放一个测不出东西的假尺子 |
| `frozen-inputs/` | **空**（只有 README）。要一次真实运行的 `nodes/spec.json` |
