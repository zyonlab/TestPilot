# 05　子 Agent 与上下文隔离

> 这一章的结论和标题反着来：**这个系统里的上下文已经是隔离的，而且是结构上隔离的，不是靠纪律。**
> 所以真正要写的不是「怎么开一个干净的窗口」，是**什么时候一个干净的窗口是错的**，
> 以及边界该画在三层里的哪一层。

## 前置

- [第 00 章](./00-方法与约定.md) 对「Agent」的限定用词。本章全程按那个定义：
  全仓库只有两个 Agent——`source.explore`（`packages/harness-testing/src/casegen/nodes.ts:301`
  声明 `observationType: "agent"`）和 `repair.loop`（`packages/harness-testing/src/codegen/nodes.ts:177`）。
  其余都是流水线节点。**「子 Agent」在这个仓库里目前一个都没有。**
- [第 03 章](./03-从节点到角色.md)：角色的边界。本章讲的是**上下文**的边界，两者不重合。
- [第 04 章](./04-编排三模式.md)：进程拓扑与监工。本章的第三层隔离建立在它上面。

### 与第 09、10 章的分工（先划清，避免三章说同一件事）

| 章 | 管什么 | 典型代码 |
|---|---|---|
| **05**（本章） | **有几个窗口，边界画在哪一层** | `NodeDef` 的 in/out、`fork`、`ChatRequest` 无 history |
| [10 上下文压缩](./10-上下文压缩.md) | **一个窗口里装不下时裁什么** | `fitToBudget`、`trimMiddle`、`budgeted` |
| [09 记忆四层模型](./09-记忆四层模型.md) | **窗口之间什么东西可以过** | `deadHref` 的跨运行留存、`ExploreProfile` |

一句话：**10 决定一个窗口里留什么，05 决定有几个窗口，09 决定窗口之间什么能过。**
本章会引用 `fitToBudget` 的 `dropped`，但只把它当**信号**用，不讨论它的算法。

---

## 问题

### 这个话题的标准形态在这里不成立

「子 Agent 与上下文隔离」这个题目预设了一个失败：一个长会话的窗口里堆进了一个二十万 token 的
工具返回值，之后每一轮都带着它，直到 Agent 死掉。**这个失败在 TestPilot 里不可能发生**，
理由是类型层面的：

```ts
// packages/harness-core/src/model/client.ts:13
export interface ChatRequest {
  stable: string;    // 不变的那半：角色、方法、输出 schema
  variable: string;  // 这一次的材料
  images?: string[];
  schema?: Record<string, unknown>;
  maxTokens?: number;
  label?: string;
}
```

**没有 `history` 字段，也没有 `messages` 数组。**`ModelClient.chat`
（`packages/harness-core/src/model/client.ts:65`）是单发的：一次调用一个窗口，调用之间什么都不留。
图运行时把循环放在**节点内部**而不是做成图上的环
（`packages/harness-core/src/graph/runtime.ts:106-113` 的注释把这条写死了），
所以连「一个循环把上下文越滚越大」这个形状也没有。

把这一条说清楚，是这一章最重要的产出。因为**照着题目去建子 Agent 框架，是这本书里最贵的一种返工**：
它会在一个已有监工（`packages/harness-core/src/harness/supervisor.ts:115`）之上再叠一个监工，
在一个检查点已经工作的图运行时之上再叠一套记忆模型，而两个真正在痛的负载
——`spec.compose` 的输入、`allOutputs` 的 IPC——**一个字节都不会变小**。

### 那么真正的问题是什么

反过来问，才问到点上：

> 既然每次调用天然是干净窗口，**什么时候干净是错的**？谁来把上一次窗口里的东西带过来？

`repair.loop` 就是活着的样本。它每一轮都开一个全新的窗口——`repairVariable`
（`packages/harness-testing/src/codegen/prompts.ts:92`）只带五样东西：

```
CASE / ROUND / FAILURE(failKind) / CURRENT CODE
```

**没有前几轮改过什么、也没有前几轮为什么没用。**第三轮的模型完全可能重新提出第一轮已经试过并失败的
改法，而它无从知道。这不是疏漏，是这个形状的必然代价——而代价是被付过账的，见「代价与风险」。

第二个问题是**层**。这个仓库有三层互不相同的隔离边界，粒度和开一个的代价差了三个数量级，
而讨论「要不要开一个子 Agent」时把它们混作一谈，是最容易犯的错。

