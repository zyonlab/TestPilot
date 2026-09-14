# 状态迁移（`designMethod: "state-transition"`）

**一句话**：产品从一个状态走到另一个状态，测**这次改变本身**，以及**改变之后必须成立的东西**。

## 怎么用

1. 说清楚**起点状态**（写进 `precondition`）。
2. 说清楚**那一个动作**（写进 `steps`）。
3. 说清楚**终点状态**，而且要说成一个能失败的断言（写进 `expected`）。
4. **把这次走的转移 id 抄进 `covers`。**

第 4 步是这个方法与别的方法最实在的区别：规格里的 FLOWS 下面每一步都带一个反引号包着的
转移 id（`` `/cart.html->/checkout-step-one.html` ``）。这条用例走了哪几步，
就把哪几个 id 逐字抄进 `covers`（去掉反引号）。

## 判据

- **一条用例一次迁移。** 连走五步再断言最后一屏，测的是那五步的**合取**，
  中间任何一步坏了都表现成同一个失败，而你分不清是哪一步。
- **终点状态不等于「页面跳转了」。** 跳转是一半，另一半是「跳过去之后什么必须成立」——
  新页面上出现了什么、旧页面上的什么消失了、哪个数变了。
- 门禁有一条 `no-transition`：标了 `state-transition` 却 `covers` 为空，会被记一条。
  **`covers` 为空不一定错**（规格里没有流程图时它必然是空的），但它意味着这条用例
  说不出自己走的是哪条边，于是它对结构覆盖率没有贡献。
- 逆向的那一条同样是迁移，而且常被漏：登录之后**登出**、加入之后**移除**、
  展开之后**收起**。它们往往是唯一在测清理路径的用例。

## 例

故事：「把商品加进购物车」。

```json
{
  "title": "加入购物车后徽章从 0 变成 1",
  "designMethod": "state-transition",
  "precondition": ["购物车是空的"],
  "steps": ["在商品列表点「Add to cart」"],
  "expected": "购物车徽章显示「1」",
  "tier": 2,
  "oracle": { "kind": "delta", "value": "cart", "direction": "increased", "by": 1 },
  "covers": ["/inventory.html->/inventory.html"],
  "key": "add-to-cart|single-item|badge-1",
  "postSteps": ["点「Remove」把这件商品移出购物车"]
}
```
