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

## v2 设计证据（2026-09-11，docs/v3/history/21 §2 与 §5）

下面八个字段**都是可选的**，一个默认值都没有——「没给证据」和「给了空证据」在归档里必须分得开。
但只要给了，服务端就会确定性地核对；对不上直接拒绝写入，并指出是哪一条、哪个字段路径。

```json
{
  "acRefs": ["AC-TITLE-MAX"],
  "conditionRefs": ["COND-SIGNED-IN"],
  "scenarioType": "positive",
  "design": {
    "technique": "boundary",
    "ruleId": "R-TITLE-LENGTH", "dimension": "标题长度", "unit": "字符",
    "bound": "250", "inclusivity": "inclusive", "step": "1",
    "points": [{ "at": "at", "value": "250" }, { "at": "above", "value": "251" }]
  },
  "risk": { "impact": "data-integrity", "reason": "超长标题被静默截断会丢掉用户输入", "ruleRefs": ["R-TITLE-LENGTH"] },
  "testData": { "fixtureRef": "seeded-project-v1", "values": [{ "name": "title", "value": "250 个字符的标题", "unit": "字符", "source": "R-TITLE-LENGTH" }] },
  "assertions": [{ "id": "A-TITLE", "statement": "任务列表里新建的那一行显示完整的 250 个字符标题，结尾没有被截掉", "ruleRefs": ["R-TITLE-LENGTH"], "oracle": { "kind": "text", "value": "标题末尾-250" } }],
  "readiness": { "design": "candidate", "execution": "requires-fixture", "reason": "缺一个预置好的项目 fixture" }
}
```

> `assertions[].oracle` 和顶层 `oracle` 是同一套判据，**同样只能从屏幕读**（CLAUDE.md 红线；
> 门禁规则 `oracle-offsite` 两边都查）。2026-09-13 之前这里的示例写的是 `kind: "api"`——
> 红线定了之后它没跟上，实测有用例照着它写出了断言被测站接口的判据，复核时被驳回。

| 字段 | 给了就会被核对的事 |
|---|---|
| `scenarioType` | 和 `designMethod` 分开：负例同样是用某种方法设计出来的。标了负向场景又标了方法，却不给 `design`，会被拒 |
| `design.technique` | 必须和 `designMethod` 说同一种方法 |
| `design`（boundary） | `points` 里必须有 `at: "at"` 那一点——边界值分析的核心就是边界上那个值；`unit` 必填，数量的步长和价格的精度不能混用 |
| `design`（decision-table） | `assignment` 的键必须**正好**是自己列出的 `conditionIds`：多一个、少一个都会被拒。一张有空格的判定表说不出这一行测的是什么 |
| `design`（state-transition） | `transitionIds` 必须也出现在 `covers` 里，两处说的是同一批边 |
| `risk` | 有 `risk` 就必须有 `priority`——理由不能解释一个不存在的判断 |
| `assertions` | id 不重复；声称 tier 1/2 时，断言自己或用例本身至少有一个判据；断言默认在**最后一步之后**判，描述途经那一屏的写 `afterStep`（从 1 数，≤ 步骤数）；「开放问题 / 待确认」不是断言，写进 `readiness.reason` |
| `readiness` | `execution` 不是 `ready` 时必须写 `reason`，否则它和「忘了填」分不开 |

**一个追不回来源的边界、步长或常数，不要写进用例。** 宁可留空——服务端对「缺字段」和「编造的字段」处理方式不同，
前者只是缺口，后者是错误。

## 硬约束（hook 会拒的那些）

| 字段 | 规则 |
|---|---|
| `cases[].id` | 非空 |
| `cases[].storyId` | 非空。指向 `stories[]` 里真实存在的 id——指不到的会被门禁记 `traceability` |
| `cases[].title` | 非空 |
| `cases[].designMethod` | 只能是 `equivalence` / `boundary` / `state-transition` / `decision-table` / `negative` / `exploratory` |
| `cases[].steps` | **至少一个**元素，每个元素非空字符串 |
| `cases[].expected` | 非空 |
| `cases[].tier` | 只能是 1 / 2 / 3 |
| `cases[].key` | 非空 |
| `cases[].postSteps` | 字符串数组（可以是空数组）；每个元素非空 |
| `cases[].oracle` | 可选；`kind` 是 `REFERENCE-oracle.md` 列的那几种之一。程序能判的几种要有 `value`；tier 3 写 `none`，生成内容写 `judge`（带 `criteria`，没有 `value`） |
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
