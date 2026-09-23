# 任务 5：上下文检索审计与评估

## 我先遇到的问题

已有实现是标题切块、BM25 和关系邻居，不是没有检索。本任务没有引入向量库。原 requested 路径允许第一块超过预算，未知 ID 被忽略、重复 ID 重复计费；ranked 路径主要留下数量和文字提示。服务端历史表保存的 ID 并不冻结实际 sanitize 后响应，原“相关内容全部取完”提示也把正分候选误当作相关性真值。

实现中先修正了过严的 run 归属判断：正常节点重跑把同项目父运行 revision 放进 sourceRefs，已有 sealInputs 也允许显式绑定同项目历史材料。因此检索的授权依据是本运行 binding 的确切材料 revision，而不是所有祖先都必须属于本 run。真实 rerun → instructions → retrieve 反例现在通过，来源保留 originRunId / inheritance。

首次定向验证发现测试夹具少了一个括号、伪造摘要不符合既有 64 位哈希格式、测试循环需要显式类型，以及 SSR 抽屉需要 window.innerWidth。提前设置 window 又影响了服务端 Midscene 的运行环境识别，因此只在节点 SSR 渲染期间提供视口；没有修改产品执行环境或放宽守卫。旧跨语言提示误称 CJK 一定是中文，本次改为脚本差异。以上失败均已修正后定向复验。

分支 `codex/05-retrieval-audit` 基于 `b69f15fbcb9862e0d9b51afe61d01f2ff8481563`，仅做本地提交。

## 预算与检索契约

- `retrieve/index.ts` 的所有路径共用整块选择器。先 sanitize 标题/正文，再估算 `heading.join('\n') + '\n' + text`；返回 `tokens` 和 `diagnostics.estimatedTokens` 均明确是估算，**不是实际模型输入、计费或缓存 token**。正文以外的 JSON、ID、诊断、外层提示不计入此预算，不能将这个上限当作整个模型窗口的保证。
- 请求预算上限 200,000；服务端请求 query 最多 4,000 字符，chunkIds 最多 256 项、每项 512 字符，过滤前后均校验。显式空 chunkIds 表示不取块，不偷偷切到 ranked。重复请求按首次出现去重；未知必需 ID、预算省略 ID、分发上限省略 ID 分开返回。
- 第一块也必须服从预算。超大块绝不截成无出处片段。每次最多 128 个块，单块过滤后正文最多 12,000 字符、每级标题最多 200 字符；超过时整块列入 deliveryOmittedIds。调用方可以按 ID 增加预算续取；分发尺寸限制需读原来源产物或提交重新分节的材料。
- 正分不等于相关。hint 只报告正分候选，明确未标注时不能推定证据完整；无匹配不代表材料没有相关证据。现有 chunkObserved 的 screen / transition / not explored / plan 区分及失败、未访问语义保留。
- 诊断元数据单独有界：RPC 每类 ID 清单最多 8 项，附 total / nextOffset；文字 hint 最多列 3 个 ID。完整列表存在不可变 revision，RPC 不再重复完整正文。独立目录 MCP 可用 diagnosticOffset 对确定性清单分页；已登记运行通过既有 read artifact 读取完整审计。
- 目录缓存增加版本与内容摘要核对，材料 hash 变化、旧版或内容损坏会重建。已登记运行从本次 binding 的不可变材料重建索引，从不使用目录缓存。

## 实际响应、来源与弱证据

共享真源 `packages/harness-core/src/retrieval-audit.ts` 定义 `retrieval-audit.v1`。`runStages.retrieveRunSpec → retrievalAudit.auditedRetrieve` 保存 `retrieval/<retrievalId>` report，仍沿用原账本及 `run_retrievals` 历史索引；没有平行上下文数据库。导入接口保留该命名前缀，只允许服务端写审计。

审计含 projectId、runId、materialsHash、inputHash、indexDigest、每份材料 revision / contentHash / sourceRefs，以及直接来源的 revision、runId 和摘要。实际返回对象在最后一次 sanitize 后保存为 delivery，`deliveryDigest = SHA256(canonicalJSON(delivery))`。RPC 仅追加 audit 引用，digestScope 明确排除这段自引用。digest 证明服务器构造的结构化响应内容，**不能证明网络已送达、宿主仍保留它、模型注意或服从它**。

读取材料校验 blob 内容摘要、binding 的 materialsHash、项目归属与唯一/规范化 docId。新增同名 revision 不会替换已经封存的输入；显式授权的同项目祖先材料保留历史身份，跨项目读取拒绝。缺失或损坏来源不会悄悄补成已知。

来源类型不按后缀推断：精确 material → collector observation 引用标 runtime-observation；运行显式 sourceKind=spec 标 specification，同时显示“声明，不是权威认证”；其余为 unknown。继承但没有直接采集链的材料保留 inherited/unknown，不给旧观察补当前身份。任务 4 的真实采集→生成材料→封存链已有新增断言核对 observation revision 与摘要。

association 分别保存 serverRunId、当时服务端活动阶段和宿主 declaredNode / declaredUnitId。后两者是声明，当前轮次/单元 visibility 始终 unknown。`basis` 和 `workUnits` 保留原历史来源成员核对，但使用容错读取；不会将历史并集提升为本轮可见证据。旧行能读到的仅是历史 ID，缺预算/digest 均为 null；畸形 JSON、非数组或非字符串 ID 不会崩溃或伪造数值。sourceRefs 出现只证明历史成员关系，不证明语义支持或业务正确；人工门禁没有修改。

