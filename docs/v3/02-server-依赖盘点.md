# server/ 对 harness-core 的依赖盘点（Phase 1C）

> 生成方式：`grep '\{…\} from "@testpilot/harness-core"'` 全量解析 `server/**/*.ts`。
> 口径：**15 个文件、88 处引用、57 个不重复符号**（任务书里说的「14 文件 55 符号」漏了
> `server/harness.config.ts` 与 `server/test/**`——它们同样会在 harness-core 退役时断掉，
> 所以一起盘）。
>
> 三档的含义，按 `docs/v3/00-架构.md` §2 的切法：
>
> - **留**：这是**产品层**的东西。harness 换成 Penguin 之后它还在原地，不动。
>   （其中一部分将来会随 harness-core 拆包搬家，但那是搬运，不是替换。）
> - **换**：这是 **harness 层**的东西，职责由 Penguin session / MCP 工具接管。
>   Phase 1C 只换**起跑**与**读产物**这两条路；其余留到 Phase 3。
> - **删**：Phase 1C 之内就可以不再有调用方的。**本轮为 0**——旧图运行时整条路
>   由 `TP_RUNTIME=graph` 保活（架构 §8「不删测试」的同一条理由：先并行，再退役）。

## 0. 一句话结论

| 档 | 符号数 | 说明 |
|---|---|---|
| 留 | 38 | 事件总线 / 进程监管 / 模型闸门与追踪 / 占位符解析 / 打分与配对统计 / 指纹 |
| 换 | 19 | 图定义、图存储、拓扑、节点注册、产物存储——Penguin session + `runs/<runId>/*.json` 接管 |
| 删 | 0 | 本轮不删。见上。 |

**Phase 1C 真正动刀的只有两处**：`graphs.ts::startRun`（起跑 → `penguin.startRun`）
与产物读取（`outputStore`/`nodeOutput` → `penguin.readRun`）。其余 17 个「换」的符号
在 `TP_RUNTIME=graph` 这条保活路径上仍被调用，Phase 3 才摘。

## 1. 逐文件

### `server/src/ws.ts` [3] —— 全留
| 符号 | 档 | 为什么 |
|---|---|---|
| `PROTOCOL_VERSION` | 留 | WS 协议版本，产品层前端在用（`src/lib/ws.ts` 带 `?v=`） |
| `EventBus` | 留 | **这条总线就是 Penguin 事件的落点**：`penguin.startRun` 把 `NodeEvent` 转成 `wf.node` publish 上去 |
| `Envelope` | 留 | 同上 |

### `server/src/procs.ts` [14] —— 全留
| 符号 | 档 | 为什么 |
|---|---|---|
| `EventBus` `EventKind` `SqliteEventStore` `startRetention` | 留 | 事件总线与它的持久化。产品层的 WS 与 lineage 都靠它 |
| `Supervisor` `ProcStatus` | 留 | 进程监管（runner / 能力进程）。Penguin 不接管 runner |
| `capabilityToSpec` `CapabilityRecipe` `resolveHarnessConfig` | 留 | 「能力」页（起 anvil / 代理 / SUT）——纯产品层功能 |
| `Gate` `lendGate` `setModelLease` | 留 | 模型准入闸（全局串行）。server 自己仍有模型调用：chat / refineCase / regenerate / adjudicate |
| `startTracing` `shutdownTracing` | 留 | Langfuse 追踪。Penguin 有自己的 trace，但 server 侧调用仍要记 |

> 注：`supervisor` 监管的 `agent` 子进程（图运行时）在 Phase 3 退役；那时 `Supervisor`
> 本身仍留着（runner 还在）。

