# 按阶段分的基准：让单条 skill 独立进化

`benchmark/binance-futures/`（上一层）是**整条流水线一份 gold**：从 `docs/` 起跑，
经 `docs → spec → stories → design → gate`，最后对着一份清单量覆盖率。它答的是
「这一整套 agent 好不好」。

它答不了「**是哪一步**变好了」。整条流水线一改，分动了，你分不清是 stories 拆得更准，
还是 design 断言写得更硬——两件事混在一个数里。单条 skill 进化要的是把某一步单独拎出来，
其余冻住。这一层就是为这件事存在的。

## 每一层是什么

```
stages/
├── stories/     进化 planStories（拆用户故事）——冻结 docs+spec，从 stories 起跑
├── design/      进化 designCases（写文本用例）——冻结 spec+stories，从 design 起跑
└── scanner/     进化 testpilot-scanner（审计产物）——冻结一批 cases，只跑审计
```

每层三样：

| | 内容 |
|---|---|
| `frozen-inputs/` | 这一步的**上游产物**，冻住（`nodes/*.json`）。同一份喂给多个候选 |
| `gold.json` | 只量**这一步**的那把尺子。**没人复核过就不存在**（fail-closed，同上一层） |
| `README.md` | 这层测哪条 skill、冻了什么、`inputHash` 是多少、怎么跑 |

## 怎么跑（三步，方法论核心）

以 design 为例：

```
# 1. 冻结上游（一次，跑到 stories 就停，把 nodes/ 复制进 frozen-inputs/）
run_pipeline({ stage:"g1", materialsDir, outDir:"runs/freeze", stopAfter:"stories" })
cp -r runs/freeze/nodes stages/design/frozen-inputs/

# 2. 同一份冻结输入，喂给 n 个 design 候选（改一个 REFERENCE / skill 版本，跑 n≥3 次）
run_pipeline({ stage:"g1", from:"design", frozenInputsDir:"stages/design/frozen-inputs",
               outDir:"runs/cand-A-1", skillVersion:"…", materialsDir })

# 3. 配对评测出 McNemar；接受才把新版前推、重新冻结
paired_eval({ a:"runs/base-1", b:"runs/cand-A-1", goldPath:"stages/design/gold.json" })
```

`run_pipeline` 给了 `frozenInputsDir` 会算一个 `inputHash`（冻结产物的内容指纹，
和 `materialsHash` 同一套哈希）写进 `meta.json`。它进 `ScoreboardEntry`，是 `goldHash`
之外的**第二条谱系判据**：两条条目 `inputHash` 都在且不同 → 喂了不同上游的两场实验，
`paired_eval` 拒收。同一份冻结输入的候选之间才可比。

## 两个坎（动手前先知道）

1. **冻结的是「一份」，不是「分布」。** 网关关不掉思考（`enable_thinking:false` 不认），
   同一份 spec 两次会拆出不同的 stories。所以给 design 冻结的 stories 只是**一个样本**。
   退路是每份冻结输入取 3 份（分别冻，各跑候选，合起来看），和 held-out 取样同理——
   不然你在一份恰好好拆/难拆的 stories 上调 design，调出来的是对那一份的过拟合。

2. **stories / scanner 还没有独立的尺子。** design 层有（就是把整条流水线那份 gold
   拿来只量 design 这一步，见 `design/README.md`）；stories 该量「gold 项的 story 命中率」、
   scanner 该量「该报的 finding 有没有报」——两把尺子**都还没实现**，只在各自 README 里
   写清打算怎么量。在它们落地之前，进化 stories 的**退路是「下游冻结」**：换一版 stories，
   design 用**旧版**跑，看**端到端**分数动没动——把 stories 的好坏折射到最终覆盖率上。
   详见 `../../../docs/v3/04-单skill进化.md`。

## 这一层现在的状态

**目录与说明先立着，尺子和冻结产物都还是空的。** 与上一层一样是刻意的 fail-closed：
- `frozen-inputs/` 里现在只有 README——真正的 `nodes/*.json` 要一次对 binance 的真实运行才能产出，
  而那需要有效的会话导入（见 `../statement/README.md` 与 `../README.md` 的三条前提）。
- `gold.json` 一律**不存在**（design 层只有一份**未复核的 draft**）。没人看过的尺子会给出
  一个看起来正常、其实什么都不代表的数。
