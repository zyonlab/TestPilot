# frozen-inputs/（design 阶段）

这里放 `design` 的**冻结上游产物**：

```
frozen-inputs/
└── nodes/
    ├── spec.json      composeSpec 的输出
    └── stories.json   planStories 的输出（design 真正读的那一份）
```

`run_pipeline({ from:"design", frozenInputsDir:"…/frozen-inputs" })` 会从这里读，
而不是从候选自己的 `outDir`。续跑只**读** `design` 的紧邻上游 `stories.json`；
`spec.json` 一并冻，是为了让 `inputHash` 覆盖整份被冻的上游（改了 spec 也该换实验）。

## 怎么产生

```
run_pipeline({ stage:"g1", materialsDir:"<binance materials>", outDir:"runs/freeze", stopAfter:"stories" })
cp runs/freeze/nodes/spec.json runs/freeze/nodes/stories.json <此目录>/nodes/
```

也可以连 `events.jsonl` 一起复制——`run_pipeline` 认它记的 `wrote`；没有事件流时按
固定约定 `nodes/<id>.json` 找，所以只复制 `nodes/` 也行。

## 现在是空的

`nodes/*.json` 要一次对 `demo.binance.com` 的**真实运行**才产得出，而那需要有效的会话导入
（`../../../statement/README.md` 与 `../../../README.md` 的三条前提）。Phase 1B 没有对这个站点真跑，
所以这里还没有产物，`inputHash` 也还算不出。冻结之后把 `inputHash` 回填进 `../README.md`。

## 冻的是「一份」，不是「分布」

思考模式关不掉，同一份 spec 两次会拆出不同的 stories。这里冻的 stories 只是**一个样本**。
要防在这一份上过拟合 design，退路是冻 3 份（各跑候选、合起来看），和 held-out 取样同理。
详见 `../../../../docs/v3/04-单skill进化.md`。
