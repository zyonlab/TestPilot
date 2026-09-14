# 12　Langfuse 可观测性

> **状态：已实施并验证。**这一章写的是做完之后的样子，不是提案。
> 代码在 `v2` 工作副本里，514 个测试全绿，一条真实 trace 已经发到
> `jp.cloud.langfuse.com` 并按官方 best-practices 逐条审过。

## 前置

- [第 02 章](./02-三条不可动摇的性质.md)：事件总线即血缘。本章的第一个问题就是「为什么要第二套」。
- 无代码前置。这一章是整本书里唯一一个**不依赖任何其他章**就能落地的。

---

## 问题

### 这个仓库已经有一套可观测性，为什么还要一套

`packages/harness-core/src/obs/` 里的事件总线**就是血缘**：节点的输入输出、提示词、
花费、进程状态全部落进 `events.db`，界面是这些行的投影，`replay` 和配对评测读的也是它们
（`obs/store.ts:47` 的注释把这件事说死了）。它做得很好。

但它答不了一整类问题，而那类问题恰好是这个项目每天在问的：

| 问题 | 事件总线 | 需要什么 |
|---|---|---|
| 这次运行发生了什么 | ✅ 就是为它建的 | — |
| 第 3 个节点为什么慢 | ✅ 有 `ms` | — |
| **这三个月里 `design.cases` 的延迟是涨了还是跌了** | ❌ | 跨运行聚合 |
| **开思考和关思考，两组各 20 次运行的成本差多少** | ❌ | 按标签分组的聚合 |
| **哪一次调用把上下文撑爆了** | ❌ 只有总 token | 分项用量 |
| **同样的提示词，换了端点之后输出变了没有** | ❌ | 跨运行 diff |

这些都不是「日志不够详细」，是**存储形态不对**：一条 append-only 的事件流为单次回放而生，
不为跨运行聚合而生。硬要在 SQLite 上做，等于自己写半个 Langfuse。

### 判断

**两套并存，但不是两个真相源。**追踪严格地从事件总线已经携带的同一批事实里派生；
同一个数字只算一次，报两次。这条纪律写在 `obs/langfuse.ts` 的文件头注里，
是这整块代码的第一条约束。

---

## 技术点

Langfuse JS/TS SDK v5（`@langfuse/tracing` + `@langfuse/otel` + `@opentelemetry/sdk-node`），
基于 OpenTelemetry。三个概念：

- **trace** —— 一个自成一体的工作单元。
- **observation** —— trace 里的一段，有类型：`span` / `generation` / `agent` / `tool` /
  `chain` / `retriever` / `evaluator` / `guardrail` / `embedding` / `event`。
- **session** —— 把多条 trace 归成一组。

类型不是标签：Langfuse 的 **Agent Graph 是按观测类型画的**，全报 `span` 那张图就是一条直线。

---

## 现状 → 变更

### 变更一：追踪的开关与生命周期

**新文件** `packages/harness-core/src/obs/langfuse.ts`（约 330 行）。三条纪律写在文件头注：

| 纪律 | 落在哪 | 为什么 |
|---|---|---|
| 没有密钥就**完全不启动** | `startTracing():83` | 不是「启动然后发不出去」——那会留下一个后台批处理器和一条永远失败的导出链路。测试、离线跑、别人 clone 的仓库都属于这一类，而它们是多数 |
| 永远不能弄坏一次运行 | 每个包装器都 try/catch | 一次评测跑四小时。追踪出问题的正确行为是**追踪自己消失** |
| 密钥不出网 | `addTracingSecrets():59` + `mask` | 用的是仓库自己那份 `redact()`（`util/interpolate.ts:64`）。**掩码规则只有一份**，两份实现的后果是日志里抹掉的东西从追踪里漏出去 |

关掉时，`observe()` 与 `beginObservation()` 是直通调用，**一次 OTEL API 都不碰**。

### 变更二：模型调用 → `generation`

**新文件** `packages/harness-core/src/model/traced.ts`。

包在 `ModelClient` **接口**上，而不是 `OpenAIModel` 实现上：包住接口就一次包住所有实现，
包住实现则 `RecordedModel` 和以后换的实现会漏在外面。所有节点、修复循环、评测判官、
复核重写、critic 都从 `ModelClient` 过。

