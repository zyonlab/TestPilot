# 基准：hyperliquid-testnet（永续合约 P0，接口判据）

被测对象：`https://app.hyperliquid-testnet.xyz/trade/BTC`。一个真实的 perp DEX 前端，没有 WAF、
没有登录墙（钱包即身份），注入钱包（`exec/injectedWallet.ts`）能直接签它的 EIP-712 请求
（`eth_signTypedData_v4` 已支持）。它替换 `demo.binance.com` 作为**执行层降本**那一档的被测对象：
Binance demo 的会话导入、WAF、结算时点，都是 staging 那套老问题换了个壳。

## 这份基准量什么

**30 条 P0 十分钟跑完**（`docs/v3/06-执行层降本.md`）。所以判据全部是 `kind: api`——去问
`https://api.hyperliquid-testnet.xyz/info`，不问模型：

| 用例 | 接口 | 路径 | 判据 |
|---|---|---|---|
| 市价开多 0.001 | clearinghouseState | `assetPositions[position.coin=BTC].position.szi` | eq 0.001 |
| 限价挂单 | openOrders | `[coin=BTC].limitPx` | eq 10000 |
| 撤单 | openOrders | `[coin=BTC]` | absent |
| 止盈止损 | frontendOpenOrders | `[orderType=Take Profit Market].coin` | eq BTC |
| 一键平仓 | clearinghouseState | `assetPositions[position.coin=BTC]` | absent |
| 超额下单被拒 | clearinghouseState | `marginSummary.totalNtlPos` | unchanged（tier 2） |
| 杠杆 5x | clearinghouseState | `…position.leverage.value` | eq 5 |

「钱包里多了一条成功交易」在链上 dapp 是回执；在有清算接口的交易所，它就是这些数。
BingX 那次是劫持接口把账户**写**成确定的，这里是读接口把结果**读**成确定的，目的一样：
判决落在程序能核对的数上，模型只负责把 UI 点到那一步。

## 前提（每条都可能吃掉一轮真跑）

1. **资金。** 注入钱包的地址（`server/.wallets/account.txt`，`scripts/gen-wallet.mjs` 生成）要在
   testnet 上有 mock USDC。官方水龙头 `https://app.hyperliquid-testnet.xyz/drip` 每次 1,000 mock USDC，
   **只发给「在主网存过款」的同一地址**（官方文档原话："Users who have deposited on mainnet"）。
   两条路：给这个地址在主网存一笔最小额；或者用你自己一个有资格的地址领了之后，
   在 testnet 上转给测试地址（testnet 内部转账不需要资格）。
   充值到账后钱在**永续**账户（`clearinghouseState.accountValue`），判据读的就是它。
   **但第一次 Enable Trading / Establish Connection 的引导会把账户切成「Unified Account」**（2026-09-07 实测）：
   那之后 `clearinghouseState` 读 0、钱出现在 `spotClearinghouseState`，而前端照样显示「Available to Trade 999」——
   判据全挂、界面全好。处理：用一次临时运行把下单面板右上角的「Unified」切成 **Manual**（选项是
   Unified Account / Portfolio Margin / Manual，没有 Classic），再 `node fixtures/hyperliquid-testnet/spot-to-perp.mjs`
   把 USDC 划回永续（Unified 开着时这个动作被拒：`Action disabled when unified account is active`）。
   切成 Manual 之后再跑 Enable Trading 不会翻回去（实测一次）。
2. **视口 1440×900。** 环境设置里改。窄视口下下单面板整块不渲染，用例会在「找不到 Size」上死，
   而那不是产品的错（`docs/v3/00-架构.md §10` 在 Binance 上撞过同一件事）。