## UI 真入口

`NodeDetail` 每个节点中提供明确的**整跑检索历史**折叠入口，显示总数，展开后先显示最近 8 条，按需增加；不按宿主声明的节点伪归属。沿用 `NodeArtifacts → RevisionViewer → RetrievalAudit` 及原 artifact HTTP 接口，artifactLabel、内容与未知状态均有中文/英文/日文。

阅读器显示实际预算使用、选中原因、正文、预算/分发省略、未知/重复请求、来源类型/版本、继承身份、指纹和未评估。长 ID 清单分批显示；旧或损坏产物显示未知，不显示零使用。没有新增复核门禁、导航系统或接口。

## 可重放合成评估

`packages/harness-testing/test/fixtures/retrieval-synthetic.json` 是本任务编写、可逐字审查的合成语料和标签；`retrieval-synthetic.expected.json` 冻结确定性输出。**不是 Gold、held-out、人工批准标签，也不是产品效果基准。** `evaluateRetrieval` 沿原 BM25+关系邻居，报告 requiredRecall、relevantPrecision、missingIds、unknownLabelIds、预算使用与 fixtureDigest。无标签为 null/unassessed；无效标签为 invalid-labels，质量指标 null；空分母不制造成功。没有 90% 门禁，gate 为 null。

复跑：

```bash
pnpm --filter testpilot-server exec tsx scripts/evaluate-retrieval.ts
pnpm --filter @testpilot/harness-testing exec vitest run test/retrieval-audit.test.ts
```

冻结数据的 10 个 query 输出如下。它们只用来捕获行为变化，不承诺跨项目效果。

| 合成 query | 必需召回 | 相关精度 | 估算 / 预算 | 缺失 |
|---|---:|---:|---:|---|
| english | 1 | 1 | 22 / 500 | 无 |
| chinese | 1 | 1 | 11 / 500 | 无 |
| japanese | 1 | 1 | 19 / 500 | 无 |
| cross-language | 0 | 1 | 19 / 500 | portal.md#1 |
| requested（请求包含重复与未知 ID，标签只引用存在块） | 1 | 1 | 11 / 500 | 无；未知请求单列 |
| oversized-first | 0 | 0 | 11 / 20 | large.md#1 |
| ranked-budget | 0.5 | 1 | 11 / 15 | portal.md#2 |
| no-result | 0 | null | 0 / 500 | portal.md#1 |
| unlabeled | null | null | 22 / 500 | null |
| invalid-labels | null | null | 22 / 500 | not-in-corpus，标签错误 |

## 验证

所有数字来自本 worktree 的实际命令输出。完成定向验证后只跑了一次全仓回归，没有把合成通过当作产品验收。

| 命令 | 结果 |
|---|---|
| `pnpm test` | 190 个 Vitest 文件通过；1677 项通过、1 项既有历史图缺失条件跳过；MCP Node 测试另 4 项通过 |
| harness 检索定向 | 新增 8 项通过；既有 MCP retrieve 29 项通过 |
| server 检索 / rerun / routes 定向 | 30 项通过，含检索新增 8 项、真实 rerun 与保留审计前缀 |
| server 检索 + evidence-reuse-flow | 21 项通过，含真实 Chrome 采集与前四任务完整修订链 |
| `vitest --config vitest.reading.config.ts` | 5 个文件、34 项通过；新增 8 项含三语实际 HTTP stage→run→NodeDetail→filter→artifact read→reader 与旧畸形回退 |
| `pnpm typecheck` / `pnpm build` | 全仓类型及生产构建通过 |
| `check:i18n` / `check:domain-neutral` / `check:drift` | 通过；2551 个三语词条引用命中；两个宿主副本一致，本任务没有修改 skill |
| `pnpm --filter testpilot-server exec tsx ../scripts/check-host-parity.mjs` | 188/192，4 个既有 todo，12 条 UI 专属；未新增路由 |
| `pnpm test:hooks` / `node --test scripts/test/*.test.mjs` | 26 / 7 项通过 |
| `node scripts/replay.mjs` | 1 次冻结运行分数与 expected 逐位相同 |
| 检索评估 CLI + `cmp` | 当前 10 个 query 输出与 `retrieval-synthetic.expected.json` 逐字相同 |
| `git diff --check` | 通过 |

最终全仓日志 `/tmp/tp05-full.log`；阅读 `/tmp/tp05-ui-final.log`；类型 `/tmp/tp05-typecheck-final.log`；构建 `/tmp/tp05-build.log`；更新后的 10-query CLI 输出 `/tmp/tp05-evaluation.json`。SSR 仍有既有 Tailwind content 警告，断言与生产构建均通过。

定向覆盖 query/ranked/requested、英文/中文/日文与跨语言缺失、超大首块、重复/未知 ID、空结果、材料变更/缓存损坏、跨项目、同项目合法继承、旧畸形记录、来源引用及真实过滤→读取→渲染入口。

本 worktree 仅建立不含凭证的忽略 `server/.env` 占位，未读生产凭证。没有调用被测产品 API、没有执行测试网业务，没有改变 testnet-only、主网 denylist、人工冻结/批准、Gold、held-out 或人工标签。真实 Chrome 测试是本地合成 UI 与模拟模型端点的既有链路，不是产品业务验收。独立目录模式具有严格预算与分页诊断，但没有登记运行的 project/run 身份或账本审计，不能冒充已绑定分发。

本任务所有受控变更进入独立本地提交，最终 SHA 由交接消息提供。提交后工作树 clean；没有 push、合并或启动后续任务。