---

## 技术点

**上下文隔离**：让一段工作只看见它该看见的东西。实现手段按粒度从细到粗：

1. **一次调用一个窗口**（无状态请求）——隔离由「没有地方放历史」保证；
2. **一段工作一个执行单元**（节点 / 子 Agent）——隔离由**契约**保证：入什么、出什么被校验；
3. **一段工作一个进程**（独立堆、独立生命周期）——隔离由操作系统保证。

三者的判据不同。**能用第 1 层解决的绝不上第 2 层，能用第 2 层的绝不上第 3 层**，
因为代价是指数级的，而隔离强度只是线性的。

---

## 现状

### 三层边界，逐层对照

| 层 | 边界是什么 | 谁强制 | 开一个的代价 | 今天能开吗 |
|---|---|---|---|---|
| **调用** | `ChatRequest` 的 `stable`+`variable`+`schema` | 类型：没有 history 字段（`client.ts:13`） | 一次模型调用；准入并发 3（`server/harness.config.ts:17`） | ✅ 天然 |
| **节点** | `NodeDef` 的 `input`/`params`/`output`，每步 zod 校验（`graph/runtime.ts:114-153`） | 运行时，**逐步**校验 | 一次 `runGraph` 步；产物落 `SqliteOutputStore` | ✅ 建图即得 |
| **进程** | `fork` + IPC，`serialization:"advanced"`（`supervisor.ts:243-253`） | 监工 + 操作系统 | `--import tsx` 冷启，`readyTimeoutMs: 30_000`（`server/src/procs.ts:138`） | ❌ **开不出来** |

第三行的 ❌ 是这一章唯一的结构性缺口：`Supervisor.register`
（`packages/harness-core/src/harness/supervisor.ts:134`）在 id 重复时直接抛错，
而**整个 `packages/harness-core/src` 里没有 `unregister`**。runner 池是启动时一个 `for` 循环
定死的（`server/src/procs.ts:141`，数量来自 `config.execution.runnerCount`，`procs.ts:119`）。
运行时能注册的只有 `kind:"exec"` 的能力进程（`procs.ts:237` → `harness/capability.ts:13`），
那是外部服务，不是能跑图的 node 进程。

**「开一个干净的进程」在今天字面意义上做不到。**

### agent 进程内部：并发运行共享一切

`apps/agent/src/main.ts:65` 的 `running` 是一个 `Map<wfRunId, {controller, promise}>`。
两次并发运行共享堆、共享同一个 `traced(gated(modelFromEnv()))` 客户端（`main.ts:167`）、
共享同一条心跳；`child.setTask` 被后启动的那次直接覆盖（`main.ts:80`）。
**并发运行之间的隔离是一个 key，不是一道边界。**这在今天无害（`queueConcurrency: 1`），
但它是「进程页上这个 agent 在干什么」只能显示一件事的原因。

### 已经做对了、不用改的三处

写下来，免得被当成缺陷推倒：

**① `review.revise` 每条用例一个干净窗口。**`reviseCase`（`packages/harness-testing/src/casegen/revise.ts:77-84`）
的注释把理由写死了：复核的人盯着的是**某一条**用例和**它的**异议，重跑整个故事会把他已经接受的
那些一起换掉。所以隔离的粒度是「一条用例」，不是「一个故事」。窗口里只有：这条用例、它的异议、
它的故事、一段裁过的规格（`server/src/review.ts:764-782`）。
身份跨窗口保留（`revise.ts:92-94`：新 id 会把它和正在做的那个决定、以及它的来源印记切断）。
**这一处是全仓库把「干净窗口」和「不该干净的那部分」分得最准的地方。**

**② `repair.loop` 用产物传状态，不用会话传状态。**每轮窗口是新的，但 `current.code`
是上一轮改完的那份（`codegen/nodes.ts:270-288`）。**跨轮的记忆存在被重写的产物里**，
而不是存在一段越滚越长的对话里。产物有 schema、能落库、能被人读；对话没有。

**③ 节点边界是被校验的边界。**`runtime.ts:224-263` 每一步都 `safeParse` 输入、参数**和输出**，
输出不合自己的契约就当场停（`runtime.ts:262-263`：下游是凭这份契约接上来的）。
这比绝大多数子 Agent 框架的「handoff」强——那些通常只传一个字符串。

### 今天收得到的「窗口不够用」的信号，以及收不到的

这是本章判据的仪表盘，逐条对着代码看：