3. **新地址的一次性引导，和每条都要过的「登录态」。** 分清这两层（2026-09-07 实测）：
   * **按地址一次性**：条款弹窗（Terms of Use…两个复选框 + `Accept`）接受过一次后所有新浏览器都不再出现。
     新地址第一次用一个临时运行（`POST /api/run`，`injected: true`）点掉它。
   * **按浏览器每次**：agent 授权存在浏览器 profile 里，每条用例都是新浏览器，所以每条跑之前都要
     `Enable Trading` → `Establish Connection`。这是环境的 `login.steps`（cases.json 已写好），
     跑在用例步骤之前，和步骤一样走缓存。**写成无条件步骤**：带「如果」的步骤会把当次走的分支固化进缓存，
     页面没加载完时模型判「不动」，缓存成空流程，之后每次回放都不动。
   * **登录态不关右下角的 Announcements 面板**（T-27 根因）：它是 `#root` 下排在 app 前面的兄弟节点，关掉是从 DOM
     移除，app 从 `div[3]` 变 `div[2]`，Midscene 缓存里的绝对 xpath 整体位移；而「×」的缓存 xpath 指向标题栏，回放点不中，
     记录态与回放态就不一致——二跑 49/49 失效就是这么来的。面板留着；它盖住底部订单表右侧的 Cancel / Cancel All，
     所以撤单类步骤走 View All 整页。
   * 控件文案已按截图逐字：钱包自动连上、列表项叫 `MetaMask`、复选框叫 `Take Profit / Stop Loss`、
     杠杆按钮显示当前倍数（`20x`）、持仓表有 `Close All`。判据不用校对——它们不看屏幕。
4. **每条用例结束后账户要回到平的。** `postSteps` 负责平仓/撤单；万一 teardown 失败，下一条从脏状态
   开始，`eq 0.001` 会变成 `eq 0.002`。兜底不用界面：`node fixtures/hyperliquid-testnet/cancel-all.mjs` 撤全部挂单
   （含触发单，用钱包私钥签 L1 动作）；持仓用界面 Close All，或先跑「一键平仓」那条。
5. **行情是活的。** 所以没有一条判据钉在价格、资金费率、倒计时上；限价单挂在 10000 这种远离市价的位置，
   保证它不会成交。

## 账户模式与划转

```bash
node fixtures/hyperliquid-testnet/spot-to-perp.mjs              # 现货 → 永续，全部；--to-spot 反向
node fixtures/hyperliquid-testnet/cancel-all.mjs                # 撤掉账上所有挂单与触发单（teardown 失手的兜底）
```
两个都用 `server/.wallets/seed.txt` 签，只对 testnet 端点，前后各读一次账。`cancel-all` 是 L1 动作
（msgpack + keccak 当 connectionId 的 Agent 签名），仓库里没有 msgpack 库，脚本里手写了只够这个动作用的编码。

## 导入

```bash
node fixtures/hyperliquid-testnet/import.mjs --address $(cat server/.wallets/account.txt)
```

## 期望的账（跑完填）

| 指标 | 目标 | 实测 |
|---|---|---|
| 8 条首跑（无缓存）总墙钟 | — | 7 条 P0：778s / 94 次调用 / 343k tokens，7/7 通过（2026-09-07，`bat-mtr8ma5v-1001`） |
| 8 条二跑（缓存命中）总墙钟 | ≤ 首跑的 1/3 | 384s = 首跑的 49%（`bat-mtr92zhd-1009`）。没到 1/3 是因为每条有 35–50s 不走模型的地板（起浏览器、登录态、settle）。T-27 之前那次是 1109s，根因见 `06 §6.1` |
| 每条用例 modelCalls / tokens / modelMs（`spendJson`） | — | `node scripts/cost-report.mjs` |
| 缓存命中率（cacheHits / (hits+misses+stale)） | ≥ 80% 二跑 | 二跑 58/2/1 = **95%**（T-27 之前 30%） |
| 判据由机器判定的比例 | 100% | 100%（14 次运行全部 `decidedBy: machine`） |
| 连续 5 次通过率、flake | flake ≤ 5% | 未量（只有两遍）；C 7/7，D 6/7（1 infra：Midscene 回放拿 undefined 坐标点鼠标） |

写进 `docs/v3/06-执行层降本.md` 的实测表，不要只留在这里。
