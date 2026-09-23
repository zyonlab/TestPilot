# 五项改进的整体 UI 验收

我将五项顺序提交集中在 `codex/evidence-driven-summary`，基于真实服务、SQLite、完整 React 应用和 Chrome 补做浏览器验收。用户授权在验收通过后通过 PR 合入 main；五项原分支保留。

## 发现和修复

1. 新建运行在探索/规格间切换时，React 将页面版本的受控文本框复用为非受控文件输入，产生 controlled/uncontrolled 警告。为四个来源字段增加稳定且不同的 key，避免不同输入类型共享实例。
2. 可调整宽度的抽屉在 390px 视口仍保留至少 420px 宽，左边内容被裁掉；从桌面缩窄时也会保留旧宽度。增加视口最大宽度约束，保留桌面宽度记忆。浏览器断言同时检查左右边界，不能只检查 document.scrollWidth。

验收脚本初版还曾等待未展开的检索正文、以及在未关闭新建表单时打开资料。这两项是测试操作顺序错误，已改为实际点击检索历史、展开正文、关闭表单后继续，不计作产品缺陷。

## 覆盖与证据

`server/scripts/verify-integrated-ui.ts` 生成独立的合成项目及材料，使用实际检索服务产生 10 条审计记录，通过完整应用读取真实 HTTP 响应。执行、生命周期及定位回执为明确的合成展示夹具，不冒充真实产品执行结果。

最终 23 个检查组通过，浏览器 pageerror、console.error 和 HTTP 4xx/5xx 均为零：

- 中/英/日三语：检索历史从 8 条展开全部、点击记录并展开原文、预算省略与未知 ID；执行阶段、未知调用量、待清理资源、定位使用与回退；旧回执、损坏审计、未声明范围的探索报告；新建表单输入和来源切换。
- 390px 回执阅读，抽屉完整落在视口内；桌面 1440px、深色主题。
- 复核、物料、运行报告、基线、评测和设置导航，保留项目上下文。这六项为合成项目的导航冒烟，不等于各页面全部业务操作验收。

每次成功输出 `results.json` 和 26 张截图到 `TP_UI_EVIDENCE_DIR`，默认系统临时目录。已人工查看检索正文、回执、窄屏和主要页面截图。浏览器脚本是额外验收，不计入 Vitest 数量。

## 重放

使用全新的临时目录作为 `TP_DATA_DIR`，不要指向实际项目数据库。启动后端和前端，脚本的 `TP_DATA_DIR` 必须与后端相同；仅在本地测试实例上运行。脚本保留合成项目供检查，不删除用户数据。需安装 Chrome。

```sh
# 终端一：DATA_DIR 指向为本次测试新建的目录
TP_DATA_DIR="$DATA_DIR" TP_INSTANCE=integration-ui PORT=5301 pnpm server:dev
# 终端二
pnpm dev
# 终端三
TP_DATA_DIR="$DATA_DIR" TP_UI_URL=http://localhost:5300 \
  MIDSCENE_MODEL_NAME=fixture MIDSCENE_MODEL_BASE_URL=https://fixture.test/v1 \
  MIDSCENE_MODEL_API_KEY=fixture \
  pnpm --filter testpilot-server exec tsx scripts/verify-integrated-ui.ts
```

模型参数只是注册绑定，不进行外部模型调用。没有对真实运行执行人工批准，没有修改 Gold、held-out、主网禁止名单。此验收不证明 Hyperliquid 测试网交易闭环或真实视觉模型提速。

## 合并前检查

类型检查、生产构建、三语 UI 阅读 34 项、domain-neutral、drift、host parity、hooks 26 项、脚本 7 项和冻结 replay 均通过。host parity 保留 188/192、4 个既有待办。本次完整重跑 190 个 Vitest 文件、1678 项全部通过，无跳过；MCP Node 另 4 项通过（与此前 1677+1 条件跳过的环境不同，本次该条件用例实际执行）。