| 信号 | 在哪 | 今天状态 |
|---|---|---|
| `fitToBudget` 报 `dropped > 0` | `budget.ts:66-78` 定义，`casegen/nodes.ts:969` 调用 | ⚠️ **全仓库只有这一个生产调用点** |
| `budgeted()` 按屏截断触发 | `exec/interactive.ts:359` | ✅ 会截，但**不报数**——截了多少只写在那一屏的正文里 |
| 探索屏数上限 | `casegen/nodes.ts:318`，`min(1).max(30).default(6)` | ✅ 唯一一个把上下文预算做成可调参数的地方 |
| 材料撞上最后的护栏 | `server/src/index.ts:1270` 的 `console.warn` | ✅ 但只进 stdout，不进事件总线 |
| `spec.compose` 的输入尺寸 | `casegen/nodes.ts:456` | ❌ **完全没有预算**，`material.text + flowText` 直接进 `chat` |
| `repair` 的输入尺寸 | `codegen/nodes.ts:241-251` | ❌ 没有预算，`outcome.message` 与整份 `code` 原样拼进去 |
| `review.revise` 的规格 | `server/src/review.ts:781` | ❌ `spec?.text?.slice(0, 6000)` ——一刀头切，`budget.ts:4-6` 说的正是这个算法是错的 |

**四个信号里三个收不到。**所以今天「该开一个新窗口了」这句话在这个仓库里没有数据支撑——
只能靠人拍。这是本章要修的唯一一件事。

### 实测记录：`budgeted()` 是这个问题唯一一次真正发生过的地方

`exec/interactive.ts:75-88` 记的是实测，不是设想：

> 网关那边有一刀 `notes.slice(0, 60000)`。屏数只有 8 的时候它从不生效；探索改进到 25–30 屏之后，
> 它每次都生效——而**从尾巴切会整屏整屏地消失**。一次实测里 about 和 contact 两屏被整个切掉，
> 材料里于是既没有 `Corporate History` 也没有 `CAPTCHA`，看起来像是探索没走到。

还有更坏的一层，同一段注释：**丢掉的总是最后探索到的那些屏**，而那恰好是「未访问路由优先」
「全局队列」这些改进费力够到的部分——**改进越有效，被丢掉的越多**。

同一个上限在 `server/src/index.ts:1261-1268` 被记了第二遍：24000 → 60000 → 240000，两次都是在
一次「回复被切断」之后补的。

**这一段是全章最重要的反例**：真实发生过的「窗口装不下」，正确解法是**按屏等额分配 + 结构不参与分配**
（`interactive.ts:89-99`），**不是**开一个子 Agent 去分头读那些屏。
开子 Agent 会把成本乘以屏数——而模型是这个系统里最稀缺的资源（`model/gate.ts:1-8`）。

---

## 变更

四条，按「必须做 / 有条件做 / 明确不做」排。

### 变更一（必做）：把 `dropped` 接满，让判据有仪表

判据只有一句话：**只要一次调用的输入是「上游产物 + 别的东西」拼出来的，它就必须过 `fitToBudget`，
并且 `dropped > 0` 时必须发一条 log。**

三处待接，形状照抄 `casegen/nodes.ts:969-982`（那里已经是对的：故事 `fixed:true`，规格可裁，
裁了多少用 `ctx.emit("log", {stream})` 报出去）：

| 位置 | 现在 | 改成 |
|---|---|---|
| `casegen/nodes.ts:456` `spec.compose` | `material.text + flowText` 裸拼 | `material` share 4 / `flows` `fixed:true`，limit 从新增的 `contextTokens` 参数来（抄 `nodes.ts:932` 那一行的形状） |
| `codegen/nodes.ts:241-251` `repair` | `code` 与 `failure` 都无界 | `code` `fixed:true`（改的就是它，裁了就废）、`failure` 可裁 |
| `server/src/review.ts:781` | `slice(0, 6000)` | `fitToBudget`，规格 share 1、异议 `fixed:true` |

**这不是新能力，是仪表。**没有仪表，「什么时候该开一个干净窗口」永远只能靠人拍；
有了它，这句话变成一个可以查询的条件：*某个节点连续 N 次运行 `dropped > 0`*。

顺带把 `budgeted()` 也改成报数：今天它截了一屏，只在那一屏正文里写「这一屏还有 N 字没写进来」
（`interactive.ts:359`），没有任何一处能回答「这次探索一共丢了多少字」。

