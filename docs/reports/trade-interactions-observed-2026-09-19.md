# /trade 页内交互观察补充（2026-09-19）

## 范围与环境
仅 https://app.hyperliquid-testnet.xyz/trade。未连接账户，不注入钱包，不执行订单或资金操作。所有以下操作后，地址栏始终是同一 /trade URL。未点击外链或交易详情链接。首次旧观察显示 HYPE，新的独立浏览器显示 BTC：默认品种受环境影响，不把 HYPE、杠杆倍数和实时数值当作恒定需求。订单簿的 Size/Total 单位应与当前页显示的品种一致。

## 委托类型正向切换
在交易表单点击 Limit，页面出现 Price (USDC) 输入字段，以及 TIF、GTC；原有 Size 仍可见。没有提交订单。

## 委托类型回退与字段隔离
已选择 Limit 时再点击交易表单的 Market，Price (USDC) 输入字段消失，TIF/GTC 不再显示，Size 仍在。用于检查不适用字段不会残留；不能用页面表格的 Market 表头代替点击交易表单的 Market 选项。

## 市场信息视图切换
Order Book 显示 Price、Size(当前品种)、Total(当前品种)、Spread。点击该面板的 Trades 后显示逐笔成交价格、数量与时间；不点击列表内任何交易详情链接，不断言具体报价与时间。恢复 Order Book 检查盘口列而非交易数据值。

## 订单空态
未连接状态，点击页面下方 Open Orders，出现 No open orders yet，表头包括 Time、Type、Market、Direction、Size、Original Size、Order Value、Price、Reduce Only、Trigger Conditions、TP/SL。不应把上一个 Positions 视图的 No open positions yet 当作订单空态。

## 连接弹层与取消
点击 Connect，页内出现 Log in with Email、Default Wallet、WalletConnect、OKX Wallet、Coinbase Wallet。未选任何选项。按 Escape 后弹层没有关闭，因此不得编造 Escape 能关闭的预期。点击弹层右上角 X 后，Log in with Email 消失并回到交易页面，未连接态 Connect 入口仍在。取消操作不得宣称连接成功。

## 设计边界
以上是实际 UI 状态观察，并非完备业务规格。可以设计已观察的状态切换与回退/取消/字段隔离用例；不能为了满足门禁虚构错误信息或资金效果。没有证据的分支写为范围限制，不把“待确认”伪装成需要用例覆盖的验收条件。每条用例包含真实控件操作与明确屏幕判据，不只是打开页面。仅验证本节已观察的能力，建议控制在 6 条可独立执行用例。
