# TestPilot 文档 · Documentation

文档目前以中文为主。English summaries of each document are given below; the README ([English](../README.en.md)) covers setup and usage in English.

## 现行文档 · Current

以下文档对照代码维护，冲突时以代码为准并修改文档。
These documents are kept in sync with the code; when they disagree, the code wins and the document is fixed.

| 文档 | 内容 | English summary |
|---|---|---|
| [00 · 架构](v3/00-架构.md) | 目的与边界、进程与端口、包结构、阶段流水线、运行账本与工作单元、宿主入口、守卫、领域数据、质量机检，每项带代码位置 | Architecture: scope, processes, packages, pipeline stages, run ledger and work units, host entry, guard, domain data, quality checks — with code locations |
| [01 · 数据契约](v3/01-数据契约.md) | 各类产物的 schema 真源：账本修订命名、产品模型、规则包、模块树、故事与用例包、判据、门禁报告、工作单元、代码包、回归候选与归因报表 | Data contracts: where every artifact's schema lives and its key fields |
| [02 · 工作流：横向与纵向](v3/02-工作流-横向与纵向.md) | 横向：全流程图、各阶段读写、运行状态机、暂停/续跑/门禁打回、旧图系统；纵向：新建运行、冻结模块树、复核、编译执行、看报告五条时序图；已知缺口 | Workflows: the end-to-end flow, per-stage inputs/outputs, the run state machine, and five sequence diagrams (create run, freeze modules, review, compile & execute, reports), plus known gaps |
| [03 · 用户故事](v3/03-用户故事.md) | 按代码梳理的 14 个史诗、43 条用户故事：角色、只能由人做的决定、每条故事的验收要点与代码落点，标出部分实现与已知缺口 | User stories derived from the code: 14 epics / 43 stories with acceptance points and code locations, partial implementations and gaps marked |
| [04 · 分层功能实现](v3/04-分层功能实现.md) | 界面、API 服务、进程、领域包、通用底座、宿主接入、数据存储七层：每层功能落在哪个文件与函数、读写什么、有什么红线；一条运行怎样穿过各层 | Layered implementation map: seven layers, each feature mapped to file::function, data and constraints; one run traced through the layers |
| [09 · 执行目标与接手指南](v3/09-执行目标与接手指南.md) | 目标、当前阶段、现状、下一步、验收命令、交接记录格式与最近变更 | Goals, current scope and status, next steps, verification commands, and the latest change log |
| [10 · 安装与诊断](v3/10-安装与诊断.md) | 前置条件、安装、`doctor` 检查项、守卫与本机数据 | Installation, the `doctor` checks, guard and local data |
| [14 · Claude Code 与 Codex 接入实操](v3/14-Claude-Code与Codex接入实操.md) | 宿主接入：从 Web 发起、插件目录、项目级安装、工具顺序、实验性运行时、排障 | Host integration: Web-started runs, plugin directory, per-project install, tool order, experimental runtimes, troubleshooting |
| [15 · 节点提示词、领域知识与学习回路](v3/15-节点提示词与领域知识重构实施.md) | 执行语义常驻、准备说明按需读、跨步骤读数判据、停批前复核；反例回流、界面事实候选、标准测试集、执行模型评估（阶段 0～9，带验收记录） | Node prompts and domain knowledge: execution semantics, on-demand preparation guides, cross-step reading oracles; the learning loop (counterexamples, interface fact candidates, standard sets, executor evaluation) |

## 专题说明 · Topic guides

按代码核对过（2026-09-28），讲单个功能怎么用：

- [探索交给本机宿主规划](guides/explore-host-planning.md)：Explore 把组件交给本机 Codex / Claude Code 规划、四批上限、结果怎么回报 · Explore planning by the local host
- [项目知识库](guides/project-knowledge-library.md)：带版本的领域知识与规则包、内置示例、项目选定的规划宿主 · Versioned knowledge library and planner host selection
- [登录态复用](authentication/session-reuse.md)：`sessionChecks` / `injectedSessionCheck`、会话复用与 `AUTHENTICATION_NOT_VERIFIED` · Session reuse and authentication checks
- [节点质量评测](evaluation/node-quality.md)：节点产物对比、测试分层、`pnpm eval:node-quality` · Node artifact comparison and quality evals
- [产物阅读规则](ui/artifact-reading.md)（English）：`RevisionContent` 的渲染规则与验证 · Artifact rendering rules
- [评测定义怎么写](../evals/README.md) · How to write eval definitions

## 仓库级文档 · Repository

- [README（中文）](../README.md) · [README (English)](../README.en.md)
- [参与贡献 · Contributing](../CONTRIBUTING.md)
- [安全策略 · Security](../SECURITY.md)
- [行为准则 · Code of Conduct](../CODE_OF_CONDUCT.md)

## 历史资料 · History

[`v3/history/`](v3/history/) 与 [`archive/`](archive/) 是早期的实验报告、任务台账、设计提案和交接日志，只用于追溯设计来由，**不代表现状**：其中的「最新」「当前」是写作时的说法，部分数字后来被更正过。代码注释里引用的 `docs/v3/history/NN §x` 指向的就是这里。

`v3/history/` and `archive/` hold earlier experiment reports, task ledgers, design proposals and handoff logs. They explain why things are the way they are, but **do not describe the current state**. Code comments that cite `docs/v3/history/NN §x` point here.

`handoffs/`、`tasks/` 是 2026-09-23 那一轮的交接与任务说明（被 09 §7 引用）；`reports/` 里是带日期的报告与原型快照，部分脚本和测试会读取其中的文件。
2026-09-28 按「代码或现行文档还在引用的保留、其余删」清过一轮：删掉约 110 项（旧任务、交接、一次性报告、原型快照、没人引用的原始证据），都在 git 历史里；`v3/evidence/` 不进 git，只在本机。
`reports/` contains dated HTML report snapshots; some tests read files from it.
