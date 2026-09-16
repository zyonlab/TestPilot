# Claude Code 宿主 · 端到端实测

2026-09-14。这是 Claude Code 作为宿主运行时的**第一次端到端实测**。此前它只有六条接缝单测
（session_id 取值、hook 拦截识别、MCP 事件翻译、`.mcp.json` 写入、CLI 参数、运行时分发），
没有一条会真的 spawn 一个 `claude` 进程——「参数拼对了」「hook 真的被宿主加载了」
「skills 真的被识别了」这三件事此前只有文档没有证据。Codex 在 09-10 有过一次（见 19），
两个宿主的证据强度长期不对等。

**结论：链路通了，17 次 MCP 阶段调用，3 分 10 秒，$1.52。**

## 运行身份

| 项目 | 实测值 |
| --- | --- |
| 脚本 | `server/scripts/verify-host-stages.ts --real --claude --freeze-as-operator` |
| 宿主 | Claude Code 2.1.270 |
| 规划模型 | `claude-opus-5[1m]`（宿主原生，未替换成 Web planner） |
| 数据库 | 一次性临时库（`TP_DATA_DIR` 指向 mkdtemp） |
| 材料 | 脚本自带的 counter 规格，本地、有界、无登录无网络无交易 |
| run | `verify-claude-code-1789387536177` |
| session | `19bcbf7e…` |
| 墙钟 | 12:05:36 → 12:08:46（3 分 10 秒） |
| token | 输入 514 · 缓存读 1,006,004 · 输出 13,277（其中思考 5,491） |
| 花费 | $1.5188 |

## 实际调用路径

```
load_run_instructions → begin_stage(modules) → retrieve_spec → plan_modules
→ module_plan_state → [人工冻结] → begin_stage(stories) → write_stories
→ begin_stage(cases) → write_cases ✗ → write_cases ✓
→ begin_stage(gate) → gate_run → write_cases → gate_run
→ begin_stage(finalize) → finalize_run
```

17 次 MCP 工具调用，内部 `run_pipeline` **0 次**——走的是阶段工具，不是整份流水线。

产物 11 份修订：`counter.md`、`validated/instructions`、`validated/modules`、
`report/module-fanout`、`report/acceptance-index`、`validated/stories`、
`validated/cases`（rev1、rev2）、`validated/gate`（rev1、rev2）、`validated/finalize`。

## 第一次跑：agent 停住了，而不是适配器坏了

第一次跑（不带 `--freeze-as-operator`）脚本判 `passed: false`，报
「agent 中途停下了」。看 trace 才知道它停在哪：

```
begin_stage(modules) → load_run_instructions → retrieve_spec → plan_modules
→ module_plan_state ×3 → 停
```

session 本身是**正常结束**的（`is_error: false, subtype: success`）。它在等人冻结模块树——
而脚本里没有这个人。**不是适配器坏了，是这个脚本比流水线旧**：它写在模块节点与
那道人工闸引入之前。

照 `drive-modules-and-stories.ts` 的先例加了 `--freeze-as-operator`：默认不按，
带这个开关才按，并把「谁按的、什么时候按的」写进证据（`result.json` 的 `freezes`）。
这条闸的意义是「有人为这棵树负责」，不是「必须有个人坐在那儿」——脚本调用者显式声明
自己就是那个人，是成立的；悄悄替他按，不成立。

冻结记录：`2026-09-14T12:06:08.206Z · VERIFY_HOST_STAGES_OPERATOR · openFindings: 0`。

## 顺带验到的两件事

**一、schema 拒收之后 agent 会自己修。** 第一次 `write_cases` 被打回：

```
cases.json 不符合 CaseBundleSchema：cases.0.design.transitionIds: Array must contain
at least 1 element(s)。形状见 skill testpilot-design 的 REFERENCE.md；改完再写一次。
```

它改完重写，第二次 `validated`：2 条用例 / 1 条故事，出处 `trace`，2/2 有据可循。
门禁出结果后又写了一次 `write_cases` 再 `gate_run`——修复回路按设计走通了。

**二、这轮新加的门禁规则在英文材料上也生效。** `gate_run` 点到三条 `acceptance-uncovered`：

```
S-01/AC-1 要求用户动手（When the visitor clicks the visible Inc），却没有任何用例认领它
```

验收准则编号（`S-01/AC-1`）与「这条要不要用户动手」的判定是 2026-09-14 才加的
（见 24 §38），当时是对着中文语料调的。这次在纯英文规格上跑，`When` 子句解析与
英文动作动词（`clicks`）都命中了。最终两轮门禁都 `score: 1`。

