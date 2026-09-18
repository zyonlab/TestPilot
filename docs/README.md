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
| [09 · 执行目标与接手指南](v3/09-执行目标与接手指南.md) | 目标、当前阶段、现状、下一步、验收命令、交接记录格式与最近变更 | Goals, current scope and status, next steps, verification commands, and the latest change log |
| [10 · 安装与诊断](v3/10-安装与诊断.md) | 前置条件、安装、`doctor` 检查项、守卫与本机数据 | Installation, the `doctor` checks, guard and local data |
| [14 · Claude Code 与 Codex 接入实操](v3/14-Claude-Code与Codex接入实操.md) | 宿主接入：从 Web 发起、插件目录、项目级安装、工具顺序、实验性运行时、排障 | Host integration: Web-started runs, plugin directory, per-project install, tool order, experimental runtimes, troubleshooting |

## 仓库级文档 · Repository

- [README（中文）](../README.md) · [README (English)](../README.en.md)
- [参与贡献 · Contributing](../CONTRIBUTING.md)
- [安全策略 · Security](../SECURITY.md)
- [行为准则 · Code of Conduct](../CODE_OF_CONDUCT.md)

## 历史资料 · History

[`v3/history/`](v3/history/) 与 [`archive/`](archive/) 是早期的实验报告、任务台账、设计提案和交接日志，只用于追溯设计来由，**不代表现状**：其中的「最新」「当前」是写作时的说法，部分数字后来被更正过。代码注释里引用的 `docs/v3/history/NN §x` 指向的就是这里。

`v3/history/` and `archive/` hold earlier experiment reports, task ledgers, design proposals and handoff logs. They explain why things are the way they are, but **do not describe the current state**. Code comments that cite `docs/v3/history/NN §x` point here.

`reports/` 里是带日期的 HTML 报告快照，部分测试会读取其中的文件。
`reports/` contains dated HTML report snapshots; some tests read files from it.