> **更正。** 本章初稿写的是「`ModelClient` 是唯一一个模型出口」。**那是错的**，
> 代码勘察查出了另外两条：
>
> | 通道 | 走 `ModelClient`？ | 走准入闸？ | 在 trace 上？ |
> |---|---|---|---|
> | 节点 / critic / 判官 / 复核 | ✅ | ✅ | ✅ |
> | `server/src/model.ts` 的 `chat()`（探活 / **生成代码** / 改写用例） | ❌ 手写 fetch | ✅ | ✅ **本次补上** |
> | Midscene 的 `aiAction` / `aiAssert`（驱动浏览器） | ❌ | ✅ `withModel` | ❌ **仍然没有** |
>
> 第二条是一条真实的用户路径：`generateCode` 此前一次 trace 都不产——读一条运行时会看到
> 用例凭空有了代码，中间那次模型调用不存在。已在 `server/src/model.ts` 的 `chat()` 里
> 手工开 `generation` 补上（四个调用点各有低基数的 label：`model.probe.text`、
> `model.probe.vision`、`case.refine`、`case.generate-code`）。
>
> 第三条**仍然是缺口**：Midscene 的 token 要靠事后扒它的日志文件才拿得到
> （`harness-testing/src/report.ts`，那里记着两个坑：日志格式是 `total-tokens, 2707` 用逗号不是冒号，
> 以及文件跨运行追加所以必须按运行时间窗过滤）。
>
> **后果要说明白：按 `ModelClient` 的调用数去估并发或成本，会低估真实负载。**
> 这条更正本身也是本书纪律的一个例子——一个听起来很干净的架构断言（「唯一出口」），
> 在没有人去数之前，只是一个说法。

组合顺序是有意义的：

```ts
// apps/agent/src/main.ts:167
const model = traced(gated(modelFromEnv()));
```

`traced(gated(x))` 的 span 覆盖**排队等准入槽位的时间**；`gated(traced(x))` 只覆盖 HTTP 往返。
选前者：模型并发是 1–3，G1 那十几次串行调用最长的一段恰恰是排队，
**一个把等待藏起来的延迟数字，会让人去优化模型而不是去优化并发**。

### 变更三：`ChatResponse` 带上分项用量与模型名

`packages/harness-core/src/model/client.ts:37` 新增 `TokenUsage`，`openai.ts` 填充它。

这不是为了追踪而加的字段，是一个**本来就该有的洞**：

> `tokens` 一直只有 `total_tokens` 一个数，而**成本不是它的函数**：
> 同样 9k 个 token，8k 进 1k 出和 1k 进 8k 出，价钱能差好几倍。

同时带上 `model`：**由客户端报，不由调用方假设**。`modelFromEnv` 读的是环境变量，
而代理把请求路由到别的模型时调用方看不见——一个「我们以为跑的是哪个模型」的成本报表，
比没有报表更糟。

端点不给分项时**留空，不用总数去凑**：一个猜出来的分项让成本看起来精确，而错在哪没人查得出来。

### 变更四：节点自己声明观测类型

`graph/node.ts:32` 给 `NodeDef` 加了可选的 `observationType`。

声明在**节点这一侧**，不在运行时按类型名猜——运行时是通用的，它不该知道
「`source.explore` 是个 agent 而 `gate.textcase` 是道门禁」。

映射是**照着代码报的，不是照着期望报的**：

| 节点 | 类型 | 依据 |
|---|---|---|
| `source.spec` | `retriever` | 读文档，不改变状态——retriever 的定义 |
| `source.explore` | `agent` | 全仓库仅有的两个真自主循环之一 |
| `spec.compose` / `plan.stories` / `design.cases` | `chain` | 上游产物 → 模型 → 下游产物 |
| `gate.textcase` / `gate.code` | `guardrail` | 拦不合格产物；一次模型都不调 |
| `codegen.case` | `chain` | 同上 |
| `repair.loop` | `agent` | 有界自主循环：自己决定改什么、几轮、何时放弃 |
| 根（整次运行） | `span` | **这一层就是确定性 DAG，不是自主循环**（`casegen/nodes.ts:38`） |

最后一行值得停一下：把根报成 `agent` 会让 Agent Graph 好看，但那是假的。

### 变更五：运行时打点

`graph/runtime.ts`：

- `walk()` 闭包（`:177`）把主循环抽出来——循环里有**五个提前 return**
  （取消 / 断点 / 预算 / 上游缺产物 / 节点失败），其中四个都不是「失败」，
  但都必须让根观测正确收尾。
- 根观测（`:307`）：一次运行 = 一条 trace。
- 每个节点包一层 **active** 观测，于是该节点里的模型调用**自动挂进来**——
  `traced()` 不需要知道自己在哪个节点里，OTEL 上下文会告诉它。这就是正确树形的全部机制。

