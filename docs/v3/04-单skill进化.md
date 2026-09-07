# 单条 skill 独立进化

> Phase 3 的方法论核心：让 stories / design / scanner **各自**能被单独改进、单独度量，
> 而不是每次都动整条流水线、只看一个混在一起的端到端分数。
> 落点：`packages/testpilot-mcp/`（`run_pipeline` 的 `frozenInputsDir`、`contracts.ts` 的
> `inputHash`）与 `benchmark/binance-futures/stages/`。
> 依据：架构 §3（P1/P2/P3）、数据契约 §1（RunMeta）/§2（ScoreboardEntry、谱系判定）。

## 1. 问题

整条流水线是 `docs → spec → stories → design → gate`。从 `docs` 起跑、对一份 gold 量覆盖率，
答的是「这一整套好不好」。它**答不了「是哪一步变好了」**：一改，分动了，你分不清是 stories
拆得更准，还是 design 断言写得更硬——两件事混在一个数里。

单条 skill 进化要把某一步单独拎出来，其余**冻住**：给这一步一份**固定的上游产物**，只改这一步，
跑 n 次，比分布。

## 2. 五步

以 design 为例：

```
1. 冻结上游    run_pipeline({ stage:"g1", materialsDir, outDir:"runs/freeze", stopAfter:"stories" })
              cp runs/freeze/nodes/{spec,stories}.json benchmark/binance-futures/stages/design/frozen-inputs/nodes/

2. 改一个 REFERENCE   动 design 那条 skill 的一处提示词 / 自由度（换 skillVersion）

3. 跑 n 次     run_pipeline({ stage:"g1", from:"design",
                             frozenInputsDir:".../stages/design/frozen-inputs",
                             outDir:"runs/cand-1", skillVersion:"2026-09-04.1", materialsDir })
              ……重复 n≥3 次（候选臂），基线臂同样 n≥3 次

4. 配对评测    paired_eval({ a:"runs/base-k", b:"runs/cand-k",
                            goldPath:".../stages/design/gold.json" })   → McNemar

5. 前推        接受才把新版 design 前推、用它重新从 docs 跑一遍、重新冻结上游给下一轮
```

**接受才前推重新冻结**：一版 design 被 McNemar 判为真的更好，才把它设为新基线；新基线会改变
它下游的一切，所以要用新版从头跑、重新产出一份冻结上游，作为下一轮进化的起点。

## 3. 机制：`frozenInputsDir` 与 `inputHash`

### `run_pipeline({ from, frozenInputsDir })`

`from` 本来依赖同一个 `outDir` 里上一段留下的 `events.jsonl` + `nodes/*.json`（分段续跑）。
加了 `frozenInputsDir`：`from` 那一步的上游产物改从**这个目录**的 `nodes/*.json` 读，于是
**一份冻结的上游能喂给多个候选**（每个候选用自己的 `outDir`）。

- 续跑只**读** `from` 的紧邻上游（`from:"design"` 只读 `nodes/stories.json`）；`spec.json` 一并冻，
  是为了让 `inputHash` 覆盖整份被冻上游。
- 冻结目录常常只有 `nodes/`、没有 `events.jsonl`：认得 `events.jsonl` 里的 `wrote`，没有就按
  `nodes/<id>.json` 固定约定找。
- 校验：**给了 `frozenInputsDir` 却没给 `from` → 报错**（「冻结输入只在 `from` 指定了从哪步续跑时
  有意义」）。
- `materialsDir` 仍要给：`materialsHash`（来源印记）照算，即便这一步的输入来自冻结目录。
- 冻结起跑用**新 runId**、花费从 0 起（冻结上游的成本是共享的，不摊到候选头上）。

### `inputHash`（`contracts.ts`）

`inputHash` = 对被冻结的上游产物文件做**和 `materialsHash` 同一套哈希**（`inputHashOf`：逐文件
`相对路径 \0 内容 \0`，排序后 sha256 前 16 位）。由 `run_pipeline` 在冻结起跑时算出，写进
`meta.json`（`RunMeta.inputHash` / `RunMeta.frozenInputsDir`，两者都 optional），并进
`ScoreboardEntry.inputHash`。

