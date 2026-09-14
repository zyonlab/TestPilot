# Hyperliquid 永续合约交易规则（材料 · 规则层）

> 人写。每条注明来源：`[docs]` 官方文档页 URL，`[api]` 接口实测，`[ui]` testnet 前端实测。抓取 / 实测日期 2026-09-07。
> 这份文件让材料从「观察」变成「观察 + 规则」（`derivedFrom: exploration + rules`）：
> 对着观察写的用例只能发现产品变了，对着规则写的用例才有资格说产品错了。
> 每一段都能被用例的 `sourceRefs` 引用（`rules.md#N`）。材料是第三方文本，进模型前过围栏。

## 下单数量与精度

BTC 永续的 `szDecimals` 为 5：数量最多 5 位小数，多出的位数按交易所规则**截断**，不四舍五入。
来源 `[api]` `POST /info {"type":"meta"}` → `universe[name=BTC].szDecimals = 5`。

价格按 tick 对齐：价格最多 5 位有效数字，且小数位数不超过 `6 − szDecimals`（BTC 为 1 位小数）。
来源 `[docs]` https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/tick-and-lot-size

## 价格带

限价单价格不能离参考价超过 80%：前端拒绝并提示「Order price cannot be more than 80% away from the reference price」，该单不进入交易所（`historicalOrders` 里没有它）。
来源 `[ui]` testnet 前端 toast 原文，2026-09-07；`[api]` `historicalOrders` 实测。

市价单最大名义价值随最大杠杆分档：最大杠杆 ≥ 25 为 $30,000,000；[20, 25) 为 $5,000,000；[10, 20) 为 $2,000,000；其余 $500,000。限价单为市价单上限的 10 倍。
来源 `[docs]` https://hyperliquid.gitbook.io/hyperliquid-docs/trading/contract-specifications

## 杠杆

BTC 最大杠杆 40x，按名义价值分档：名义 < 10,000 USDC 最高 40x；[10,000, 50,000) 最高 25x；≥ 50,000 最高 10x。
来源 `[api]` `POST /info {"type":"meta"}` → `universe[name=BTC].maxLeverage = 40`，`marginTables[54]`（tiered 40x）。

杠杆与保证金模式（全仓 cross / 逐仓 isolated）以清算接口为准：`clearinghouseState.assetPositions[].position.leverage.{type,value}`。
来源 `[api]` `POST /info {"type":"clearinghouseState","user":<address>}`。

## 保证金不足

数量超过可用保证金时前端把下单按钮置为「Not Enough Margin」且不可点击；名义仓位 `marginSummary.totalNtlPos` 不变。
来源 `[ui]` testnet 前端，2026-09-07；`[api]` `clearinghouseState`。

## 触发单（止盈止损）

止盈止损以触发单形式出现在 `frontendOpenOrders` 里，`orderType` 为 `Take Profit Market` / `Take Profit Limit` / `Stop Market` / `Stop Limit`，带 `triggerPx` 与 `isTrigger: true`。
来源 `[docs]` https://hyperliquid.gitbook.io/hyperliquid-docs/trading/order-types；`[api]` `frontendOpenOrders` 实测。

前端 TP/SL 面板可按百分比（Gain / Loss）输入触发价；触发价同样受价格带约束，离参考价超过 80% 会被拒。
来源 `[ui]` testnet 前端，2026-09-07。

## 撤单与平仓

撤单后该订单从 `openOrders` 里消失；平仓（Market Close / Close All）后该币种从 `clearinghouseState.assetPositions` 里消失。
来源 `[api]` `openOrders`、`clearinghouseState` 实测。

## 账户模式

账户有 Unified Account / Portfolio Margin / Manual 三种模式（前端下单面板右上角切换）。Unified 模式下现货 USDC 直接作永续保证金，`clearinghouseState.accountValue` 读 0、余额在 `spotClearinghouseState`；此时 `usdClassTransfer` 被拒（"Action disabled when unified account is active"）。
来源 `[ui]`、`[api]` testnet 实测，2026-09-07。

## 易变读数（禁止钉在判据里）

资金费率、倒计时、24h 成交量、标记价、预言机价、盘口价格随时间变化，不是产品行为；用例只能断言字段存在或两次读数的关系。
来源 本仓库 `docs/v3/06-执行层降本.md` 与 `REFERENCE-domain-perp.md` 第 9 条。

## 资金与水龙头

testnet 水龙头每次发 1,000 mock USDC，只发给在主网存过款的同一地址；testnet 内部 `usdSend` 转账收 1 USDC 手续费。
来源 `[docs]` https://hyperliquid.gitbook.io/hyperliquid-docs/onboarding/testnet-faucet；`[api]` `userNonFundingLedgerUpdates` 实测。