### 变更六：大产物的裁剪

`forTrace()`（`obs/langfuse.ts:275`）。这个仓库的节点产物是真的大——实测一份 `CaseBundle`
序列化后 **21,791 字符**。原样送进 trace 的后果不是「慢一点」，是**导出批次被撑爆导致整条
trace 丢失**。

裁，但**必须留下被裁过的痕迹**：

```json
{"__truncatedForTrace":true,"originalChars":21791,"keptChars":12000,
 "note":"完整产物在 events.db 与 wf_node_outputs 里；这里只留开头","preview":"..."}
```

悄悄截断正是这条流水线在 `maxTokens` 上栽过四次的那个形状（见 [第 11 章](./11-工具返回值治理.md)）。

### 变更七：归属信息由调用方给

`RunGraphOptions.trace`（`runtime.ts`）。harness-core **不知道什么东西该被归到一起**：
一次配对评测的两条臂属于同一个 session，一次普通运行属于它的项目。
两种归法都对，但只有网关知道这次是哪一种——在运行时替它猜，等于把业务判断写死进运行时。

网关侧（`server/src/graphs.ts`）默认按项目归，并自动打上：

```
graph:<id>   mode:<full|only|from>   ablate:<switch>   env:<envRef>   prompts:<digest 前12位>
```

**`ablate:*` 这一条是这里最值钱的东西**：它让「关掉 dedupe 的那批运行」在 Langfuse 上
变成一个可筛的集合——而配对评测的两条臂，差别恰恰就是它。

### 变更八：每个进程起停

| 进程 | 起 | 冲刷 |
|---|---|---|
| gateway | `server/src/procs.ts:40` | `SIGINT`/`SIGTERM`/`beforeExit` |
| agent | `apps/agent/src/main.ts:62` | `onShutdown` |
| runner | **不接** | — |

gateway 起在 `procs.ts` 是有讲究的：它是导入图里**最早被求值**的模块（index → exec → procs），
而它上面那行 `import "dotenv/config"` 保证密钥这时已经在环境里。顺序错了就是官方文档点名的
经典错误——Langfuse 带着空密钥初始化，然后一声不响什么都不发。

**runner 不接是一个有意识的取舍，写下来免得以后被当成埋点漏了：**
真正干活的是 runner（浏览器、Midscene、视觉模型），但它跨了两次进程边界。
把 W3C 上下文一路传过去是另一件事。折中做法是在 **agent 侧**把执行包成一个 `tool` 观测
（`apps/agent/src/main.ts:192` 的 `case.execute`），拿到的是：这条用例跑了多久、判决是什么、
失败归到哪一档（infra / locate / assert）——读一次运行时最先要看的三样。
拿不到的是 Midscene 每一步的视觉模型调用。

---

## 收益

已验证的 trace（`traceId=a6f980f01f9b5bab1b3c2544399c127a`）：

```
SPAN       workflow.run     lat=0.129s
  TRACE verify-g1 v7 env=development session=eval:verify-demo
        tags=[graph:verify-g1, mode:full, ablate:dedupe, arm:A]
  input:  {"graph":"verify-g1@7","mode":"full","projectId":"proj-verify","ablated":["dedupe"]}
  output: {"status":"done","spend":{...},"nodes":[...]}
   RETRIEVER  source.spec
   CHAIN      design.cases   lat=0.126s
     output: {"__truncatedForTrace":true,"originalChars":21791,...}
      GENERATION design.cases  model=qwen3-8-27b
        usage {input:35, output:120, cache_read_input_tokens:21, total:155}
        input: [{"role":"system",...},{"role":"user","content":"...凭证：••••••"}]
      GENERATION design.cases  model=qwen3-8-27b
        usage {input:15, output:120, cache_read_input_tokens:9, total:135}
   GUARDRAIL  gate.textcase
```

对着官方 best-practices 逐条：

| 要求 | 结果 |
|---|---|
| 模型名 | ✅ `qwen3-8-27b` |
| 分项 token | ✅ 含前缀缓存命中 |
| 名字可筛（低基数） | ✅ `design.cases`，实例 id 在 metadata |
| 层级正确 | ✅ 运行 → 节点 → 生成 |
| 观测类型具体 | ✅ 一条 trace 上 5 种类型 |
| 敏感数据掩码 | ✅ 明文不存在，`••••••` 存在 |
| 根观测 I/O 有意义 | ✅ |
| session / tags / version / environment | ✅ |
| 生成渲染成对话 | ✅ OpenAI 消息格式 |

