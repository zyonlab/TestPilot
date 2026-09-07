# frozen-inputs/（scanner 阶段）

这里放一批**固定的 cases**，让 `testpilot-scanner` 反复审同一批：

```
frozen-inputs/
└── cases.json     一次运行产出的 cases，定住不动
```

（也可以放 `nodes/design.json`——scanner 读的是用例集本身，两种形状取一即可。）

## 怎么产生

从任意一次跑完的运行里把 `cases.json` 复制进来：

```
cp runs/<某次运行>/cases.json <此目录>/
```

选一批**有代表性**的 cases——最好里面既有干净的，也有已知带病的（恒真断言、
钉在易变读数上的），这样才量得出 scanner 抓不抓得住。

## 和 stories/design 不同：不走 run_pipeline

scanner 不是流水线节点，不经 `run_pipeline({ from, frozenInputsDir })`。这一层的
「冻结」只是把 cases 定住；`inputHash` 用 `inputHashOf` 手动算一次，记进 `../README.md`。

## 现在是空的

等一批值得审的 cases（最好来自对 binance 的真实运行）冻进来。
