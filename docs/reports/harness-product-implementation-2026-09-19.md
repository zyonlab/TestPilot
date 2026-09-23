# 评测驱动 Harness：产品落地记录

日期：2026-09-19。分支：`codex/harness-lifecycle-self-audit`，基于 `d2e62ce`，当前为未提交工作区改动。

## 可以直接操作的产品

进入左侧评测入口 →「迭代评测」。工作台读取服务端真实的实验定义与历史记录，不内置示例分数。

1. 选择实验，查看 A/B 配置、流程、数据集路径、development 条目数与数据指纹。
2. 预检查不满足时显示具体原因并禁用启动；服务端同步执行同样检查，绕过按钮也不能启动。
3. 可运行时点击启动，获得持久记录对应的 ID，页面轮询运行状态。
4. 点击历史记录查看覆盖率、已知成本差异或无效原因。单次诊断不自动选出最佳版本。
5. 展开单次覆盖检查，显式选择运行并输入数据集路径，不再静默使用默认 gold。

桌面和 390px 窄屏均已检查。当前仓库的两个定义在隔离实例中均被阻断：一个缺数据集，另一个声明未支持的 runtime 且缺流程。页面展示 0 可运行、2 待补齐是实际检查结果。

## 生命周期中的代码改动

| 层 / 阶段 | 落地行为 | 关键文件 |
|---|---|---|
| 实验准入 | 验证请求、runtime、消融参数、流程版本、评分节点、显式数据集和 development 项 | `server/src/evals.ts` |
| HTTP 启动 | 先准入再返回 202 + ID；准入失败返回 400，不能先成功响应再后台静默失败 | `server/src/index.ts` |
| 执行与结束 | 完成状态与 cases 产物同时满足才计分；超时取消运行；错误保存为 invalid/failed | `server/src/evals.ts` |
| 评分 | unknown 注入不计分；健康对照的基础设施失败不作为检出；无有效样本时 mutationScore 为 null | `server/src/evals.ts` |
| 诊断边界 | 交互配对仅使用 development 项；不把两个数据切片冒充独立重复实验；缺成本保持 null | `server/src/evals.ts` |
| 人工决定 | 7 项人工专属动作不进入 agent 的工具枚举；手造动作也在传输前拒绝 | `packages/testpilot-mcp/src/host/{registry,tools}.ts` |
| 来源判定 | HostApi 标注 agent，服务端拒绝将该来源视为本地人工 | `packages/testpilot-mcp/src/host/api.ts`、`server/src/reviewPrincipal.ts` |
| 产品交互 | 定义、准入、启动、历史与错误详情闭合；保留旧覆盖检查 | `src/pages/Evals.tsx` |
| 能力统计 | operatorOnly 动作不能继续计入 agent 覆盖；183/183 可用，10 项 UI 专属 | `scripts/check-host-parity.mjs` |

人工专属包括模块冻结、用例审核/修订/候选决策、执行基线、视觉基线与性能基线批准。本地无登录方案保留；来源头与工具限制保护受支持的宿主调用路径，不构成阻止任意本地程序伪装浏览器的强身份认证。

## 自测证据与口径

- 普通回归：Vitest 164 文件、1429 项通过；MCP Node 4 项通过。
- hooks 23 项、scripts/test 7 项通过；全工作区 typecheck、生产构建、drift、host parity、domain neutrality 通过。
- 准入检查：6/6，通过 `pnpm test:harness-readiness` 独立运行，记录源码哈希。
- 原 R01 要求 native runtime 到达适配器，本轮改为未支持 runtime 必须执行前拒绝。能力收窄已披露，不把拒绝算成 runtime 接通。其余原缺口由生产逻辑修复。
- 浏览器真实后端：检查定义、阻断原因、禁用启动、窄屏无整体横向溢出。
- 浏览器隔离 HTTP fixture：检查启动只发一次 POST、历史轮询、无效结果原因及不显示零分。此项是交互测试，不是真实模型实验。
- 新增准入测试覆盖失败产物、合法空 cases、超时取消、提示词漂移、development 隔离、未知成本与不健康对照。

修复前的 `harness-lifecycle-self-audit-2026-09-19.html/json` 保留原始结论，不覆盖历史红灯证据。

## 仍未完成的能力

当前是可信诊断工作台，还不是完整自动选版平台。未实现 native runtime 评测适配器、跨模型重复配对、持久任务恢复、实验定义可视化编辑、完整配置快照与发布晋升。需要将流程版本、模型、提示词、工具和数据集固定为实验快照，并在可信执行端运行 held-out、重复采样和成本门槛，再产生可供人工批准的版本建议。

本轮没有调用真实模型或被测网站，没有训练模型、没有胜出版本结论，也没有提交或推送代码。
