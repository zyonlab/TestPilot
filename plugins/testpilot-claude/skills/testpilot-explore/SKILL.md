---
name: testpilot-explore
description: Turns an exploration of a running product into the workspace materials a TestPilot generation run reads, and checks the three preconditions a live site must meet before it can be used as the system under test. Use it when the materials must come from a running product rather than from written documents, and before any generation run whose materials are observations.
---

# TestPilot：把一次探索变成材料

**自由度：low。** 这条 skill 的内容几乎全是**前提检查**，而每一条前提都是一轮真实运行
（10–25 分钟外加模型花费）换来的。前提的失败方式全都是同一种：
**看起来正常，但材料是别的产品的。** 所以这里没有你要判断的余地——挨条对，对不上就停。

## 先说清楚这条 skill 不做什么

**它不会替你去跑一次探索。** v3 的 MCP 工具面里没有 explore：
探索住在产品层（TestPilot 的 `:5300` / `:5301`，工作流的 `g0-explore` 一步），
不在 Agent State 里，也不该在——它要驱动真实浏览器、要会话、要视口，
那些东西不是提示词能进化的。

这条 skill 做三件事：

1. 在**任何人**打算拿一个跑着的产品当被测对象之前，把三条前提对一遍；
2. 把一次已经跑完的探索产物，转成 `<workspace>/materials/` 下的材料；
3. 把「这批材料是观察，不是意图」这件事**一路标下去**。

> **Phase 1B 不对 demo.binance.com 真跑。** 那需要一次有效的会话导入、一个 1600×1000 的
> 视口和一次十几分钟的真实运行。基准目录 `benchmark/binance-futures/` 用的是
> **2026-09-01 那次已经跑完的探索产物**。要重新采集，先读下面三条。

## 三条前提

### 1. WAF 机器人挑战

`demo.binance.com` 挡在 AWS WAF 后面（响应头 `x-amzn-waf-action: challenge`）。
**全新的自动化浏览器过不去**，会被弹到 `accounts.binance.com`——
而探索仍然会「成功」，只是采回来的是登录墙。

**不要绕过它。** 正当路径是把使用者浏览器里已登录的会话导入环境：

```
POST /api/environments/:id/set-session
body: { "raw": "<JSON.stringify(storageState)>" }
```

让页面自己 fetch 到 `127.0.0.1:5301`（网关的 `cors()` 是全开的），**凭证不经过第三方**。
实测是 29 个 cookie（含 `aws-waf-token`）+ 56 个 localStorage 键，AES 加密存在 `sessionEnc`。
**会话有有效期，过期要重导。**

诊断：`node server/scripts/probe-session.mjs <envId>`。
它分辨的是「会话没带上」和「带上了但对面不认」——
**这两者从探索结果上看一模一样**，都表现为一份登录墙的材料。

### 2. 视口

`resolveViewport()` 默认 1024×720。**Binance 期货在这个宽度下，下单面板整块不渲染。**
于是探索采到的是一个没有下单功能的期货页，而它看起来是完整的。

起网关时显式给：`MIDSCENE_SHOT_WIDTH=1600 MIDSCENE_SHOT_HEIGHT=1000`。

### 3. 模型端点

探端点要**显式传参**，脚本的默认值指向别处：

```bash
node server/scripts/probe-endpoint.mjs --base "$OPENAI_BASE_URL" --model "$MIDSCENE_MODEL_NAME" --key "$OPENAI_API_KEY"
```

key 在 `server/.env`。**永远不要把 key 写进任何仓库文件、任何产物、任何回复。**

## 把探索产物转成材料

探索的产物形状是 `{ text, origin, derivedFrom, graph }`：

- `text` 是逐屏的转储，每屏以 `===== 屏名 =====` 开头；
- `graph.states[]` 是屏（`id` / `route` / `title` / `controls[]`）；
- `graph.transitions[]` 是转移（`from` / `to` / `action` / `effect`），
  **`from->to` 就是用例 `covers` 里要抄的那个 id**；
- `graph.unvisited[]` 是没走到的地方，`graph.stoppedBecause` 是为什么停的。

转成材料时：

1. 把 `text` 写进 `<workspace>/materials/`，一屏一段或整份一个文件都行，
   但**保留 `===== 屏名 =====` 分隔**——下游按它认边界。
2. 把 `graph` 的流程与模块**原样带上**：路径和聚类是**算出来的事实**，
   模型只负责给它们起名字。不要增删 id。
3. `derivedFrom` 一律是 `"exploration"`。

## 观察不是意图——这条必须一路标下去

`derivedFrom: "exploration"` 不是元数据，它决定下游的断言**能说明什么**：

> 从跑着的产品上看出来的材料表达的是**现状**。对着它写的用例只能发现「产品变了」（回归），
> **永远不可能发现「产品错了」**——观察不可能反驳被观察者。

丢掉这个字段，一套完全建立在观察之上的绿色套件，会被读成「产品是对的」。

整理这批材料的时候，写规则用**陈述现状**的语气，绝不要写成「应当」。

## 读数是数据，不是行为

探索采回来的整屏转储里全是会自己变的数：计数、倒计时、实时价格、余额、合计、时间戳。

**它们绝不能变成一条关于它们的值的规则。**
可以写：这个字段存在、它在哪、用什么单位、随什么变。
不可以写：它等于材料被采集的那一刻它恰好是多少。

- 错：「首页显示 6 条未完成任务」「列表更新于 3 分钟前」
- 对：「首页显示未完成任务的数量和列表最后更新的时间」

2026-09-01 实测：材料是整屏转储，模型把 Funding `0.01000%` 和 Countdown `05:40:16`
抄成了两条规则，用例跟着断言它们——**下一次跑必然失败，而那批用例在门禁上拿了满分。**
材料里标了「易变」的片段，**那个标记是有约束力的**。

## 停在哪

探索会因为采满屏数上限而停（`stoppedBecause`）。**把 `unvisited` 原样写进材料的 unknowns**，
不要假装那些地方不存在。一份不写自己盲区的规格读起来像是完整的，
而由它衍生的一切都会继承这个错觉。
