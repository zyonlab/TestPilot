# 留出集

**对 Optimizer 只读。** 只有 `score_run` / `paired_eval` 读这里。

两样东西的留出：

1. **gold 的留出项**——就在 `../gold.json` 里，标成 `heldOut: true` 的那 4 条。
   `scoreCoverage` 会把它们单独算成 `heldOutCoverage`。
2. **human-labels 的留出副本**——`human-labels.json`，由 `appendLabels` 在人标注时
   自动写一份进来（`heldOut: true` 的那些）。**复制而不是移动**：
   审计台要能读回全部标注来显示进度，评测只读留出的那一半，两个用途两个位置。

## 规矩

留出的那一半**从不进任何调优**。这是它存在的全部意义：
`coverage` 会被拟合，`heldOutCoverage` 不会。**只有 `heldOutCoverage` 涨了，才是真的涨了。**

`coverage` 涨而 `heldOutCoverage` 不涨 = 过拟合，这就是它的定义。
