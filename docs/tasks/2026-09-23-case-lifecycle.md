# 任务 2：用例生命周期与异常补偿

## 我先遇到的失败

- `executeRun` 原本只在主 try 的尾部执行 postSteps，动作抛错会跳过全部清理；失败会话还有机会留在池里。导出虽有 finally，首条清理抛错会跳过剩余项并覆盖原业务异常。
- 源码没有平均步数或泊松门禁；真实存在的是 `gate.ts` 的 minSteps/maxSteps 粒度门禁。我移除它的步数判定，用显式生命周期引用和义务检查代替；兼容保留旧选项但不再据此扣分。
- 新 worktree 首次缺依赖和 `server/.env`。我安装锁定依赖，用空 `.env` 满足既有沙箱测试路径要求，没有复制生产配置。首次真实 runner 脚本还缺父进程模型票据接口，补上现有 Gate/lendGate 后重跑。
- 我在服务端链路测试中发现“创建”文字并非现有门禁认可的具体点击动作，修正合成用例为 Click Create；没有放宽门禁。历史测试中无执行阶段证明的基础设施重试也不能再默认安全，改为明确的启动阶段失败回执。

## 契约与支持范围

`TextCase.lifecycle` 是可选的版本 1 审核契约；旧不可变产物保持缺失，显示 unknown，不自动补成已验证。新生成的受限解码 schema 要求该字段，宿主工作单元与 design skill 同步说明；design skill 版本为 `2026-09-23.2`，两个宿主副本已经重建。没有新增人工审批点。

- `mode` 为 read-only 或 controlled；rationale 说明业务理由；sourceRefs 必须属于本用例真实来源，supports 绑定原 `$expected` 或 assertion id。
- baseline 复用现有 PrerequisiteCheck，逐条覆盖 precondition 原文。生命周期证据仅接受同屏确定性 oracle，不接受“verified”声明，也不接受接口、模型判官或历史差值替代同屏证据。只读/拒绝用例可以只有一个动作；拒绝是否真的无副作用仍由原验收断言和明确基线证明。
- resources 引用现有 steps 的 establishAfterStep，不引入资源脚本。identity 包含 `${env.TP_LIFECYCLE_ID}`；runner 每次生成 UUID，覆盖同名用户变量。建立前验证该身份在当前屏幕不存在，开始建立动作前就登记可能产生的资源，以覆盖“动作已生效但随后抛错”。
- established、ownership 与 cleanup.verified 的 oracle 必须引用身份；步骤与 postSteps 也绑定该身份。清理引用原 postStep 编号，逐项验证、补偿。重复资源身份、重复清理步骤映射、缺来源/断言/前置/补偿均报告契约错误。runner 在启动前再校验，直接调用不能绕过 schema 或引用检查。
- **当前支持本次执行创建、屏幕可区分身份的隔离资源。** 不支持修改共享既有 fixture 后自动恢复，也不支持外部预配置资源的自动认领。材料缺身份或归属证明时应保留 blocked/unknown。领域账户、资源名称、规则和来源只能来自项目数据。
- 生命周期基线在 preparation.steps 前验证。controlled 用例拒绝无 recipe 的非空 setup；保留原 none/ui-only recipe 的完整步骤与 entry/postcondition 验证边界。可变资源建立必须留在已审核业务步骤中，不能偷偷搬进 setup。没有给 recipe 增加可变资源脚本能力。

**同屏证明的范围有限。** 唯一身份、当前页面和项目提供的归属条件共同约束清理；这证明的是当前可见证据，不是数据库所有权、跨页面完整性或自然语言动作绝对无越界。检查包含字符串只是引用校验，真正通过来自执行时读取页面后的 oracle 求值。页面不可读、会话关闭、来源不足都不能推断资源已消失。没有访问被测产品 API。

## 执行、准备与导出

