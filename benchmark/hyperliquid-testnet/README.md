# 基准：hyperliquid-testnet（领域层）

执行层的那 8 条 P0 在 `fixtures/hyperliquid-testnet/`（接口判据、缓存、账）。这里是**领域层**的东西：

| 文件 | 状态 |
|---|---|
| `materials/rules.md` | 人写的交易规则，每条带来源与日期。材料从「观察」变成「观察 + 规则」（07 T-11） |
| `gold.draft.json` | 2026-09-08 从 `rules.md` 机械导出的 12 条草稿（`reviewed: false`），只给 gold 屏复核用，**不能打分** |
| `gold.json` | **还不存在。** 人在 gold 屏复核草稿后才有；`heldOut` 标一半；冻结后记 `goldHash` |
| `stages/design/frozen-inputs/` | 配对评测冻结的上游产物（T-12），`run_pipeline stopAfter:"stories"` 生成 |
| `scoreboard.yaml` | 没有 gold.json 就没有条目 |

`gold.json` 不存在 ⇒ `score_run` 没有可打的分。这是刻意的 fail-closed（见 `benchmark/binance-futures/README.md`）。
**P2 不可让步：gold / human-labels / held-out / rubric 不进任何提示词，不被自动流程改写。**

## 规则怎么被用

`retrieve_spec` 索引 `materials/` 下所有文件，`rules.md` 的每段是一个可引用的段（`rules.md#N`）；
用例的 `sourceRefs` 指向它，出处核对（hook / `write_cases`）认它。材料是第三方文本，进模型前过 `retrieve/fence.ts`。
`materialsHash` 把它算进来：改一条规则就是新的一份材料。

规则只写**可核对的句子**：每条能变成一个 `kind: api` 或 `text` 判据。易变读数那一段是反向约束。
