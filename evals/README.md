# 评测集

这个目录是这个 harness 拿什么在考自己的**唯一**答案。

一份评测是一个文件，不是一次表单提交。此前一次配对评测的定义只活在那一次 HTTP 请求里：
跑完结果进了库，定义本身没有历史、进不了 review、没法 diff。于是「我们的判断依据是什么」
这个问题谁也答不上来，而一份可以被人随手改掉且不留痕迹的判断依据，不再是判断依据。

## 一个文件长什么样

```jsonc
{
  "id": "文件名（去掉 .json），两者必须一致",
  "title": "一句话说清在比什么",
  "why": "为什么问这个问题。必填，且不能只是复述标题。",

  "graphId": "g1-text-cases",
  "goldPath": "fixtures/mock-spec/gold-checklist.json",  // 可省，按图有默认
  "casesNode": "gate",                                    // 哪个节点的产物拿去打分

  "a": { "label": "现状", "ablate": [], "params": {} },
  "b": { "label": "改动后", "ablate": ["dedupe"], "params": {} },

  "expect": { "direction": "a-better", "note": "跑之前写下的预判" }
}
```

两组必须**只差一件事**。差两件事然后读一个数字，是一个项目说服自己相信假话的标准做法。


## 跑之前先看产物，别只看报告

2026-08-30 连着白跑了三次配对评测，三次的报告都**看起来完全正常**：门禁 1.0、
结构完整、零错误、McNemar 有数。三次都是跑完之后去数了一下产物的分布才发现白跑的。

三次的原因是同一件事的三种形状——**约束解码的 schema 里可选的键，模型直接不写**：

| 症状（报告上看不出来） | 真相 |
|---|---|
| 两臂 McNemar 完全一致 | `priority` 不在 `CASES_SCHEMA.properties` 里，两臂都产不出来 |
| 加进 properties 后仍然全空 | 在 properties 里但不在 `required`，这个模型跳过可选键 |
| 覆盖率在 0.111 和 0.556 之间乱跳 | `plan.stories` 只回一条故事、零条验收标准，模型随机挑中哪条决定一切 |

第三条最阴险：它看起来像**方差**。我一度把 0.556 vs 0.111 当成提示词的效应，还给它
编了一个机制。它不是效应，是 `acceptance` 可选造成的。

**这些字段在上一个模型（mimo）上都产得出来。**所以「可选键会被产出」从来不是这套代码
的保证，只是那个模型的性质——换端点会把它变成回归，而且是静悄悄的回归。

所以：**跑任何配对评测之前，先看一眼这一臂的产物长什么样。**

```bash
# 故事：几条？有没有验收标准？有没有角色？
curl -s localhost:5301/api/wf/runs/<id>/nodes/stories | \
  python3 -c "import json,sys;o=json.load(sys.stdin)['output'];ss=o['stories'];\
print(len(ss),'故事',sum(len(s.get('acceptance') or []) for s in ss),'验收',\
sum(1 for s in ss if (s.get('role') or '').strip()),'带角色')"

# 用例：优先级分布？带清理的几条？
curl -s localhost:5301/api/wf/runs/<id>/nodes/gate | \
  python3 -c "import json,sys,collections;o=json.load(sys.stdin)['output'];cs=o['cases'];\
print(len(cs),collections.Counter(c.get('priority') for c in cs))"
```

一条产出**全是同一个值、或者全是空**的字段，说明这一臂根本没在回答那个问题——
这时候两臂比出来的任何数都不属于它声称的自变量。

`packages/harness-testing/test/casegen.test.ts` 里有一组测试把 zod、提示词点名的字段
和三份 JSON schema 钉在一起（在不在 properties、在不在 required），漏一个就红。
那组测试是这三次白跑换来的。

## `expect` 不是断言

它不会让评测失败。一个会红的评测会被人调到绿为止，而那正是评测本该防住的事。

它只是被记下来，跑完和实际结果并排显示。**先写下预期再看它对不对，是评测唯一能防止自欺的
机制**；跑完之后再解释为什么这个结果是意料之中的，不是。预判错了不丢人，`"unknown"` 也是
一个诚实的答案——真正没有价值的是那种事后才成形、因而永远正确的预期。

## 消融开关

`ablate` 里只能写 `ABLATABLE`（`packages/harness-core/src/eval/ablation.ts`）里真的有节点在读
的名字。写一个没人读的开关，报告会显示「关掉它没有影响」——这句话是真的，但它说的不是
这个组件不重要，而是这个开关根本没接上。