它是 `goldHash` 之外的**第二条谱系判据**（数据契约 §2 的补充）：

| 两条条目 | 判定 |
|---|---|
| `inputHash` 都在、相同 | 同一份冻结输入的两个候选——**可比** |
| `inputHash` 都在、不同 | 喂了不同上游的两场实验——`paired_eval` **拒收** |
| 两条都无 `inputHash` | 老路：整条流水线从 docs 起跑，比整条流水线（与冻结机制上线前的旧条目兼容）|
| 一有一无 | 一臂冻结、一臂没冻结——不硬拒，`note` 里说明是混搭 |

`inputHash` **不进** `agentState`：它是**输入**，不是 agent 版本。`agentState` 仍只由
skillVersion + promptsDigest + params 定。两条条目要可比，需要 `agentState` 不同（就是那处改动）、
`goldHash` 相同、`inputHash` 相同。

## 4. 两个坎

### 坎一：冻结的是「一份」，不是「分布」

网关关不掉思考（`enable_thinking:false` 不认，架构 §9），同一份 spec 两次会拆出不同的 stories。
所以给 design 冻结的那份 stories 只是**一个样本**——在它上面调 design，调出来的可能是对
「这一份恰好好拆/难拆的 stories」的过拟合。

**退路：每份冻结输入取 3 份。** 分别冻 3 份上游，各跑候选，合起来看——和 held-out 每层内部
对半分同理（`benchmark/.../held-out/README.md`）。一份上的提升要在另外两份上也成立，才算 design
真的变好，而不是碰上了一份友好的输入。

### 坎二：stories / explore 还没有独立尺子

design 层能直接复用整流水线那份 gold（它的产物 cases 能逐条对照清单项）。**stories 不能**：
它的产物是「拆出来的故事」，没有现成的确定性清单对照（该量「gold 项的 `story` 命中率」，
但故事 id 是生成器自起的 `story_k`、和 gold 的 `S-xx` 不是一套，对齐规则要人定且要人复核——
否则又是一把模型说了算的尺子）。**explore**（走到的路由数）同理没实现。scanner 也没有
（该量「该报的 finding 报了没有」，需要一批人标的期望发现集）。三层的 README 只写清打算怎么量，
**没有硬编假尺子**（fail-closed，同 `gold.json` 的规矩）。

**退路：下游冻结。** 进化 stories 时，不等它的独立尺子——换一版 stories，**design 用旧版跑**，
看**端到端**覆盖率（对 `../../gold.json`）动没动。把 stories 的好坏折射到最终数字上：

```
run_pipeline({ stage:"g1", from:"stories", frozenInputsDir:"stages/stories/frozen-inputs",
               outDir:"runs/story-cand-1", skillVersion:"…", materialsDir })
score_run({ runId:"runs/story-cand-1", goldPath:"benchmark/binance-futures/gold.json" })
```

代价：这个数掺了 design 的手艺（虽然 design 版本固定），不如独立尺子干净。好处：现在就能跑，
不必等对齐规则落地。

## 5. 现在的状态（fail-closed）

- 机制（`frozenInputsDir` / `inputHash` / 谱系拒收）已实现、typecheck 与测试覆盖。
- `benchmark/binance-futures/stages/{stories,design,scanner}/` 目录与 README 已立。
- **冻结产物（`frozen-inputs/nodes/*.json`）全空**：要一次对 `demo.binance.com` 的真实运行
  （需要会话导入，见 `statement/README.md` 三条前提）。Phase 1B 没对这个站点真跑。
- `gold.json` **一律不存在**；design 层只有一份**未复核的 `gold.draft.json`**（从整流水线
  draft 派生，明确标 draft）。没人看过的尺子给出的是一个看起来正常、其实什么都不代表的数。
