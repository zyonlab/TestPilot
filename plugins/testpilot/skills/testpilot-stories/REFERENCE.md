# `stories.json` 的形状

权威定义是 `packages/harness-testing/src/casegen/types.ts` 里的 `StoryBundleSchema`，
写盘时有 hook 拿它校验。这里给的是**同一件事的 JSON 示例**——你要照着写的是这个，
不是 zod 源码。

```json
{
  "origin": "materials/acme-portal.md",
  "derivedFrom": "document",
  "specText": "（整理后的规格全文，可选；有就带上，设计用例那一步要读它）",
  "flows": [
    { "id": "F-1", "name": "结账", "purpose": "把购物车里的东西买下来",
      "steps": ["点 Checkout", "填写收货信息"],
      "transitions": ["/cart.html->/checkout-step-one.html"],
      "endsAt": "/checkout-complete.html" }
  ],
  "modules": [
    { "id": "m-checkout", "name": "下单与结账", "parentId": null, "kind": "module" }
  ],
  "stories": [
    {
      "id": "US-01",
      "title": "结账时被告知漏填了什么",
      "role": "购物者",
      "benefit": "不用猜是哪一栏出了问题",
      "flowId": "F-1",
      "activity": "下单与结账",
      "moduleIds": ["m-checkout"],
      "acceptance": [
        "Given 购物车里有一件商品 / When 用户不填姓氏就点 Continue / Then 页面显示「Error: Last Name is required」"
      ],
      "requirementId": "US-01",
      "source": "materials/acme-portal.md"
    }
  ]
}
```

## 硬约束（hook 会拒的那些）

| 字段 | 规则 |
|---|---|
| `stories` | **至少一条**。零条故事等于这一整批没了 |
| `stories[].id` | 非空字符串 |
| `stories[].title` | 非空字符串 |
| `stories[].acceptance` | 字符串数组，可以为空数组，但**不能缺这个键** |
| `derivedFrom` | 只能是 `document` / `exploration` / `codebase` 之一，或者不写 |

## 可选、但下游要用的

| 字段 | 谁在等它 |
|---|---|
| `role` / `benefit` | 门禁的 `story-no-actor`：两个都空会被挑出来给人看。**留空是答案，不是缺席** |
| `flowId` | 故事地图的纵轴挂点；门禁统计 `storiesAnchored` |
| `activity` | 故事地图的**横轴**。必须是模块名，且**比故事粗** |
| `source` | 材料是几份时，看覆盖有没有偏在第一份上 |
| `specText` | 设计用例那一步唯一能看见规格全文的通道。历史上它一直是空的，于是写用例的节点**从没见过规格**，只看得见故事标题和验收标准 |

## `derivedFrom` 为什么要紧

它决定下游的断言**能说明什么**：

- `document`：人写的，表达**意图**。对着它写的用例挂了，可能意味着「产品错了」。
- `exploration`：从跑着的产品上看出来的，表达**现状**。对着它写的用例只能发现「产品变了」，
  **永远不可能发现「产品错了」**——观察不可能反驳被观察者。
- `codebase`：从代码推的。介于两者之间。

丢掉这个字段，一套完全建立在观察之上的绿色套件，会被读成「产品是对的」。

## 产品结构与跨模块故事

`modules` 与 `stories` 是同一份产物。模块可用 `parentId` 引用上层模块，`kind` 为 `module`、`submodule`、`function`；根模块的 parentId 为空。层级来自实际材料，不能根据惯例补出未观察到的功能。Web 注册阶段拒绝重复模块 ID、循环及悬空父模块。

一条跨模块故事保留一个 `id`，用多个 `moduleIds` 引用有关模块，不为每个模块复制故事。旧产物仅有 `activity` 时，视图可以按模块名匹配，但不能声称那是模型明确给出的模块引用。
