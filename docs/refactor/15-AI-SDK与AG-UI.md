# 15　AI SDK 与 AG-UI

> 结论：**AG-UI 作为「投影」加一条路由；AI SDK 只在 `ModelClient` 背后作为一个实现，
> 而且短期内没有理由做。**
>
> 这不是折中。两个协议的收益落在不同的层，而这个仓库在其中一层已经有了更强的东西。

> **体例说明**：这是一章**对比章**。「AI SDK」与「AG-UI」落在完全不同的层，
> 合起来算账会得到错误的结论，所以「现状/变更」按两部分分开写而不是各一节。
> 见 [第 00 章](./00-方法与约定.md) 的「允许的偏离」。

## 前置

- [第 01 章](./01-架构基线.md)：事件总线与 `Envelope`。
- [第 11 章](./11-工具返回值治理.md)：事件量的预算——本章的过滤器改动会直接改善它。
- [第 13 章](./13-过程可视化.md)：`/lineage` 端点；与本章的过滤器是同一件事的两半。

---

## 问题

「换成 AI SDK + AG-UI」实际上是两个互不相干的提议，必须分开算账：

| | 层 | 这个仓库现有的对手 |
|---|---|---|
| **Vercel AI SDK** | 模型调用 | `ModelClient` + 四个装饰器 + `OpenAIModel` 里五条实测行为 |
| **AG-UI** | UI 事件传输 | `Envelope` + `EventBus` + `attachWs` |

合起来谈会得到一个错误的结论，因为**一边该说不，另一边该说「以投影的方式说是」**。

---

## 第一部分：Vercel AI SDK

### 现状：这里已经有一个装饰器栈

`ModelClient`（`client.ts:65`）是一个单方法接口，上面已经叠了四层：

| 装饰器 | 位置 | 作用 |
|---|---|---|
| `OpenAIModel` | `openai.ts:38` | ~180 行，**五条各自量出来的行为** |
| `gated()` | `client.ts:140` | 跨进程准入 |
| `traced()` | `traced.ts:31` | 追踪（[第 12 章](./12-Langfuse可观测性.md)） |
| `RecordedModel` | `client.ts:157` | VCR，按 `requestKey` 回放 |
| `FakeModel` | `client.ts:157` | 测试替身 |

`traced.ts` 里写着为什么包接口而不是包实现：包实现的话 `RecordedModel` 会漏在外面。

### 表面上的收益，以及为什么它是假的

看起来最诱人的一条是 `generateObject()`：一个 zod schema 就够了，
不用同时手维护 JSON Schema + zod 校验 + `parseJson`。

**但这个仓库的代码里恰好有反证。**

`casegen/types.ts:89` 声明 `priority: z.enum([...]).optional()`，
`types.ts:98` 声明 `postSteps: z.array(...).default([])`——
而 `CASES_SCHEMA`（`prompts.ts:433`）把这**两个都放进了 `required`**。

这个分歧是**故意的**，理由记在 `prompts.ts:426`：两个字段只放在 `properties` 里的时候，
**8 条用例回来 8 条都没有 priority**，而由此跑出来的配对评测比较的是两条一模一样的臂
——「McNemar 检验的是两组相同的数」。

> **任何 zod → JSON Schema 的自动推导，包括 AI SDK 的，都会精确地重现这个 bug。**

另外三条同样具体：

| `OpenAIModel` 里的行为 | 记录在 | 丢掉之后的症状 |
|---|---|---|
| `stable`→system / `variable`→user 的字节序 | `client.ts:7-11` | ~9k 请求里 ~6k 的前缀缓存命中消失。**`messages` 数组不保证首字节一致** |
| `thinking_budget` + **两种拼写**的 `enable_thinking` | `openai.ts:102-107` | 只发一种，思考**静默地仍然开着** |
| 截断后加大预算重发 | `openai.ts:59-72` | 产出「看起来正常，只是少了一截」。一天之内撞过四次 |
| 约束解码失败后**永久**降级 | `openai.ts:152-158` | 每次调用都重试一个端点不支持的东西 |

这四条**有三条的失败方式是「产出更短但貌似合理的东西」，不是报错**——
正是这个模块被建出来要消灭的那一类。

### 结论：不替换。如果要用，放在接口背后