### `server/src/graphs.ts` [17] —— 换 12 / 留 5 · **本轮主战场**
| 符号 | 档 | 去向 |
|---|---|---|
| `NodeRegistry` `registerPack` | 换 | 节点类型注册 → 九步进 `run_pipeline` 里的 `for` 循环（Phase 0 已证明 `NodeContext` 与图运行时耦合为 0） |
| `SqliteGraphStore` `GraphDef` `RunMode` `diffGraphs` `topoOrder` `upstreamOf` | 换 | 图定义/版本/拓扑 → skill + 参数（架构 §6：US-15 拓扑=skill+参数） |
| `SqliteOutputStore` | 换 | 节点产物 → `runs/<runId>/{stories,cases,gate}.json`。**Phase 1C 里两者并存**：`penguin.startRun` 跑完把产物回写进 outputStore，`review.ts` 因此一行不改 |
| `gated` `modelFromEnv` `traced` | 留 | 这是 server 自己那个 `model` 单例（探活、生成代码、复核里的改写在用），不是图的 |
| `digestTexts` `TextDigest` | 留 | 提示词指纹 = 契约 §1 `RunMeta.promptsDigest` 的形状，**Penguin 侧也要用它** |
| `resolveText` `resolveMap` `ResolveContext` | 留 | `${env.*}` / `${secret.*}` 占位符解析——环境绑定，纯领域 |

### `server/src/review.ts` [4] —— 全留
| 符号 | 档 | 为什么 |
|---|---|---|
| `ABLATABLE` | 留 | 消融名录，界面展示用（哪个组件被关了） |
| `gated` `modelFromEnv` `traced` | 留 | 复核里的「重新生成 / 改写这条」是 server 自己的模型调用 |

### `server/src/evals.ts` [18] —— 换 0 / 留 18（Phase 3 迁 MCP）
`ALL_ABLATABLE` `parseAblation` `methodMix` `comparePaired` `mcnemar` `PairedBinary`
`scoreCoverage` `scoreStructural` `StructuralModel` `CoverageResult` `GoldChecklist`
`CandidateCase` `adjudicateMisses` `digestDiff` `TextDigest` `gated` `modelFromEnv` `traced`

打分与配对统计。契约 §5 里它们是 MCP 的 `score_run` / `paired_eval`，**但那是 1A 的活**，
而且架构 §3 P1 明说「配对评测直接调工具，绕过 agent」——所以这条路不经过 Penguin session，
Phase 1C 不碰。标 **留**，Phase 3 改为调 MCP。

### `server/src/index.ts` [8] —— 换 3 / 留 5
| 符号 | 档 | 去向 |
|---|---|---|
| `validateGraph` `describeDiff` | 换 | 图编辑器的路由（`POST /api/graphs`、`/diff`）。Phase 3 随画布退役 |
| `ALL_ABLATABLE` | 留 | 起跑面板的消融勾选项，展示用 |
| `trimMiddle` | 留 | 字符串工具 |
| `resolveText` `resolveMap` `redact` `ResolveContext` | 留 | 占位符解析与密钥打码——领域 |

### `server/src/chat.ts` [10] —— 换 7 / 留 3
| 符号 | 档 | 去向 |
|---|---|---|
| `GraphDef` `diffGraphs` `describeDiff` `validateGraph` | 换 | 「跟它说话改图」。Phase 3 随画布退役 |
| `CapabilityRecipe` `CapabilityRecipeSchema` | 留 | 能力配方（起进程），产品层 |
| `ABLATABLE` | 留 | 展示 |
| `gated` `modelFromEnv` `traced` | 留 | chat 自己的模型调用 |

### `server/src/continue.ts` [1] · `server/src/evalspecs.ts` [1] · `server/src/model.ts` [4] · `server/src/exec.ts` [2] · `server/harness.config.ts` [1]
| 文件 | 符号 | 档 | 为什么 |
|---|---|---|---|
| `continue.ts` | `GraphDef` | 换 | 「跑完 g1 接着跑哪张图」→ 下一个 session 的 skill 参数 |
| `evalspecs.ts` | `ALL_ABLATABLE` | 留 | 评测规格里的消融名录 |
| `model.ts` | `OpenAIModel` `ModelClient` `gated` `traced` | 留 | server 自己的模型客户端 |
| `exec.ts` | `EventKind` `Envelope` | 留 | 执行进度事件 |
| `harness.config.ts` | `defineHarnessConfig` | 留 | 进程/能力配置，产品层 |

