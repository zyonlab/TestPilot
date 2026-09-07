---
name: testpilot-memory
description: Records what actually went wrong in one TestPilot run as episodic memory lines under agent_state/memory/user/testpilot-episodes.md, picking from candidates the extract_episodes tool computes from gate.json, holds.jsonl and the scan report. Use it at the end of a generation, exploration or audit run. Not needed for general rules about how to write test cases (those live in skills), for facts about the product (those are material), or when the run hit nothing.
---

# TestPilot：记这次踩到的坑

**自由度：medium。** 记哪几条由你判断；**每条长什么样、从哪来**是定死的。

## 只记 episodic，不记 semantic

这条区分不是风格偏好，是实测出来的：episodic 记忆（「这次跑到 X 时撞了 Y」）让下一次运行
+7.56%（p<0.001）；semantic 记忆（「写用例要注意 Z」）单独放进去 +3.67%，p=0.636——
和没放一样。通用规范已经在 skill 里了，再写一遍进记忆只会稀释那些真正有用的行。

## 每条从哪来：`extract_episodes`

**候选由工具算，不由你叙述。** 一次运行踩过什么坑，全在它的产物里：

| 产物 | 候选 |
|---|---|
| `runs/<runId>/gate.json` | 每条被 warn 点到的规则一条：命中几次、一条例子 |
| `runs/<runId>/holds.jsonl` | 每道拦过你的门一条：拦了几次、最后一次为什么 |
| `scans/<runId>.json` | 每种审计 finding 一条 |

```
mcp__testpilot__extract_episodes({ runId, runsDir: "<workspace>/runs", scanPath: "<workspace>/scans/<runId>.json" })
→ { runTag, candidates: [{ key, value, category, runTag, source }], lines: ["- [tag] gate/gate.oracle-vague: …"], skipped, cap }
```

`skipped` 里是被写过滤拒掉的候选（里面有凭证、邮箱、长串）——**不要把它们改写一下再记**。
`candidates` 为空就什么都不记：**空的一次记录比一条正确的废话有用。**

## 挑几条

- 从 `lines` 里**原样**挑最多 3 条。判据：下一次同样材料、同样 skill 的运行，看到这一行会少走哪一步？
  说不出来的不记。
- 优先级：`hold`（你撞了门）> `gate`（门禁点到的规则）> `scan`（审计发现）。撞门是这次运行独有的经验；
  门禁规则可能每次都点到，第二次记就是重复。
- 不改 `runTag`、不改 `key`，`value` 只许**删短**，不许加你的解释。
- 已经记过同一 `key` 的（读一下现有文件）不再记，除非 `value` 说的是另一件事。

## 写到哪、什么形状

文件：`<agent_state>/memory/user/testpilot-episodes.md`。一行一条，形状定死：

```
- [<8位runTag>] <gate|hold|scan|infra|material>/<key>: <value ≤ 200 字>
```

写盘时 hook `validate-memory.mjs` 逐行校验：形状对不上、或 value 里有 token / 邮箱 / cookie / 长串 /
带凭证的链接，整份拒。被拒就照理由改，不要换文件名写。

写完在 `MEMORY.md` 索引里加**一行**指向这个文件（已有就不加）。索引里最多列 8 条最近的经验；
更多的留在主题文件里按需读——进上下文的条数封顶，不是越多越好。

## 写完之后

只说记了几条、runTag 是什么。不评价这次运行。