### 变更二（有条件做）：`Supervisor.unregister(id)`，把第三层打开

十行左右加在 `supervisor.ts:134` 旁边（`entries` 本来就是 Map，`register` 已经在重复时抛错），
外加允许运行时 `register` 一份 node 规格。「开一个干净的进程」于是等于：
分配 id → 注册 `restart:"never"` → start → run → stop → unregister，
spawn / ready / 心跳 / `settleOnDeath` 全部原样复用。

**但它只能在满足下面至少一条时用**——这三条恰好是节点边界给不了而进程边界能给的：

| 判据 | 为什么节点给不了 |
|---|---|
| 需要独立的堆 | 节点全在 agent 进程里；一次 OOM 带走所有并发运行 |
| 需要独立的重启策略 | `restart` 是 `ProcSpec` 的字段，节点没有对应物 |
| 需要能被单独杀掉 | 今天取消一次运行只是 abort 一个 controller（`agent/main.ts:113`），在飞的调用照跑 |

**不满足任何一条就不要开。**代价见下一节。

配套两条硬约束，漏一条都会静默出错：

1. 新进程**必须**调 `setModelLease`。`lease` 默认是直通（`model/lease.ts:11`），
   忘了绑就**悄悄绕过全局准入门**，症状是负载下的 502——指向模型服务，而不是指向接线。
2. `lending.releaseAllFor`（`server/src/procs.ts:107-110`）必须对已经 unregister 的 id 仍然有效，
   否则一个死掉的临时进程会永久扣着一张准入票，而并发上限只有 3。

### 变更三（做）：`review.revise` 换成有界并发 + 可中断

`server/src/review.ts:746-799` 是一个串行 `for`。隔离已经对了（变更外的既有优点 ①），
缺的只是吞吐和控制：换成并发度等于 `gated` 准入上限的 map，从路由把 `AbortSignal` 穿进来。
**注意一处已经存在、并发之后会变宽的写竞争**：`regenerate` 在 `review.ts:762` 一次读满整批，
之后逐条 `saveReviewEdit` 覆盖 `(wfRunId, caseId)` 那一行——一次人工编辑落在中途，
会被用编辑前的文本算出来的模型重写覆盖掉。修法是每次保存前重读那一行。

### 变更四（明确不做）：**不给 `ChatRequest` 加 `history`**

需要多轮的节点，自己在本地持有那份轮次列表，调用前用 `fitToBudget` 裁，
**裁完仍然拼成一个 `variable` 字符串**。理由两条，都不是风格问题：

- `requestKey`（`client.ts:73-82`）对 `stable`+`variable`+`schema` 取哈希，
  `RecordedModel`（`client.ts:73`）靠它匹配录像，匹配不上就抛
  （`client.ts:157`——一个会去打真模型的测试「在一台机器上过，在另一台上挂」）。
  加了 history，同一条用例的第二轮永远命中不了录像，`fixtures/recordings/` 整体作废。
  **失败形态不是测试变红，是测试悄悄开始打真模型。**
- `stable` 的**前导字节**是性能契约，不是排版：`client.ts:5-11` 记的实测是
  ~9k token 的请求里 ~6k 来自前缀缓存命中，「只有前导字节逐字相同才会发生」。
  把任何会变的东西挪进 `stable`，或者让消息数组去决定拼接顺序，都会静默丢掉这一半速度，
  **而全部测试照绿**。

---

## 收益

| 收益 | 可测量吗 |
|---|---|
| 「窗口装不下」从一个感觉变成一个条件：`dropped > 0` 连续出现在同一个节点上 | ✅ 事件总线上可查询 |
| `spec.compose` 的截断从「四个节点之后的 `JSON 格式错误`」变成一条当场的 log | ✅ 实测记录：这条流水线正是这样误判过（`evals/README.md`；`casegen/nodes.ts:440-449` 记了同一件事的输出侧） |
| repair 的大失败信息不再走成 900 秒超时或一个不重试的 4xx | ✅ 失败归档从 `infra` 变成一条裁剪日志 |
| 复核重写从数分钟静默串行变成可中断的并发 | ✅ 墙钟时间 |
| 第三层隔离**可用**（不是「已用」） | ❌ 见「怎么证伪」 |

最值得说的一条**不是新增的，是保住的**：这一章的结论是「大部分不用改」。
把「三层已经存在的隔离」写下来，收益是**不会有人再去建第四层**。