## 第二轮：真实站点，走到执行

2026-09-14 同日。上面那轮用的是脚本自带的本地 counter 规格，这一轮换成真东西：
新建项目、目标 `https://app.hyperliquid-testnet.xyz/trade`，并且走完复核 → g2 → 执行。
驱动脚本 `server/scripts/drive-claude-host.ts`。

**分工是被迫的，也是对的。** MCP 里没有探索工具（`register_run` 收的是材料文本），
而且探索要浏览器、宿主 agent 没有。所以：

```
服务端探索（modules 前设断点停住）→ Claude Code 宿主规划 → 人复核 → g2 → execution
```

| 阶段 | 结果 |
| --- | --- |
| 项目 | `prj-mu18xegk-1002` |
| 探索 | 6 屏、32,656 字材料、产品模型 21 功能 / 10 模块，2 分钟 |
| 宿主规划 | 9 模块 / 4 故事 / 11 用例，门禁 `score 1`；冻结由 `CLAUDE_HOST_E2E_OPERATOR` 显式按下 |
| 人工复核 | 10 批准 / 1 驳回 |
| g2 | `ready_to_execute`，代码门禁 `score 1`（3 条 info：措辞漂移、重复步骤序列） |

用例质量与上一批（24 §38 之前那 81 条）完全不同：11 条全是 `tier1 + 机器判据 + ready`，
`acRefs` 全部按编号引用，步骤是真实动作，大多带回退。没有一条是「打开页面 + 看一眼」。

### 驳回的那条，缺陷不在用例

C-12 的判据是 `Account value must be <$2500万 to use portfolio margin in beta mode.`
——一个英文 dapp 不会渲染「万」。查探索材料，**原文就是这句**：用例逐字抄的，没编。
缺陷在上游：材料里这句的数字被本地化了（`$25M` → `$2500万`），而同一份材料里
`No open positions yet`、`Trailing Stop`、`The maximum leverage is 10x.` 都是逐字英文。
拿它当 `text` 判据必然永远不匹配。**`outputLanguage: 'zh'` 的运行都可能中招。**

### 执行：10 条真跑到测试网，9 过 1 败，零基础设施错误

```
✓ C-03 C-05 C-07 C-08   machine:pass(挣来的)
⚠ C-01 C-02 C-06 C-09 C-11   machine:pass(免费)
✗ C-10 failed
通过 9 条里：挣来的 4 条 · 判据在初始页面就成立的 5 条
```

**唯一一条失败是定位失败，不是产品缺陷。** C-10 第 2 步
「点击页面下半部分账户面板标签行里的「Positions」」：

```
AI model failed to locate: The 'Positions' tab in the account panel tab row
at the bottom of the page was not found in the provided element list or screenshot.
```

页面就绪读数是 `30 controls, 1849 text characters`——页面是画完的。未连接钱包时
账户面板那一行标签本来就可能不在，或者不叫这个名字。归 `locate` 而不是 `assert`，
分档是对的：这条要改用例措辞，不该走「产品是坏的」那个出口。

### 两条批了但要标出来的弱判据

C-01「输入数量后可用余额仍为 0.00 USDC」、C-11「切到 Sell / Short 后仓位仍是 0.00 HYPE」
——判据在**动作之前就已经成立**。作为不变性检查勉强成立，但它分不清「没变」和「本来就是」。
执行结果证实了：C-01、C-11 都是 `machine:pass(免费)`，另外 C-02、C-06、C-09 也是——
**9 条通过里只有 4 条是挣来的**。判据是真的机器判据，通过也是真的通过，
但其中 5 条的判据在动作之前就已经成立，这次通过没有证明那几步做成了什么。

## 还没验到的

- **hook 有没有真的被宿主执行**。判据只到「MCP 阶段工具被调用、产物落盘」，
  `PreToolUse` / `Stop` 走没走 `hooks/adapters/claude-code.mjs`，trace 里没有直接证据。
- **宿主自己发起探索**。MCP 没有这个工具，目前也不打算有——探索要浏览器。

## 前提

跑这个脚本之前必须先让宿主 plugin 与真源一致（`node scripts/build-claude-plugin.mjs`）。
2026-09-14 调研时发现两个宿主副本落后了四个文件，其中就有当天改过的
`testpilot-stories/SKILL.md`——**拿过期副本跑出来的实测，测的是旧 skill，结论是假的**。
这条现在由 `check-drift` 兜住（见 PR #1）。