若确实需要 AI SDK 的多供应商覆盖，**把它实现成 `model/openai.ts` 的兄弟文件**，
让 `gated()` / `traced()` / `RecordedModel` 三层原封不动继续工作。

代价对比很干净：

- 放在接口背后 → 一个新文件，其余不动。
- 替换接口 → `requestKey`（`client.ts:73`）是对**装配后的请求**做的哈希，
  改变请求装配方式会**同时作废 `fixtures/recordings/` 里的每一份录像**。
  而失败方式**不是测试变红，是测试悄悄开始打真实模型**。

### 一个诚实的补充

survey 里 prompts 那一侧给出的替代方案值得记下来：如果目标**仅仅**是不想手维护两份 schema，
诚实的小做法是「从 zod 生成 JSON Schema，然后套一个显式的 `required` 覆盖列表」。
但要注意——**那个覆盖列表正是 `test/casegen.test.ts:707` 已经在检查的东西**，
所以净收益接近零，而净风险不是。

---

## 第二部分：AG-UI

### 现状：这里已经是一个事件流协议，只是不叫 AG-UI

`Envelope<T>`（`obs/envelope.ts:21`）带 `{v, id, ts, scope, kind, payload}`，
`id` 由存储分配、单调，就是恢复锚点。`attachWs`（`server/src/ws.ts:18`）**77 行**里
已经做了：版本闸、从 `lastEventId` 回放、超窗重同步、15 秒活性检测。

`obs/store.ts:47` 还记着为什么 id 用 AUTOINCREMENT 而不是 rowid——
剪枝后 rowid 会复用，那会打断 `resume-from-lastEventId`。

**这些正是 AG-UI 被买来解决的性质，而且这里的版本还多一个：持久化的重放日志。**

### 真正缺的不是协议，是一个过滤器

`EventBus.subscribe`（`bus.ts:64`）**不接受任何 scope/kind 谓词**；
`ws.ts:50` 无过滤订阅；作用域过滤发生在**浏览器里**（`src/lib/wf.ts:992`）。

实测代价：

- 200,014 行里**只有 2,379 行（1.19%）带 `wfRunId`**；
- 94.5% 是 `log` + `process.status`；
- 500 条的重放窗口（`ws.ts:8`）在实测峰值 1,921 事件/分钟下**只够 ~16 秒**；
- 而**最大的单次运行一共才 89 条事件**——按运行过滤的话，那个窗口够覆盖它的全部历史。

> 一个画布在看某一次运行时，正在接收 **98.8% 与它无关的流量**。

### 变更：加过滤器 + 加适配器，**不动电线**

**(a) 每订阅的过滤器**

`EventBus.subscribe` 的 options 加 `filter?: (e: Envelope) => boolean`，传给 `new Sub(...)`。

> ⚠️ **必须是每订阅的**。全局应用会破坏两个控制面订阅者——见「代价」。

**(b) WS 握手加两个可选参数**

`attachWs` 从 query string 读 `scope.wfRunId` / `kinds` 并构造谓词。
`Outbound` 联合类型（`ws.ts:11`）**一个字节都不用改**。

**(c) 一个新文件 `server/src/agui.ts`，做投影**

```
wf.run.started              → RUN_STARTED
wf.node.started / .finished → STEP_STARTED / STEP_FINISHED
gate.result + wf.node.output→ TOOL_CALL_RESULT
wf.paused                   → 自定义事件
```

挂在**第二条路由**上，`/ws` 保持逐字节不变。

### 三条不能碰的红线

**① 不要把 AG-UI 的 kind 加进 `EventKind`。**
`obs/envelope.ts:49` 那个闭合 const map 的注释写着「总线上出现一个未知 kind 是 bug，不是新功能」。

**② 不要 bump `PROTOCOL_VERSION`。**
它是一个**硬拒绝闸，在三个地方各写了一遍**（`envelope.ts:19`、`ws.ts:27-34` 关 4400、
`src/lib/ws.ts:35`），**没有协商机制**。而 `src/lib/ws.ts:35` 在收到那个关闭码之后
设 `closedByUs` 并**停止重连**——也就是说 bump 一次会把所有已打开的标签页**永久搁浅**。

真要改信封，做法是**并存**而不是 bump：把 `EnvelopeSchema` 放宽成
`z.union([z.literal(1), z.literal(2)])` 然后按读分支。（顺带：
200,009 条已存的行都断言了 `v: 1`，而 `db.ts:151-327` 全是 ADD COLUMN，**没有降级路径**。）

