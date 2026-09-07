# scanner 阶段基准

**测哪条 skill：** `testpilot-scanner`（独立审计者，读一批 cases，产出 `scans/<runId>.json`
里的 `ScanFinding[]`——恒真断言 / 未锚定 / 动了被测对象 / 重复 / 步骤引用不存在的控件）。

**冻结了什么：** 一批**固定的 cases**（`cases.json`，或产出它的 `nodes/design.json`）。
同一批 cases 喂给多个 scanner 候选，候选之间的差就归到 scanner 那一版改动身上。

## 和 stories/design 的一处不同：不走 run_pipeline 的 from

`frozenInputsDir` / `from` 是 `run_pipeline` 内部续跑机制，只对流水线节点
（`docs/spec/stories/design/gate`）成立。**scanner 不是流水线节点**，它是一条独立 skill，
输入是一批已经产好的 cases。所以这一层的「冻结」是把那批 cases 定住，让 scanner 反复审同一批——
机制上不经过 `run_pipeline`，`inputHash` 也不由 `run_pipeline` 自动算（见下）。

## ⚠️ 这一层的尺子还没有实现

scanner 的产物是「审计发现」。要量它，得有一份**人标的**「这批 cases 里该报哪些 finding」：

> gold = 对冻结的那批 cases，人逐条标注的 `{ caseId, kind, severity }` 期望发现集。
> scanner 的分 = 该报的报了多少（recall）、报的里有多少是真的（precision）——
> 大概是对 `kind` 分层的 F1，或至少 block 级 finding 的召回。

**先不放 `gold.json`**（fail-closed）。要落地它还差没定的事，别硬编：

1. **期望发现集从哪来。** 只能人标：拿冻结的那批 cases，人过一遍，标出每条恒真断言、
   每处未锚定的数值。这批标注和 `human-labels.json`（覆盖率的锚）是两码事——那份标
   「用例覆盖了清单项吗」，这份标「用例本身有没有病」。
2. **precision/recall 怎么配。** scanner 宁可多报（block 拦住）还是宁可不吵（warn），
   两种倾向对应不同的加权。这要人定口径，写进（私有的）rubric。

### 在尺子落地前的退路

对固定的一批 cases，人工点验 scanner 两版的输出差异（哪些 finding 多了 / 少了），
先当定性对照用；等标注攒够再上确定性的 F1。

## inputHash

这一层冻结的是 cases，不经 `run_pipeline` 的 `frozenInputsDir`。要给它一个可比谱系，
用同一个 `inputHashOf`（`packages/testpilot-mcp/src/contracts.ts`）对 `frozen-inputs/` 里的
cases 文件手动算一次并记在这里：

```
inputHash: <待冻结 cases 后回填>
```

## 现在的状态

| 文件 | 状态 |
|---|---|
| `gold.json` | **不做**——尺子未实现（需要一批人标的期望发现集），见上 |
| `frozen-inputs/` | **空**（只有 README）。放一批固定的 `cases.json` |
