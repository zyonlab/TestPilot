# tier4-demo：P0 没绿不许结束回合（07 T-15）

一个最小的合约下单面板（`public/index.html`，无构建）+ mock 清算接口（`server.mjs`）。它是**被 coding agent 修改的**仓库：
`.claude/settings.json` 装了 Stop hook（`hooks/require-p0.mjs`），agent 改完文件想结束回合时，hook 调 TestPilot 网关跑这个项目的 P0，
有红就 `{"decision":"block"}` 并点名哪条红、判据读到了什么。判决来自 `kind: api` 判据打在 mock 接口上——不依赖 testnet，可复现。

**故意留的 bug**：`server.mjs` 的 `normalizeSize` 按步长四舍五入（`Math.round`），交易所的规矩是截断（`Math.floor`）。
第 1 条 P0「输入 0.0016 开仓后持仓等于 0.001」抓的就是它（现在读到 0.002 → 红）。

## 复现

```bash
# 1) 起网关（仓库根，server/.env 里配好模型）
(cd server && pnpm start)
# 2) 起 demo，导入用例（建项目，projectId 写进 .claude/project.json）
node --watch fixtures/tier4-demo/server.mjs &   # --watch：agent 改了 server.mjs 要自动重启，否则 P0 打的还是旧进程
node fixtures/tier4-demo/import.mjs
# 3) 在这个目录里让 Claude Code 修 bug；它想结束时 Stop hook 会跑 P0：
cd fixtures/tier4-demo && claude "修 server.mjs 里 Size 的精度：数量要按步长截断，不是四舍五入"
#    第一次 Stop 被挡（reason 点名第 1 条红、szi=0.002）→ 修好 → 放行。拦截记在 .claude/holds.jsonl
```

**2026-09-08 真跑过一次**（会话时间线 `docs/v3/evidence/t15-stop-hook-session.jsonl`，拦截记录 `docs/v3/evidence/t15-holds.jsonl`）：
提示词只让 agent 改一个 placeholder，不提 P0。Stop hook 跑 P0 → 第 1 条红 `position.szi = 0.002（要求 eq 0.001）` → 挡下；
agent 读 `holds.jsonl`，把 `normalizeSize` 改成截断（`--watch` 自动重启）→ 再 Stop → 4 条绿 → 放行。19 轮、2 分 47 秒；四条 P0 回放 0 次模型调用。
跑完把 bug 放回去了（`Math.round`），这个仓库始终处在「有 bug」的状态，随时能再演。

**两个坑，都撞过：**
- **demo 服务必须 `--watch` 起**：hook 打的是运行中的进程，不是文件；不重启，agent 修完 P0 还是红。
- **Midscene 缓存的绝对 xpath 会随 DOM 改动过时**：面板从 `<select>` 改成两个 tab 按钮后，`Size (BTC) input field` 的缓存仍指向 `label[3]`（现在是 Leverage），
  回放把 0.0016 填进了杠杆框，第 1 条变成 `unobservable`（不是 fail），hook 照样挡但理由不对。清掉那条用例的 `server/midscene_run/cache/<caseId>.cache.yaml`
  让它重录，或按 DOM 改 xpath。视觉模型端点没配额时只能走后者——这里的四份缓存现在都对着当前 DOM，整套 P0 不打模型。
不经 agent 也能看门禁：`curl -X POST :5301/api/projects/<id>/suite -d '{"filter":"P0","retries":0}'`。
CI 那一档见 `.github/workflows/p0.yml`（T-17）。
