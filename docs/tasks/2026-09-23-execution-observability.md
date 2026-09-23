# 任务 1/5：执行与准备的阶段观测

## 我先遇到的问题

- 原执行器已有六段墙钟和代理调用记录，但重试只保留最后一次结果，失败尝试的阶段证据被覆盖；重试前没有及时扣除已发生调用的预算。
- 会话启动函数包含浏览器启动、首次导航及 agent 建立，没有可分离的可靠计时回调。我按真实边界记录 `session-navigation`，没有推算更细时间。
- 编译内容参与不可变修订的去重和执行前重编校验。我没有向代码包塞时间戳；编译观测单独存为 report。
- 初次定向测试遇到新 worktree 的 Midscene 缓存目录未建立，已有代码检查悬空 symlink 后重复创建。验收前建立了本 worktree 的空缓存目录，没有链接生产缓存。
- 初次全量检查发现现有 evolution 沙箱测试要求 `server/.env` 存在；本 worktree 使用空白文件满足路径前提，没有复制任何凭据。准备测试关闭数据库前仍有监督 interval，本次测试收尾等待一个监督周期，让真实终止状态自然清除 interval。

## 实现与真实调用链

共享真源是 `packages/harness-core/src/execution-observation.ts`，通过 `@testpilot/harness-core/execution-observation` 导出。runner 的 `RunResult`、服务端的回执和 UI 读取同一个 schema；版本为 1，字段缺失或版本未知显示“未采集阶段观测”。没有迁移或改写旧产物。

1. `approvedRuns.generateApprovedCode` 测量确定性编译，另存 `compilation-observation/<id>` report，成功回执引用代码修订；静态门禁阻塞及编译失败有失败状态。执行前内部重编仍用同一实现，但不反复创建编译回执。`workflowExecution` 测量每次批准版本校验。
2. `workflowExecution.perform` 记录校验、环境重置、调度等待、重试等待；每条结果保留 `attempts[]`，包括每次真实 runner 观测，RPC 未返回的尝试使用 `observation:null`。失败尝试的代理调用在重试前计账，缺调用记录后停止重试，不把后一次已知值补作前一次证据。
3. `apps/runner.execCase → exec/run.executeRun → exec/session` 记录会话与首次导航、认证、页面准备、业务动作、断言及清理。`afterStep` 断言单独计入断言区间，业务动作可有多个区间。清理失败不能留下绿色结果，也不能覆盖已存在的业务失败；清理失败本身另记在阶段观测中。
4. `preparation.trial` 在现有不可变回执保存 runner 观测，并保存服务端的 `serviceObservation`。取消后已收到的结果保留其观测、代理请求和调用账，回执状态为 cancelled，不晋升 verified；恢复先发生时，旧 generation 的迟到结果单独保存，不改变新单元。RPC 没有结果时仅保留可测的服务端边界。
5. 现有执行详情、离线展开、准备产物阅读器和编译节点产物列表接入共同组件；中文、英文、日文均具备文案。显示阶段耗时、状态与归因、转发/拦截调用及来源、尝试编号、重试原因、缓存证据；“最长单段”明确是一个区间，不是同名阶段累计。

## 证据语义与敏感字段

- `model.source=role-proxy` 仅来自实际请求数组；`forwarded` 和 `blocked` 分开。不可得或旧请求缺少 forwarded 标记时，计数为 null。确定性编译/校验的零调用有明确的 deterministic 来源。
- 只在实际 `acquireSession` 返回后记录会话缓存 hit/miss；没有启用会话池时为 unavailable。Midscene 内部缓存没有可靠命中事件，始终 unknown，不用“零模型调用”推断缓存命中。
- 调度等待包含执行器执行，服务端区间和 runner 区间不能相加。浏览器清理也有独立区间；遗留 `phases` 继续兼容旧读者，新报告使用 observation。
- 观测 schema 只接受阶段枚举、数值、状态、来源、归因枚举和重试原因枚举；解析会丢弃额外字段。没有 prompt、URL、endpoint、账户、密钥、环境变量或原始异常文本。原有截图/日志/代理记录保持其原有证据通道。
- 认证阶段完成只表示走完检查，不表示认证已验证；实际 unknown 前置条件仍中止业务步骤，不能成为通过。

## 验证

最终命令与结果（本地输出逐项核对）：

| 命令 | 结果 |
|---|---|
| `pnpm test` | 182 个 Vitest 文件；1546 项通过、1 项因历史审计图文件缺失而条件跳过；同命令内 MCP Node 测试另 4 项通过 |
| `pnpm --filter testpilot-server exec vitest run --config vitest.reading.config.ts` | 2 个文件、16 项通过，含观测组件及准备回执的三语 SSR 渲染、未知/取消/旧记录 |
| `pnpm typecheck` | 全仓通过；末次 UI/详情兼容微调后另跑 app/server typecheck 通过 |
| `pnpm build` | 最终生产构建通过 |
| `pnpm check:domain-neutral` / `check:i18n` / `check:drift` | 通过；2414 条三语词条；两个宿主副本与真源一致 |
| `pnpm check:host-parity` | 通过，188/192；4 条既有 todo、12 条 UI 专属，没有新增路由 |
| `pnpm test:hooks` | 26 项通过 |
| `node --test scripts/test/*.test.mjs` | 7 项通过 |
| `node scripts/replay.mjs` | 1 次冻结运行重放，分数与 expected 逐位相同 |
| `git diff --check` | 通过 |

定向测试覆盖：真实 executeRun 控制流的动作/准备/断言/清理失败、启动失败、取消、unknown 前置条件、会话池 hit/miss 与请求偏移；服务端实际 SQLite 修订持久化、8 秒基础设施退避重试及调用预算、RPC 取消、编译去重、准备取消/恢复与迟到结果竞态；schema 敏感附加字段剥离。真实本地 Chrome runner 的 4 项测试包含 RPC 截图/性能及导航中取消，结果穿过进程边界后仍有观测。

测试使用隔离数据库、空配置和本地合成页面；受控 adapter/mock 测试验证真实控制流和存储契约，不作为业务验收。UI 的 SSR 配置仍打印既有 Tailwind content 警告，不影响断言，生产构建通过。

## 后续接点与限制

本任务仅负责观测，没有实现 fixture、检索算法或重构执行器。后续任务可复用共享 schema 和准备回执，不能把“测到一段执行”解释成前置条件已满足。

本地真实 Chrome runner 测试覆盖进程 RPC、会话启动、截图与导航中取消；未调用真实模型，也没有执行测试网业务。主网 denylist、人工冻结/批准与 held-out 隔离规则未修改。没有读取生产数据或向被测站 API 发请求。

进程崩溃/IPC 失败而没有返回结果时，内部阶段仍不可得；此时只显示服务端调度证据。已有服务重启恢复逻辑继续标 interrupted，不伪造丢失阶段。阶段耗时用于这次运行的排查，不代表跨环境性能结论。