**③ AG-UI 是投影，不是第二个真相源。**
`replay` 和配对评测直接读 `events.db`（`obs/langfuse.ts` 头注把这条说死了）。
写 AG-UI 形状的行进库，等于开第二个真相源。

---

## 收益

| 变更 | 收益 | 可测量 |
|---|---|---|
| 过滤器（a+b） | 画布不再收 98.8% 无关流量；**500 条重放窗口从 ~16 秒变成够覆盖整次运行** | ✅ 直接量 |
| AG-UI 投影（c） | 与外部 agent 生态互操作，**且不放弃持久日志、重放窗口、边界校验**——多数 AG-UI 采用方没有这三样 | — |
| AI SDK 放接口背后 | 多供应商覆盖，一个新文件 | — |
| **不替换 `ModelClient`** | 保住五条实测行为 + 全部录像回放 | — |

过滤器那一条值得强调：**它同时是 [第 11 章](./11-工具返回值治理.md) 的一部分解法，
也是 [第 13 章](./13-过程可视化.md) `/lineage` 端点的另一半。**三章指向同一个改动。

---

## 代价与风险

| 项 | 说明 |
|---|---|
| **过滤器必须每订阅** | 全局过滤会打断两个控制面订阅者。总线**不是 UI 通知通道，是承重的控制面** |
| 流式 + 准入闸 | **最隐蔽的坑**。`withModel` 刻意是每次调用的粒度（`lease.ts:17`：「Granularity is deliberately one call, not one run」）。一个长流会**整段持有槽位**，而这是系统里最稀缺的资源（自托管 1，托管 3） |
| 新传输的默认超时 | 任何带默认 deadline 的新传输会重新触发 `rpc.ts:92-99` 修过的那个 bug，**而测试套件里没有任何东西会抓到** |
| `requestKey` 作废 | 见上：测试不会变红，会开始打真实模型 |
| 加高频 kind | 直接落进 20 万条的 FIFO 窗口，挤掉血缘——`harness.config.ts:140` 已经记过一次同样的事故 |

**什么情况下该重新考虑 AI SDK**：如果引入了**真正的工具调用循环**。
今天没有——`guard.ts:6` 写着「There is no tool registry to police here」，
模型产出数据，代码去动手。给一个刻意没有工具抽象的系统加一层工具抽象，
是在解决一个不存在的问题。

---

## 怎么证伪

| 手段 | 内容 |
|---|---|
| **可量测的前后对比** | 「一个画布订阅在一次运行期间收到多少条与该运行无关的事件」——今天 98.8%，加过滤器后应接近 0。**这是本章最硬的验收数** |
| **单元测试** | ① 过滤器必须是每订阅的：两个订阅者用不同谓词，各自只收到自己的；② 控制面的两个订阅者在过滤器引入后行为不变；③ AG-UI 投影是纯函数：同一批 `Envelope` 产出同一批 AG-UI 帧，且 `events.db` 里不多出任何行 |
| **配对评测** | AI SDK 若真要放到接口背后，用现成机制：同一批用例，A 臂 `OpenAIModel`、B 臂 SDK 实现，比覆盖率**与**门禁分。两臂只差一件事——正好符合 `evals/README.md` 的规矩 |
| **无法证伪的** | 「与外部 agent 生态互操作」的价值。今天没有对手方，所以这条只能等真有一个外部消费者时再评。**在那之前，AG-UI 投影的正当性只是「便宜且不破坏什么」，不是「已证明有用」** |

---

## 验收

1. WS 握手可以带 `wfRunId`，且一个订阅者只收到该运行的事件。
2. 两个控制面订阅者在改动后行为不变（有测试钉住）。
3. `/ws` 的帧**逐字节不变**；`PROTOCOL_VERSION` 仍然是 `1`。
4. AG-UI 在**另一条路由**上，且 `EventKind` 没有新增任何成员。
5. `events.db` 的行数与构成不因 AG-UI 的引入而变化（投影不落库）。
6. `fixtures/recordings/` 全部仍然命中，`pnpm test` 期间**没有任何真实模型调用**。
7. 若引入流式：一次流**不得**整段持有准入槽位——这条要有测试，否则它只是一句话。