新解锁的能力，按价值排：

1. **消融两臂可以横比成本与延迟**——此前只有覆盖率能比。
2. **前缀缓存命中率成为可观测的数**。这条流水线的速度大半来自它（实测 ~9k 请求里 ~6k 命中），
   而在此之前没有任何地方能看到它掉了。
3. **`truncated` 成为一个可筛的布尔值**。此前它只在日志里，而截断的产出从外面看只是「短了一点」。
4. **`requestKey` 进 metadata**：两条 trace 上指纹相同 = 发出去的是同一个请求。
   对照两次运行为什么产出不同，这是第一个要看的东西。

---

## 代价与风险

| 项 | 说明 |
|---|---|
| 依赖 | 3 个新包进 `harness-core`。**关掉时零调用**，但仍在依赖树里 |
| 成本归因不完整 | `totalCost=null`：Langfuse 没有 `qwen3-8-27b` 的价目。**要在 Langfuse 项目里加一条 model definition 才有钱数**，否则只有 token |
| runner 内部不可见 | 见变更八。Midscene 每一步的视觉模型调用不在 trace 上 |
| 双写 | 同一件事进两个系统。纪律是「派生，不是第二真相源」，但**这条纪律没有自动化检查** |
| 大产物 | 12,000 字符的裁剪阈值是拍的，不是量的 |

**什么情况下不该开**：跑基准评测且在乎绝对延迟数字时。span 导出是异步的，
但 `forTrace` 的 `JSON.stringify` 是同步的，对一个 21k 字符的产物有实测开销。

---

## 怎么证伪

| 手段 | 内容 |
|---|---|
| **单元测试** | `packages/harness-core/test/langfuse.test.ts`（10 个）。盯的是**没有密钥时的行为**——那是绝大多数情况。`observe()` 必须是直通、错误必须原样上抛、`forTrace` 必须留下截断痕迹 |
| **端到端** | 走生产代码路径发一条真 trace，再用 `/api/public/v2/observations` 拉回来逐条审。脚本在 scratchpad |
| **无法证伪的部分** | 「两套系统不互相矛盾」这条纪律**目前没有自动检查**。可以做：拿同一次运行的 `events.db` 与 Langfuse 的 span 对账，比 node 数与 spend。**尚未实现，如实记在这里** |

> ⚠️ 审计过程中我自己的审计脚本先报了「`model=None`，成本追踪坏了」。
> 那是**脚本读错了字段**（`providedModelName` vs `model`），不是代码的问题。
> 记在这里是因为它印证了本书的纪律：**一个指标算得出数，不等于它在量它声称的东西**——
> 这次是审计工具自己犯的，和 `mutate/detection.ts:76` 那次 relink 精确率恒为 0 是同一种错。

---

## 验收

1. 网关启动日志出现 `Langfuse 追踪已开（gateway）`；agent 启动事件同样。
2. 跑一次真实 G1，Langfuse 上出现一条 trace，树形是 `workflow.run → 6 个节点 → N 个 generation`。
3. 每个 generation 有 `model` 和 `usageDetails.input/output`。
4. 拿一条含 `${secret.*}` 的用例跑一次，Langfuse 上搜不到明文。
5. 跑一次配对评测，两条臂在 `ablate:*` 标签上可分。
6. `LANGFUSE_PUBLIC_KEY` 置空重启，全部测试仍绿，且日志明确说追踪关闭。

---

## 配置

```bash
# server/.env（已写入，且 server/.env 在 .gitignore 里）
LANGFUSE_PUBLIC_KEY="pk-lf-..."
LANGFUSE_SECRET_KEY="sk-lf-..."
LANGFUSE_BASE_URL="https://jp.cloud.langfuse.com"
LANGFUSE_TRACING_ENVIRONMENT="development"   # 测试 trace 不该污染生产视图
```

子进程从网关继承环境（监工 fork 时带 `...process.env`），所以只配这一处。

> **顺带修掉的一个洞**：`.gitignore` 只挡了 `.data.bak-*/`，而工作区里有一个
> `server/.data.snapshot-20260831-1141/`（整套 DB，含加密密钥表）**没有被忽略**。
> 一次 `git add -A` 就会把它提交上去。已加上 `.data.snapshot-*/`。
> 这正是 [第 00 章](./00-方法与约定.md) 说的形状二：一条只挡住其中一种命名的规则，等于没挡。