- `exec/lifecycle.ts` 复用 prerequisites 的检查执行；`run.ts` 在 finally 尝试清理，记录 pass/fail/unknown/not-run、检查证据及 pendingResources。首项失败不跳过后续项。businessStatus 与生命周期回执分开；保留原 failureReason、failure 归因和已得到的 oracle，不用清理错误覆盖原失败。
- 前置、启动或基线失败且尚未建立资源时不清理；取消/关闭会话不发送清理动作、不声称已回收。失败或未验证资源的会话不能复用，成功旧只读会话保留已有池行为。禁止自动重放可能已有副作用的动作、定位点击或整条用例；成功补偿也不代表可以安全重复业务。
- 旧 postSteps 仍在业务开始且会话可用时逐项 best-effort。动作完成但没有验证 oracle 记 unknown，并留下未知资源；平台结果不能当作生命周期已通过。只关闭浏览器不等于清理资源；关闭失败使用已有 cleanup 观测区间，业务失败仍保留。
- 准备器冻结完整 lifecycle、来源以及受控步骤/postSteps 的精确绑定。probe 不执行业务资源建立；trial 和正式 workflow execution 传递同一份契约、前置与来源。服务端预检认识 runner 保留占位符，但不能替 runner 声称验证成功。有 pendingResources 或丢失试跑回执时停止自动修复重试；正式批次遇到待处理资源也停止继续执行。
- 取消 RPC 给 runner 最多 3 秒回传实际回执；未返回时仅保存 unknown 的资源/清理状态，不能制造执行证据。继续使用任务 1 observation 阶段，不新增平行计时；遗留 phases 在清理开始重新取起点，避免异常路径重计。
- 新显式 lifecycle 的独立导出报 `export_lifecycle_unsupported`，已审核投影不会先把契约丢掉。旧 postSteps 导出保留逐项尝试、cleanup-receipts 附件、unknown 无判据状态、多错误聚合及原业务异常；含清理的导出测试关闭自动 retries。旧独立套件只报告业务判决和附件，不能把其业务 passed 解读为清理已验证。
- 旧看板单例执行无法持久化完整生命周期回执；携带新契约时在 reset/业务之前明确报 `lifecycle_requires_workflow_execution`，使用已有工作流正式执行入口。没有静默降级为普通 postSteps。
- 复核 CaseBody、用例产物、准备计划/回执、在线与离线执行详情显示义务和实际回执，中文/英文/日文齐全。schema 无效或旧产物安全回退为未知，不因非数组字段崩溃。

## 验证与证据

最终验证日志在本地测试输出；可复跑命令如下。

| 检查 | 结果 |
|---|---|
| `pnpm test` | 183 个 Vitest 文件；1563 项通过，1 项既有条件跳过；MCP Node 测试另 4 项通过 |
| `pnpm --filter testpilot-server exec vitest run --config vitest.reading.config.ts` | 18 项通过，含三语生命周期、旧/损坏产物与取消回执渲染 |
| `pnpm typecheck` / `pnpm build` | 通过；最终小改动追加定向类型与构建检查 |
| `check:drift` / `check:domain-neutral` / `check:i18n` | 通过；2430 个三语词条 |
| `pnpm --filter testpilot-server exec tsx ../scripts/check-host-parity.mjs` | 188/192，4 条既有 todo，12 条 UI 专属；根脚本的 tsx 不在根依赖路径，使用 server 已安装的同一执行器 |
| `pnpm test:hooks` / `node --test scripts/test/*.test.mjs` | 26 项 / 7 项通过 |
| `node scripts/replay.mjs` | 1 个冻结运行分数与 expected 逐位相同 |
| `git diff --check` | 通过 |

13 个生命周期定向单测覆盖：动作异常后的清理、两项清理失败继续、原失败归因不变、业务成功但清理失败不能绿、基线/前置失败不误清理、取消、关闭页面、归属不符、旧回执未知、无效契约在启动前阻断、无边界准备阻断、保留身份不可覆盖、短用例与长用例不受固定步数门禁。服务端新增真实 SQLite 修订链测试覆盖 probe→trial→冻结 prepared bundle→正式派发、冻结防弱化、保留占位符、脏资源禁止重试；导出测试实际执行生成 JS，验证所有清理项被尝试且原异常保持同一对象。

`pnpm --filter testpilot-server exec tsx scripts/verify-case-lifecycle.ts` 使用真实 Chrome、runner 子进程、RPC、DOM 按钮、截图与同屏 oracle，跑了 3 个本地合成场景：

| 场景 | 业务 | 生命周期 |
|---|---|---|
| 创建并回收本次资源 | passed | 清理 pass，无 pending |
| 业务断言失败 | failed，assert 归因保留 | 清理 pass，无 pending |
| 当前可见归属不符 | passed | 清理 fail，保留 1 个 pending，总体 failed |

3 个场景均零模型请求，未连外部模型。脚本输出的 results.json 与截图留在临时证据目录，日志给出路径；它是本地 runner 证明，**不是测试网真实业务完成**。取消/动作异常的细分由受控单测及仓库真实 runner 测试补充。

本任务没有执行测试网业务，也没有接触主网。本任务未绑定并核验测试网隔离资源的身份/归属材料，因此真实产品生命周期仍为 unknown；不把本地合成场景推广为产品验收结论。仅做本地提交，不推送、开 PR、合并或推进任务 3。

## 任务 4 的验证入口兼容维护

2026-09-23：任务 4 收紧探索定位复用后，无采集身份的裸 locator 不再允许直接点击。`verify-case-lifecycle.ts` 改用真实 Midscene/RPC 请求本地 HTTP 模型模拟器，按预定坐标驱动 Create/Delete，保留上表的三个生命周期断言。原记录中的“零模型请求”是任务 2 当时的历史结果；更新脚本会记录模拟模型请求，不能当作真实 VL 性能。生产定位安全契约和生命周期契约没有为此放宽。
