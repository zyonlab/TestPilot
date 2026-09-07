# `cases.json` 的形状

权威定义是 `packages/harness-testing/src/casegen/types.ts` 里的 `CaseBundleSchema`，
写盘时有 hook 拿它校验。这里给的是**同一件事的 JSON 示例**。

```json
{
  "origin": "materials/acme-portal.md",
  "derivedFrom": "document",
  "stories": [
    { "id": "US-01", "title": "结账时被告知漏填了什么", "acceptance": ["Given … / When … / Then …"] }
  ],
  "flows": [
    { "id": "F-1", "name": "结账", "transitions": ["/cart.html->/checkout-step-one.html"] }
  ],
  "cases": [
    {
      "id": "C-01",
      "storyId": "US-01",
      "title": "不填姓氏点 Continue 被拒绝",
      "designMethod": "negative",
      "priority": "P1",
      "precondition": ["购物车里有一件商品", "已进入 Checkout: Your Information"],
      "steps": ["填入 First Name「John」", "留空 Last Name", "点「Continue」"],
      "postSteps": [],
      "expected": "页面显示「Error: Last Name is required」",
      "tier": 1,
      "oracle": { "kind": "text", "value": "Error: Last Name is required" },
      "key": "checkout-step-one|last-name-empty|error-shown",
      "covers": ["/checkout-step-one.html->/checkout-step-one.html"],
      "sourceRefs": ["materials/acme-portal.md#4"]
    }
  ]
}
```

## 硬约束（hook 会拒的那些）

| 字段 | 规则 |
|---|---|
| `cases[].id` | 非空 |
| `cases[].storyId` | 非空。指向 `stories[]` 里真实存在的 id——指不到的会被门禁记 `traceability` |
| `cases[].title` | 非空 |
| `cases[].designMethod` | 只能是 `equivalence` / `boundary` / `state-transition` / `decision-table` / `negative` |
| `cases[].steps` | **至少一个**元素，每个元素非空字符串 |
| `cases[].expected` | 非空 |
| `cases[].tier` | 只能是 1 / 2 / 3 |
| `cases[].key` | 非空 |
| `cases[].postSteps` | 字符串数组（可以是空数组）；每个元素非空 |
| `cases[].oracle` | 可选；给的话必须有 `kind` 和 `value`，`kind` 是那五种之一 |
| `cases[].priority` | 可选，但**应该每条都给**；只能是 `P0` / `P1` / `P2` |
| `cases[].covers` | 字符串数组（可以是空数组） |
| `cases[].sourceRefs` | 字符串数组，**每条至少一个**，每个必须是这次运行里 `retrieve_spec` 返回过的段 id。形状层允许空数组（A 臂旧运行兼容），但 hook 会拒空的与对不上的 |

**`steps` 空数组这件事有历史。** JSON schema 那边一度允许空数组、zod 这边写着 `.min(1)`，
于是模型产出空 steps、解析时被拒——**整个故事的产出一条不剩**，
一次运行里八条故事全军覆没。规矩是：**约束和校验必须说同一件事。**
现在 hook 在写盘之前就校验，所以你还在场，还能改。

## 出处（`sourceRefs`）hook 怎么核对

写盘前 hook 读这次运行的 trace，收集 `retrieve_spec` 每次返回的段 id，作为「取过的段」；
每条用例的 `sourceRefs` 必须是它的子集。三种拒绝：

| 情形 | 拒绝理由里会说 |
|---|---|
| 这次运行一次都没调 `retrieve_spec` | 先读再写：先取规格，再写用例 |
| 有用例 `sourceRefs` 为空 | 哪几条用例没有出处 |
| 有 id 不在取过的段里 | 哪几条用例、哪几个 id；用 `chunkIds` 取回来再引用 |

它**不**判断「这段规格是否真的支持这条断言」——那是 judge 与人的事。它只判 id 是不是真的。

## `id` 谁来给

`cases[].id` 你自己编（`C-01`、`C-02`……），但**同一批里不能重复**：
门禁的 `scoreBasis.flagged` 是一个 id 集合，重复 id 会让「几条被点到」这个数字错掉。

## 门禁会看的那些（形状合法但会被扣分）

写完之后门禁① 会跑（一个 hook，规则来自 `gate.ts`，和 A 臂 `run_pipeline` 用的是同一份）：

| 规则 | 它在挑什么 |
|---|---|
| `traceability` | `storyId` 指向不存在的故事 |
| `granularity` | 步骤超过 8 步 / 没有步骤 |
| `oracle-vague` | 断言用了「正常」「合理」「符合预期」这类词，或者点名不出任何可观察的现象 |
| `oracle-volatile` | 断言钉在会自己变的读数上（时刻、多位小数百分比、千分位大数） |
| `tier-unbacked` | 声称 tier 1/2 却没有 `oracle` |
| `duplicate` | 两条用例的 `key` 相同 |
| `negative-ratio` | negative + boundary 占比低于阈值（默认 0.3） |
| `story-uncovered` | 有故事一条用例都没有 |
| `covers-unknown` | 声称覆盖了规格里没有的转移 |
| `method-mismatch` | 标了某个方法，但用例里找不到那个方法的任何痕迹 |
| `no-cleanup` | 写了东西却不收拾 |
| `secret` | 步骤里写了明文凭证 |

分数 = `1 −（被 warn 点到的用例数 ÷ 全部用例数）`。
**这个分不是证书，是一个会在版本之间移动的数。**