---

## 代价与风险

### 开一个干净窗口，丢掉的是什么

| 丢掉的 | 谁来补 | 补得上吗 |
|---|---|---|
| 上一轮试过什么、为什么没用 | `repair.loop` 用 `withoutProgress` 计数（`codegen/nodes.ts:212-218`），连续 `maxWithoutProgress`（默认 2，`nodes.ts:184`）轮「改了等于没改」就停 | **补不上，只能止损**：它检测不到「换了个方向重蹈覆辙」，只能检测到「原地不动」 |
| 上下游的隐含约定 | 节点契约（zod，`runtime.ts:224-263`） | ✅ 这层是被校验的 |
| 跨进程的字段 | **没人补**——`StartInput`（`agent/main.ts:36`）和 `ExecSpec` 用 `as never` 过界，全程零校验 | ❌ 实测事故：observe 的交接只转发了 `projectId`，`envRef` 和 `url` 一个都没带，于是一次声明「跑在 bench-juiceshop」的运行打开的是 local 的地址、带的是 local 的凭证，**「而产出物看不出任何异常」**（`agent/main.ts:36-51`） |

**最后一行是本章最贵的一条风险。**任何把一段工作挪过进程边界的动作，
都必须先给那个交接加 zod 校验——否则丢一个字段的后果不是报错，是一份看起来完全正常的错结果。

### 谁来写摘要，摘要错了怎么发现

这两个问题在本章里的答案是同一个，而且是反直觉的：

**这个仓库里今天没有任何一处让模型写摘要。**压缩全部是机械的：
`trimMiddle` 保头保尾并留标记（`budget.ts:105-115`）、`budgeted` 按屏等额并写明截了多少
（`interactive.ts:359-369`）、`forTrace` 留下 `__truncatedForTrace` 与原始字数（[第 12 章](./12-Langfuse可观测性.md)）。
这是有意的，两条理由都在代码里：

1. **一次摘要是一次模型调用**，而模型是这个系统里最稀缺的资源
   （`model/gate.ts:1-8`；准入并发 3，`server/harness.config.ts:17`，切回本地要改回 1）。
   在一个探索循环里给每屏摘要，成本乘以屏数。
2. 它会重新引入这条流水线栽过四次的那个形状：**产出静悄悄地变短，而不是显式地报错。**

> **摘要错了怎么发现——发现不了。这是要老实写下来的一条。**
> 机械压缩留得下痕迹：`dropped` 是一个数，`…[trimmed to fit the context budget]…` 是一个标记，
> `__truncatedForTrace` 是一个可筛的布尔值。**模型摘要留不下任何痕迹**：一份摘要错在哪，
> 只有拿原文对着读才知道，而原文正是被摘要掉的那一份。
> 所以本章不引入摘要式压缩；真要引入，它属于 [第 10 章](./10-上下文压缩.md)，
> 并且必须先回答这一句。

### 进程级隔离的代价，按数量级

| 项 | 数 | 出处 |
|---|---|---|
| 冷启 | `fork` + `--import tsx`，ready 超时 30 秒 | `server/src/procs.ts:138` |
| 每跳一次的序列化 | 结构化克隆，Error 保得住 message | `supervisor.ts:243-253` |
| RPC 无超时 | 两个方向都 `timeout: -1` | `harness/rpc.ts:63-67`、`:92-99` |
| 交接零校验 | `as never` | `agent/main.ts:36`、`apps/runner/src/exec.ts:33` |

`timeout: -1` 那一条要单独说：它是**修好的 bug**，不是遗漏——birpc 按方向计时，
一次视觉模型调用几十秒、一条用例几分钟，加回超时会重现那条读起来像「网关不可达」的
`[birpc] timeout on calling execCase`。**而删掉它，整个测试套件照绿**（`rpc.ts:13-16` 记了这件事）。
临时进程如果引入任何自带默认超时的新传输，就是在重犯这个错。

结论：**临时进程适合「长任务」，不适合「一次回合」。**一个只跑几秒的子任务，
花在冷启上的时间比它本身还长，还多占一个准入身份。

### 什么情况下不该做本章的任何一条

- 只是想让某个提示词短一点 → 那是[第 10 章](./10-上下文压缩.md)，不是这里。
- 只是想让某个大产物别跨进程 → 那是[第 11 章](./11-工具返回值治理.md)。
  实测尺寸：`explore` 节点产物 128,430 B；`allOutputs` 一次运行详情页 ~205 KB 的 IPC 往返
  （两者均为对线上 `events.db` / `workflows.db` 的实测）。**这些是产物尺寸，不是窗口尺寸**——
  把它们当成「上下文爆了」去开子 Agent，是这一章最容易走错的岔路。