### `server/test/**` [5] —— 全留
`chat-schema.test.ts::CapabilityRecipeSchema`、`graph-layout.test.ts::GraphDef`、
`ws.test.ts::{EventBus, EventKind, MemoryEventStore}`。
**一条都不删**（架构 §8）。`graph-layout` 走的是保活的 `TP_RUNTIME=graph` 那条路。

## 2. 本轮之后 server 与 harness 的接缝

```
起跑   POST /api/wf/runs
         ├─ TP_RUNTIME=penguin（默认）→ penguinRun.ts::startRun
         │     ├─ 挂了项目 → prepareMaterials(projectId)：把**探索产物**渲染成 markdown
         │     │              （架构 §10：材料 = 观察，不是文档；`run_pipeline` 只收 *.md/*.txt）
         │     ├─ penguin.ts::writeAgentConfig → agent_state/system_config.yaml 的 mcpServers
         │     ├─ penguin.ts::startRun → `penguin run --background --json` → {sessionId}
         │     └─ penguin.ts::watchRun（3s 轮询）
         │           ├─ runs/<id>/events.jsonl → NodeEvent → bus.publish("wf.node")
         │           │                                    + "wf.node.started/finished"（画布仍认旧 kind）
         │           └─ gate.json 出现 → readRun → outputStore.set(id,"gate") → status=done
         └─ TP_RUNTIME=graph（保活）  → graphs.ts::startRun（原样，六个测试跑这条）

重启   reconcilePenguinRuns()：看门狗活在网关内存里，session 活在 :7364 上——
       网关一重启（dev 模式下改一行就重启）此前会把一次正在跑的运行永久丢在 running/interrupted。

读产物 GET /api/review/:runId → review.ts::reviewBatch（**一行没改**）
         └─ outputStore.get(runId,"gate") ← 跑完回写

写决定 POST /api/review/:runId/approve|reject → index.ts::mirrorDecisions → penguin.ts::writeDecisions
         ├─ runs/<runId>/decisions.json（契约 §1，给下一 session 的 read_decisions）
         └─ db.review_decisions（原样，前端不改）

审计   GET  /api/audit/:runId/{calibration,scan,diff}
       POST /api/audit/:runId/labels
         ├─ benchmark/binance-futures/gold.json（**只读 gold.json，草稿不算**——架构 §10 的 P2）
         ├─ benchmark/binance-futures/human-labels.json + held-out/human-labels.json
         └─ scans/<runId>.json
```

## 3. 两条本轮定下的边界

**① 会话不进 YAML。** `writeAgentConfig` 往 MCP 子进程里塞的是**引用**（`TP_SERVER_URL` /
`TP_PROJECT_ID` / `TP_ENV_ID`），不是登录态本身。理由有两条，任一条都足够：业务规则 5
「密钥只出不进：可写入、可引用、永不回显」——写进一个明文配置文件就是回显；而架构 §10 说
Binance 的会话**有有效期**，烤进配置里过期之后的表现是「SUT 把我登出了」而不是
「你的会话过期了」，这两句话指向完全不同的排查方向。视口（`MIDSCENE_SHOT_WIDTH/HEIGHT`
= 1600×1000）不是密钥，直接写。

**② 三元组键只在同一谱系内可比。** `diff` 按 `docs/spec/02` §6 业务规则 1 的三元组配对，
优先用 `run_pipeline` 自己写的 `key`。实测两次 ACME 运行的 key 前缀一个是 `login|`、
一个是 `testlogin|`——**那个键是模型写的**，跨提示词谱系不稳定。这不是要绕过去的缺陷：
契约 §2 本来就说「goldHash 变了即新谱系，跨谱系不比」。同一谱系内它对 caseId 改名免疫
（实测：`c-1` → `c-1x` 认作 `changed`，不是 `removed`+`added`），那正是它要解决的问题。
