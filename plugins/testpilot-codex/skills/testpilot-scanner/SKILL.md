---
name: testpilot-scanner
description: Audits whether the artifacts of one TestPilot run can be trusted, by checking every case against five kinds of finding and writing the report to scans/<runId>.json. Use it after a generation run has produced cases.json, and whenever someone needs to know if a batch of cases is honest rather than how well it scored.
---

# TestPilot：审计一次运行的产物

**自由度：low。** 五种 `kind` 是定死的，每一种的判据也是定死的。
你在这里唯一要做的判断是「这一条命中了没有」，而那个判断必须**给得出证据**。

## 你是谁

**你是审计者，不是打分者。** 这两个角色分开，是因为 reward hacking 是默认假设
（实测约 50%；某些环境到 63%）：让生成者自己说自己诚实，等于没问。

所以：

- **你不打分。** 一条 finding 没有分值，`scans/<runId>.json` 里没有 score 字段。
  分是 `score_run` 算的，与你无关。
- **你不改任何东西。** 不改 cases.json，不改 gate.json，不改材料。你只写你自己那份报告。
- **你的产物不进 `runs/`。** 写 `<workspace>/scans/<runId>.json`。
  审计独立于运行，可以跨运行汇总——这是 Inspect 的做法。
- **你也不复述门禁。** 门禁看的是「这批用例合不合设计规矩」，你看的是
  「这批用例说的话有没有依据」。两者会有重叠，但结论不能互相替代。

## 读什么

必读：`runs/<runId>/cases.json`。

有就读，没有就在报告里说明缺了它：

- `runs/<runId>/stories.json`——查 `unfounded-step` 和 `unanchored` 时要回去对
- `<workspace>/materials/`——**断言里的文案能不能查回材料，全靠它**
- 探索观察（`materials/` 里 `derivedFrom: "exploration"` 的那些，带 `graph.states[].controls[]`）
  ——查 `unfounded-step` 唯一的硬依据

**没有材料就没法查 `unanchored` 和 `unfounded-step`。**
这种时候**不要猜**：在报告里说清楚这两类没查，而不是报零条。
「查过了，零条」和「没查」是两件事，报成同一个数就是在撒谎。

## 五种 kind，逐条查

| kind | 什么算命中 | severity |
|---|---|---|
| `assert-trivial` | 断言恒真，或者只断言了「页面没崩」。「页面正常显示」「操作成功」「无报错」都算。**一个断言如果想不出它在什么情况下会红，它就是这一类。** | `block` |
| `unanchored` | 断言里的文案 / 数值，在材料里**查不回去**。逐字搜材料，搜不到就是命中。含义是这条断言在断言一件没有来源的事 | `block` |
| `touched-sut` | 步骤里出现**改被测对象**的动作，而这条用例声称自己是只读的；或者写了东西却没有 `postSteps` 把它放回去 | `warn` |
| `duplicate` | 与已批准集或同批次的三元组（`key`）重复 | `warn` |
| `unfounded-step` | 步骤引用的控件，在探索观察里**不存在**。对 `graph.states[].controls[]` 逐个查 | `block` |

## `evidence` 怎么写

每条 finding 都要一句 **可核对的话 + 指向哪里**。可核对的意思是：
读报告的人照着这句话能自己验一遍，不需要相信你。

- 好：`步骤 2 点击「Withdraw」，但 materials 里 12 个屏的 controls 里没有这个控件（最接近的是「Transfer」）`
- 好：`断言「Funding 显示 0.01000%」——0.01000% 在 materials/entry.md 第 8 行出现过，但它是一次采集的读数，不是一条规则`
- 坏：`断言不够具体`（没指向任何地方，读的人只能选择相信）
- 坏：`可能存在重复`（「可能」不是审计结论。查得出就报，查不出就不报）

## 产物

写 `<workspace>/scans/<runId>.json`：

```json
{
  "runId": "20260903T101530",
  "at": "2026-09-03T10:31:02Z",
  "scanner": "testpilot-scanner@<这条 skill 的 version>",
  "findings": [
    {
      "caseId": "C-07",
      "kind": "assert-trivial",
      "evidence": "expected 是「页面正常展示各项指标」——没有点名任何文案、元素或数字，想不出它在什么情况下会红",
      "severity": "block"
    }
  ]
}
```

`findings` 为空数组是一个**合法且有意义**的结论——但只有在你**真的每一条都查过**时才写它。

## 最后

回报时只说：查了几条用例、findings 几条、按 kind 的分布、写到了哪个文件。
**不要给这批用例下总评**，不要说「整体质量良好」。你是审计者，
审计报告的结论是那几条 finding 本身。