- 想给评测两条臂各开一个进程以求「更干净」→ 不要。探索的确定性（`interactive.ts:37-48` 实测：
  PetClinic 五次运行图完全一致、标准差为 0）才是配对评测成立的前提，进程数不是。

---

## 怎么证伪

| 手段 | 内容 | 今天会红吗 |
|---|---|---|
| **单元测试** | `fitToBudget` 一旦裁就必须 `dropped > 0`——**裁剪不允许静默**。放在 `packages/harness-core/test/budget.test.ts` | 不会，这是钉子 |
| **单元测试** | `budgeted(screens, graph, coverage, total)` 的返回长度不得超过 `total` 的某个固定倍数，n 取 1..50 | ✅ **会红**：`interactive.ts:94` 的 `Math.max(600, …)` 下限让它可以超出 total。这正是要它红的原因——不要靠放宽断言让它变绿，那就是把 24000→60000→240000 换成测试形式再走一遍 |
| **门禁规则** | 任何一次 `model.chat` 的 `variable` 由两段以上拼成、且没有过 `fitToBudget` → 标记。这是「有门禁就照做，没门禁就漂」的直接应用（[README](./README.md)） | 三处会中：`casegen/nodes.ts:456`、`codegen/nodes.ts:243`、`review.ts:781` |
| **配对评测** | 一份 `evals/*.json`，两臂只差 `design.cases` 的 `contextTokens`（8000 vs 4000），看 `dropped` 与语义覆盖的关系 | 这条能证伪本章的**前提**：如果把窗口砍一半覆盖率不掉，那么「窗口不够」根本不是这条流水线的瓶颈，本章的判据要整体重估 |

### 无法证伪的部分（如实写）

**「进程级隔离比节点级隔离更好」这句话，今天造不出证伪它的评测。**
理由不是懒：要跑这个 A/B，得先有一个**同时满足**那三条判据（独立堆 / 独立重启策略 / 可单独杀掉）
的真实任务，而今天一个都没有——runner 已经是进程，其余全部在节点边界内就够。
所以变更二应当**建好并留空**，等第一个真需要它的任务出现时再由那个任务来证明它。

> 按 [00 章](./00-方法与约定.md) 的纪律，这里不给一个假的证伪手段。
> 造一个「关掉临时进程」的消融开关很容易，而报告会显示「关掉它没有影响」——
> 这句话是真的，但它说的是**没有任何任务在用它**，不是它没有价值。

同样无法证伪的还有一条：**`repair.loop` 每轮开新窗口 vs 带上前几轮**，
本可以做成消融臂，但代价直接：带历史就要给 `ChatRequest` 加 `history`，
而那会作废全部录像（见变更四）。**要么不做，要么先把录像的匹配键改造完**——
在此之前，这个取舍只能靠 `withoutProgress` 这个止损计数间接观察。

---

## 验收

1. `spec.compose`、`repair`、`review.revise` 三处都在 `dropped > 0` 时发出一条带数字的 log；
   在一次 24 屏的真实探索上跑完整条流水线，能从事件总线上查到「哪个节点裁了多少」。
2. `budgeted()` 在返回时报出总丢字数；`server/src/index.ts:1270` 那条 `console.warn`
   在同一次运行里**不触发**（触发即说明按屏预算算错了，那是这条护栏存在的全部理由）。
3. `packages/harness-core/test/budget.test.ts` 里 `budgeted` 的上界测试存在。
   它今天是红的，允许 `skip`，**但不允许通过放宽断言变绿**——skip 的注释要写明红的原因。
4. `Supervisor.unregister(id)` 存在、只允许对已停止的进程调用，
   并在 `packages/harness-core/test/supervisor.test.ts` 里有一条「unregister 之后
   `lending.releaseAllFor` 仍能回收它的票」的测试。
5. 一次 20 条用例的复核重写可以被中途停下，已完成的那些保留，未开始的那些不再发起。
6. `grep -rn "history" packages/harness-core/src/model/` 无结果。
   这一条是给未来的自己的：**`ChatRequest` 长出会话历史的那一天，
   `fixtures/recordings/` 就在同一天静默失效了。**
