# frozen-inputs/（stories 阶段）

这里放 `stories` 的**冻结上游产物**：

```
frozen-inputs/
└── nodes/
    └── spec.json      composeSpec 的输出（planStories 读的那一份）
```

`run_pipeline({ from:"stories", frozenInputsDir:"…/frozen-inputs" })` 从这里读 `spec.json`。

## 怎么产生

```
run_pipeline({ stage:"g1", materialsDir:"<binance materials>", outDir:"runs/freeze", stopAfter:"spec" })
cp runs/freeze/nodes/spec.json <此目录>/nodes/
```

## 现在是空的

要一次对 `demo.binance.com` 的真实运行（需要会话导入，见上层 README 的三条前提）。
Phase 1B 没对这个站点真跑，所以还没有产物，`inputHash` 也还算不出。

## 冻的是「一份」，不是「分布」

`docs → spec` 也走模型，同一批材料两次 compose 出的 spec 可能不同。要防过拟合，
冻多份（各跑候选、合起来看）。详见 `../../../../docs/v3/history/04-单skill进化.md`。
