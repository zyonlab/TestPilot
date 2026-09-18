# 基准：casegen（自举 / selftest-g1）

TestPilot 拿**自己的规格**当材料，考自己的生成器。仓库里唯一有冻结 gold、
能打分的基准（另一个 `../hyperliquid-testnet/` 是领域材料，只有草稿）。

它的材料是**人写的文档**（`derivedFrom: "document"`，表达意图），所以它能回答
「用例有没有对着意图去测」。2026-09-18 删掉的 `binance-futures` 那份材料是**观察**，
只能回答「产品变了没有」。

## goldHash

```
gold.json  sha256 前 16 位：2405209c3fe70ac7
完整       2405209c3fe70ac7020ed8cb53ef9619a2423aa3527da3ae31f1c84de251b799
```

**这份 `gold.json` 是从当时的 `fixtures/self-test/gold-checklist.json` 逐字节拷来的，一个字没改**（那份源文件 2026-09-18 随自举夹具一起删了，内容完整保留在这里）。
16 条，其中 4 条 `heldOut`。它的价值全部来自「它是人手工从
`docs/archive/spec/03-UI交互规格.md` 的断言点里抽出来的，没让模型生成」——
改动它就是新谱系（P2），所以这个哈希要和每条 scoreboard entry 对上。

`gold.json` 自己的 note 里还写着一句要紧的话：**「需要你复核后才算数，尤其是 heldOut 的四条。」**
那句话仍然成立——这份清单进了基准目录不等于它被复核过。

## 材料是哪一份：一处与任务书的偏离

任务书原计划让 `statement/` 把 `fixtures/sample-spec/acme-portal.md` 当材料引用。**没有这么做**，
理由是这两样东西对不上：

| | gold | 材料 |
|---|---|---|
| 这里的 `gold.json` | TestPilot 自己的界面（进程页、复核队列、审计台…），16 条 | `docs/archive/spec/02-业务规格与用户故事.md` + `docs/archive/spec/03-UI交互规格.md` |
| `fixtures/sample-spec/gold-checklist.json` | 一个购物门户（登录、购物车、结账），12 条 | `fixtures/sample-spec/acme-portal.md` |

拿 acme 的材料去跑 self-test 的 gold，**覆盖率恒为 0**——
不是因为生成器差，是因为考卷和材料是两个产品的。
那样的基准每次都给出同一个数字，而这个数字说明不了任何事。

所以：

- `statement/` 指向 **`docs/archive/spec/02 + 03`**，也就是这份 gold 真正抽自的地方。
- `fixtures/sample-spec/` 那一对（`acme-portal.md` + 同目录的 `gold-checklist.json`）
  **自成一对**，是冒烟材料。**Phase 1B 验证 C 臂那次跑用的就是它**——
  材料小、跑得快，适合验证管道通不通，不适合当基准。

## `human-labels.json`

空数组。**那是人的第 0 步**：30 条分层抽样、一半 heldOut，由审计台的「校准」tab 写入
（`server/src/audit.ts` 的 `appendLabels`，`POST /api/audit/:runId/labels`）。

`CAPABILITY` 默认就是 `casegen`（`server/src/audit.ts`），标注直接落在这里；
换基准要设 `TP_CAPABILITY`，并且别在一次校准跑到一半时改。

## `held-out/`

`gold.json` 里已经有 4 条标了 `heldOut: true`。
`held-out/` 目录是给 **human-labels 的留出副本**用的，由 `appendLabels` 自动写。
**对 Optimizer 只读**——见 `held-out/README.md`。

## 每题跑几次

同主基准：**Formal Baseline 与配对评测 n ≥ 3**，报中位数与散布。
思考模式关不掉，同一输入的方差比 `docs/spec` 里的历史数字大——
**那些历史数字不可比**，基线要在当前这套配置上重建。
