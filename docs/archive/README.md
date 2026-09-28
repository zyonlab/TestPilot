# 归档

这里放的是**写在当时是对的、现在不再描述这个系统**的文档。现状看 `docs/v3/`。

2026-09-28 清理过一轮：只留下还被代码、测试、脚本或评测数据按路径引用的文件，其余删掉了
（要追溯去 git 历史里找）。留下的每一份都有人在读：

| 文档 | 谁在引用它 | 为什么还留着 |
|---|---|---|
| [`refactor/`](refactor/)（重构手册，整目录） | `scripts/check-doc-refs.mjs`、`scripts/fix-doc-refs.mjs` 整目录扫描；`11`、`16`、`18` 另被代码注释引用 | 手册里的 `file:line` 由这两个脚本核对 |
| [`spec/00-文档地图.md`](spec/00-文档地图.md) | `server/scripts/probe-endpoint.mjs`、`src/components/CoverageMatrix.tsx` 注释 | 设计来由 |
| [`spec/01-设计依据与实测数据.md`](spec/01-设计依据与实测数据.md) | `fixtures/sample-spec/gold-checklist.json` | 黄金清单的边界说明 |
| [`spec/02-业务规格与用户故事.md`](spec/02-业务规格与用户故事.md) | `benchmark/casegen/`（gold、statement、README）、`evals/runtime-compare.json`、`scripts/build-prototype-refinement.py` | 自举评测的语料，改它等于改考题 |
| [`spec/03-UI交互规格.md`](spec/03-UI交互规格.md) | `benchmark/casegen/`（gold、replay 夹具）、`scripts/build-prototype-refinement.py` | 同上 |
| [`spec/06-通讯协议.md`](spec/06-通讯协议.md) | `harness-core` 事件信封、`exec/run.ts`、`server/src/db.ts`、`src/lib/ws.ts` 注释 | 事件协议的设计来由 |
| [`spec/09-prototype-workspace.html`](spec/09-prototype-workspace.html) | `scripts/build-prototype-refinement.py` | 原型构建的底稿 |
| [`spec/13-重新规划.md`](spec/13-重新规划.md) | `harness-core/src/model/openai.ts`、`codegen/gate.ts` 注释 | 设计来由 |
| [`spec/17-整体UI重构-任务与进度.md`](spec/17-整体UI重构-任务与进度.md) | `scripts/plan.mjs`（默认台账）、两处测试注释 | `plan.mjs` 不给参数时读它 |

注意：`benchmark/casegen/gold.json` 与 replay 夹具里写的是旧路径 `docs/spec/…`，指的就是这里的
`spec/02`、`spec/03`；gold 冻结，不改。
