# 探索节点验证

运行：run-691e592c-eed4-4e74-a0ed-349247edd6a1。后续节点均设置断点；因连续越界返回尝试停止，但接口返回 403 operator_action_required，停止未成功。记录时 source 仍运行，未进入第二节点。

已确认环境配置的三个登录动作均执行，页面出现 Established connection、账户缩略地址、可交易余额 984.01 USDC、合约权益 984.02 USDC、无持仓。只证明观察到这些 UI 状态，不等于完整账户身份/网络验证或账本对账。

未配置 sessionChecks，不能授予已核验 wallet-session。另发现越界返回后仍重复点击旧路径。确切越界目标 URL 未写入日志，目前无法确定是币对路径还是其他路由，不能宣称根因已定位。

已保留 13 个观察状态。应先完善越界目标日志和返回后的状态重新采集，再重跑 source；下游保持未执行。

## 关键日志

- 2026-09-20T10:51:28.972Z: 登录准备步骤 1 已执行；会话状态仍需界面核验
- 2026-09-20T10:51:39.599Z: 登录准备步骤 2 已执行；会话状态仍需界面核验
- 2026-09-20T10:51:50.106Z: 登录准备步骤 3 已执行；会话状态仍需界面核验
- 2026-09-20T10:52:28.586Z: 第 13 轮：（无可见文案·/trade） 的路径已经过时（ambiguous:0）
- 2026-09-20T10:52:48.931Z: 页内跳转超出当前 URL 范围，返回原状态
- 2026-09-20T10:53:03.696Z: 页内跳转超出当前 URL 范围，返回原状态
- 2026-09-20T10:53:18.019Z: 页内跳转超出当前 URL 范围，返回原状态
- 2026-09-20T10:53:41.669Z: 页内跳转超出当前 URL 范围，返回原状态
- 2026-09-20T10:53:54.845Z: 页内跳转超出当前 URL 范围，返回原状态
- 2026-09-20T10:54:08.262Z: 页内跳转超出当前 URL 范围，返回原状态
- 2026-09-20T10:54:21.232Z: 页内跳转超出当前 URL 范围，返回原状态
- 2026-09-20T10:54:34.670Z: 页内跳转超出当前 URL 范围，返回原状态
- 2026-09-20T10:54:48.097Z: 页内跳转超出当前 URL 范围，返回原状态
- 2026-09-20T10:55:01.562Z: 页内跳转超出当前 URL 范围，返回原状态
- 2026-09-20T10:55:15.052Z: 页内跳转超出当前 URL 范围，返回原状态
- 2026-09-20T10:55:28.179Z: 页内跳转超出当前 URL 范围，返回原状态
- 2026-09-20T10:55:41.878Z: 页内跳转超出当前 URL 范围，返回原状态
- 2026-09-20T10:55:54.948Z: 页内跳转超出当前 URL 范围，返回原状态
- 2026-09-20T10:56:08.336Z: 页内跳转超出当前 URL 范围，返回原状态
- 2026-09-20T10:56:18.405Z: 第 36 轮：0.0450% / 0.0150% 的路径已经过时（relocated）
- 2026-09-20T10:56:21.285Z: 页内跳转超出当前 URL 范围，返回原状态
- 2026-09-20T10:56:34.955Z: 页内跳转超出当前 URL 范围，返回原状态

## 部分观察材料

===== 入口页 =====
URL: https://app.hyperliquid-testnet.xyz/trade
TITLE: 25.500 | HYPE | Hyperliquid
TEXT:
Announcements
Manual borrowing now available
Use HYPE and BTC as collateral to borrow USDC and USDT
New listing: USELESS-USDC perps
New listing: PONS-USDC perps
Established connection
Trade
Outcomes
Portfolio
Earn
Vaults
Staking
Referrals
Leaderboard
Faucet
More
Deposit
0x6765...07F5
HYPE-USD is a hyperp (Hyperliquid-only perp) for the pre-launch HYPE token, which uses recent average mark price for the funding oracle. See Docs for more details. Trading is on low leverage and isolated margin only. Beware of low liquidity, high volatility, and increased liquidation risk.
HYPE-USDC
10x
Mark
11.000
Oracle
35.334
24h Change
+0.000 / +0.00%
24h Volume
$47.08
Open Interest
$101.20
Funding / Countdown
0.0000%   00:08:07
Chart
Funding
Chart by TradingView
Order Book
Trades
 
0.001
HYPE
Price
Size (HYPE)
Total (HYPE)
91.345
0.58
39.92
89.108
0.60
39.34
85.507
0.63
38.74
83.248
0.64
38.11
80.988
0.66
37.47
80.083
0.26
36.81
78.805
0.79
36.55
78.729
0.68
35.76
71.545
0.39
35.08
40.500
24.69
34.69
40.000
10.00
10.00
Spread
29.000
113.725%
11.000
10.42
10.42
10.123
0.60
11.02
Isolated
10x
Manual
Market
Limit
Pro
Buy / Long
Sell / Short
Available to Trade
984.01 USDC
Current Position
0.00 HYPE
Size
HYPE
%
Reduce Only
Take Profit / Stop Loss
Place Order
Liquidation Price
N/A
Order Value
N/A
Margin Required
N/A
Slippage
Est: 0% / Max: 8.00%
Fees
0.0450% / 0.0150%
Balances (1)
Positions
Outcomes
Open Orders
TWAP
Chase
Trade History
Funding History
Order History
Side
Market
Market
	
Size
	
Position Value
	
Entry Price
	
Mark Price
	
PNL (ROE %)
	
Liq. Price
	
Margin
	
Funding
	
Close All
	
TP/SL

No open positions yet
Deposit
Perps
Spot
Withdraw
Account Equity
Spot
$0.00
Perps
$984.02
Perps Overview
Balance
$984.02
Unrealized PNL
$0.00
Cross Margin Ratio
0.00%
Maintenance Margin
$0.00
Cross Account Leverage
0.00x
Online
Docs
Support
Terms
Privacy Policy
CONTROLS:
- a: （无可见文案·/trade） -> /trade
- a: Trade -> /trade
- a: Outcomes -> /outcomes
- a: Portfolio -> /portfolio
- a: Earn -> /earn
- a: Vaults -> /vaults
- a: Staking -> /staking
- a: Referrals -> /referrals
- a: Leaderboard -> /leaderboard
- a: Faucet -> /drip
- a: More
- button[button]: Deposit
- a[外站]: Docs
- a[外站]: Chart
- button[button]: Isolated
- button[button]: 10x
- button[button]: Manual
- input[text]: Size
- input[text]: （无可见文案·输入框）
- button[button]: Place Order
- a: Est: 0% / Max: 8.00%
- a: 0.0450% / 0.0150%
- button[button]: Deposit
- button[button]: Perps
Spot
- button[button]: Withdraw
- a[外站]: Online
- a[外站]: Docs
- a[外站]: Support
- a: Terms -> /terms
- a: Privacy Policy -> /privacyPolicy
- div: Market
- div: Limit
- div: Pro
- div: Buy / Long
- div: Sell / Short
- div: Take Profit / Stop Loss
- div: Positions
- div: Open Orders
- div: Trade History
- div: Funding History
- div: Order History
- div: Market
- div: Market
- div: Size

===== 第 2 屏 =====
URL: https://app.hyperliquid-testnet.xyz/trade
TITLE: 25.500 | HYPE | Hyperliquid
TEXT:
Announcements
Manual borrowing now available
Use HYPE and BTC as collateral to borrow USDC and USDT
New listing: USELESS-USDC perps
New listing: PONS-USDC perps
Trade
Outcomes
Portfolio
Earn
Vaults
Staking
Referrals
Leaderboard
Faucet
More
Deposit
0x6765...07F5
HYPE-USD is a hyperp (Hyperliquid-only perp) for the pre-launch HYPE token, which uses recent average mark price for the funding oracle. See Docs for more details. Trading is on low leverage and isolated margin only. Beware of low liquidity, high volatility, and increased liquidation risk.
HYPE-USDC
10x
Mark
11.000
Oracle
35.334
24h Change
+0.000 / +0.00%
24h Volume
$47.08
Open Interest
$101.20
Funding / Countdown
0.0000%   00:08:01
Chart
Funding
Chart by TradingView
Order Book
Trades
 
0.001
HYPE
Price
Size (HYPE)
Total (HYPE)
91.345
0.58
39.92
89.108
0.60
39.34
85.507
0.63
38.74
83.248
0.64
38.11
80.988
0.66
37.47
80.083
0.26
36.81
78.805
0.79
36.55
78.729
0.68
35.76
71.545
0.39
35.08
40.500
24.69
34.69
40.000
10.00
10.00
Spread
29.000
113.725%
11.000
10.42
10.42
10.123
0.60
11.02
Isolated
10x
Manual
Market
Limit
Pro
Buy / Long
Sell / Short
Available to Trade
984.01 USDC
Current Position
0.00 HYPE
Price (USDC)
 Mid
Size
HYPE
%
Reduce Only
TIF
GTC
Take Profit / Stop Loss
Place Order
Liquidation Price
N/A
Order Value
N/A
Margin Required
N/A
Fees
0.0450% / 0.0150%
Balances (1)
Positions
Outcomes
Open Orders
TWAP
Chase
Trade History
Funding History
Order History
Side
Market
Market
	
Size
	
Position Value
	
Entry Price
	
Mark Price
	
PNL (ROE %)
	
Liq. Price
	
Margin
	
Funding
	
Close All
	
TP/SL

No open positions yet
Deposit
Perps
Spot
Withdraw
Account Equity
Spot
$0.00
Perps
$984.02
Perps Overview
Balance
$984.02
Unrealized PNL
$0.00
Cross Margin Ratio
0.00%
Maintenance Margin
$0.00
Cross Account Leverage
0.00x
Online
Docs
Support
Terms
Privacy Policy
CONTROLS:
- a: （无可见文案·/trade） -> /trade
- a: Trade -> /trade
- a: Outcomes -> /outcomes
- a: Portfolio -> /portfolio
- a: Earn -> /earn
- a: Vaults -> /vaults
- a: Staking -> /staking
- a: Referrals -> /referrals
- a: Leaderboard -> /leaderboard
- a: Faucet -> /drip
- a: More
- button[button]: Deposit
- a[外站]: Docs
- a[外站]: Chart
- button[button]: Isolated
- button[button]: 10x
- button[button]: Manual
- input[text]: Price (USDC)
- a: Mid
- input[text]: Size
- input[text]: （无可见文案·输入框）
- button[button]: Place Order
- a: 0.0450% / 0.0150%
- button[button]: Deposit
- button[button]: Perps
Spot
- button[button]: Withdraw
- a[外站]: Online
- a[外站]: Docs
- a[外站]: Support
- a: Terms -> /terms
- a: Privacy Policy -> /privacyPolicy
- div: Market
- div: Limit
- div: Pro
- div: Buy / Long
- div: Sell / Short
- div: Take Profit / Stop Loss
- div: Positions
- div: Open Orders
- div: Trade History
- div: Funding History
- div: Order History
- div: Market
- div: Market
- div: Size

===== 第 3 屏 =====
URL: https://app.hyperliquid-testnet.xyz/trade
TITLE: 25.500 | HYPE | Hyperliquid
TEXT:
Announcements
Manual borrowing now available
Use HYPE and BTC as collateral to borrow USDC and USDT
New listing: USELESS-USDC perps
New listing: PONS-USDC perps
Trade
Outcomes
Portfolio
Earn
Vaults
Staking
Referrals
Leaderboard
Faucet
More
Deposit
0x6765...07F5
HYPE-USD is a hyperp (Hyperliquid-only perp) for the pre-launch HYPE token, which uses recent average mark price for the funding oracle. See Docs for more details. Trading is on low leverage and isolated margin only. Beware of low liquidity, high volatility, and increased liquidation risk.
HYPE-USDC
10x
Mark
11.000
Oracle
35.334
24h Change
+0.000 / +0.00%
24h Volume
$47.08
Open Interest
$101.20
Funding / Countdown
0.0000%   00:07:46
Chart
Funding
Chart by TradingView
Order Book
Trades
 
0.001
HYPE
Price
Size (HYPE)
Total (HYPE)
91.345
0.58
39.92
89.108
0.60
39.34
85.507
0.63
38.74
83.248
0.64
38.11
80.988
0.66
37.47
80.083
0.26
36.81
78.805
0.79
36.55
78.729
0.68
35.76
71.545
0.39
35.08
40.500
24.69
34.69
40.000
10.00
10.00
Spread
29.000
113.725%
11.000
10.42
10.42
10.123
0.60
11.02
Isolated
10x
Manual
Market
Limit
Pro
Buy / Long
Sell / Short
Available to Trade
984.01 USDC
Current Position
0.00 HYPE
Price (USDC)
 Mid
Size
HYPE
%
Reduce Only
TIF
GTC
Take Profit / Stop Loss
Place Order
Liquidation Price
N/A
Order Value
N/A
Margin Required
N/A
Fees
0.0450% / 0.0150%
Balances (1)
Positions
Outcomes
Open Orders
TWAP
Chase
Trade History
Funding History
Order History
Type
Side
Role
Market
Aggregate
Time
	
Market
	
Direction
	
Price
	
Size
	
Trade Value
	
Fee
	
Closed PNL

2026/9/16 02:45:58 	ETH	Market Order Liquidation: Close Long	
2,372.2
	
0.0400 ETH
	
94.89 USDC
	0.04 USDC	
-6.12 USDC 

2026/9/12 23:24:00 	ETH	Open Long	
2,520.4
	
0.0021 ETH
	
5.29 USDC
	0.00 USDC	
-0.00 USDC

2026/9/12 23:23:59 	ETH	Open Long	
2,520.4
	
0.0079 ETH
	
19.91 USDC
	0.00 USDC	
-0.00 USDC

2026/9/12 23:07:44 	ETH	Open Long	
2,519.9
	
0.0100 ETH
	
25.20 USDC
	0.00 USDC	
-0.00 USDC

2026/9/12 22:39:36 	ETH	Open Long	
2,523.9
	
0.0100 ETH
	
25.24 USDC
	0.01 USDC	
-0.01 USDC

2026/9/12 22:15:17 	ETH	Open Long	
2,522.2
	
0.0049 ETH
	
12.36 USDC
	0.00 USDC	
-0.00 USDC

2026/9/12 22:14:38 	ETH	Open Long	
2,522.2
	
0.0051 ETH
	
12.86 USDC
	0.00 USDC	
-0.00 USDC

2026/9/12 18:35:08 	ETH	Close Long	
2,513.5
	
0.0100 ETH
	
25.14 USDC
	0.01 USDC	
-0.01 USDC 

2026/9/12 18:32:44 	ETH	Open Long	
2,513.7
	
0.0003 ETH
	
0.75 USDC
	0.00 USDC	
-0.00 USDC

2026/9/12 18:32:40 	ETH	Open Long	
2,513.7
	
0.0097 ETH
	
24.38 USDC
	0.00 USDC	
-0.00 USDC

2026/9/7 23:47:07 	BTC	Close Long	
78,533
	
0.00100 BTC
	
78.53 USDC
	0.04 USDC	
-0.04 USDC 

2026/9/7 23:46:56 	BTC	Open Long	
78,537
	
0.00100 BTC
	
78.54 USDC
	0.04 USDC	
-0.04 USDC

2026/9/7 23:46:13 	BTC	Close Long	
78,514
	
0.00100 BTC
	
78.51 USDC
	0.04 USDC	
-0.05 USDC 

2026/9/7 23:45:30 	BTC	Open Long	
78,532
	
0.00100 BTC
	
78.53 USDC
	0.04 USDC	
-0.04 USDC

2026/9/7 23:42:04 	BTC	Close Long	
78,575
	
0.00100 BTC
	
78.58 USDC
	0.04 USDC	
-0.04 USDC 

2026/9/7 23:41:51 	BTC	Open Long	
78,580
	
0.00100 BTC
	
78.58 USDC
	0.04 USDC	
-0.04 USDC

2026/9/7 23:34:20 	BTC	Close Long	
78,773
	
0.00100 BTC
	
78.77 USDC
	0.04 USDC	
-0.02 USDC 

2026/9/7 23:34:10 	BTC	Open Long	
78,759
	
0.00100 BTC
	
78.76 USDC
	0.04 USDC	
-0.04 USDC

2026/9/7 23:33:22 	BTC	Close Long	
78,796
	
0.00100 BTC
	
78.80 USDC
	0.04 USDC	
-0.07 USDC 

2026/9/7 23:32:39 	BTC	Open Long	
78,828
	
0.00100 BTC
	
78.83 USDC
	0.04 USDC	
-0.04 USDC

2026/9/7 23:29:02 	BTC	Close Long	
78,968
	
0.00100 BTC
	
78.97 USDC
	0.04 USDC	
-0.04 USDC 

2026/9/7 23:28:52 	BTC	Open Long	
78,969
	
0.00100 BTC
	
78.97 USDC
	0.04 USDC	
-0.04 USDC

2026/9/7 23:12:48 	BTC	Close Long	
78,966
	
0.00100 BTC
	
78.97 USDC
	0.04 USDC	
-0.04 USDC 

2026/9/7 23:12:38 	BTC	Open Long	
78,967
	
0.00100 BTC
	
78.97 USDC
	0.04 USDC	
-0.04 USDC

2026/9/7 23:11:56 	BTC	Close Long	
78,968
	
0.00100 BTC
	
78.97 USDC
	0.04 USDC	
-0.06 USDC 

2026/9/7 23:11:35 	BTC	Open Long	
78,990
	
0.00100 BTC
	
78.99 USDC
	0.04 USDC	
-0.04 USDC

2026/9
CONTROLS:
- a: （无可见文案·/trade） -> /trade
- a: Trade -> /trade
- a: Outcomes -> /outcomes
- a: Portfolio -> /portfolio
- a: Earn -> /earn
- a: Vaults -> /vaults
- a: Staking -> /staking
- a: Referrals -> /referrals
- a: Leaderboard -> /leaderboard
- a: Faucet -> /drip
- a: More
- button[button]: Deposit
- a[外站]: Docs
- a[外站]: Chart
- button[button]: Isolated
- button[button]: 10x
- button[button]: Manual
- input[text]: Price (USDC)
- a: Mid
- input[text]: Size
- input[text]: （无可见文案·输入框）
- button[button]: Place Order
- a: 0.0450% / 0.0150%
- a: （无可见文案·/explorer/tx/0xbca0ca141280fb3cbe1a04296204400000dbe1 -> /explorer/tx/0xbca0ca141280fb3cbe1a04296204400000dbe1f9ad841a0e60697566d184d527
- a: ETH
- a: （无可见文案·/explorer/tx/0xda0b8b4c3326e5a2db85042922ba12000046a3 -> /explorer/tx/0xda0b8b4c3326e5a2db85042922ba12000046a331ce2a04747dd4369ef22abf8d
- a: ETH
- a: （无可见文案·/explorer/tx/0x516cbf97c2857de552e6042922b9ff010500d7 -> /explorer/tx/0x516cbf97c2857de552e6042922b9ff010500d77d5d889cb7f5356aea818957cf
- a: ETH
- a: （无可见文案·/explorer/tx/0x68c237b4f73a45d66a3b04292282e70000fd4f -> /explorer/tx/0x68c237b4f73a45d66a3b04292282e70000fd4f9a923d64a80c8ae307b63e1fc1
- a: ETH
- a: （无可见文案·/explorer/tx/0xc987f11ed4a8f8eacb01042922242d01110009 -> /explorer/tx/0xc987f11ed4a8f8eacb01042922242d01110009046fac17bc6d509c7193acd2d5
- a: ETH
- a: （无可见文案·/explorer/tx/0x1a963da69cf724961c0f042921d4ca010d0055 -> /explorer/tx/0x1a963da69cf724961c0f042921d4ca010d00558c37fa4368be5ee8f95bfafe80
- a: ETH
- a: （无可见文案·/explorer/tx/0xfb11242d69c015a2fc8a042921d2aa0102003c -> /explorer/tx/0xfb11242d69c015a2fc8a042921d2aa0102003c1304c334759ed9cf8028c3ef8d
- a: ETH
- a: （无可见文案·/explorer/tx/0x881b2e64dbc1e066899404291ef55701010046 -> /explorer/tx/0x881b2e64dbc1e066899404291ef557010100464a76c4ff382be3d9b79ac5ba51
- a: ETH
- a: （无可见文案·/explorer/tx/0x7174e12ecc276ccb72ee04291eedd5010100f9 -> /explorer/tx/0x7174e12ecc276ccb72ee04291eedd5010100f914672a8b9d153d8c818b2b46b6
- a: ETH
- a: （无可见文案·/explorer/tx/0x94c4f6d1e0557d4c963e04291eed930106000e -> /explorer/tx/0x94c4f6d1e0557d4c963e04291eed930106000eb77b589c1e388da2249f595737
- a: ETH
- a: （无可见文案·/explorer/tx/0x7dd88f358a5b05957f520428c059c0010500a7 -> /explorer/tx/0x7dd88f358a5b05957f520428c059c0010500a71b255e246721a13a88495edf80
- a: BTC
- a: （无可见文案·/explorer/tx/0xa022d59bfd6a9711a19c0428c0591e010800ed -> /explorer/tx/0xa022d59bfd6a9711a19c0428c0591e010800ed81986db5e343eb80eebc6e70fc
- a: BTC
- a: （无可见文案·/explorer/tx/0x688212fd7726d2d869fb0428c056450101002a -> /explorer/tx/0x688212fd7726d2d869fb0428c056450101002ae31229f1aa0c4abe50362aacc3
- a: BTC
- a: （无可见文案·/explorer/tx/0x8cc7a1158bb4cb1e8e410428c05381010600b8 -> /explorer/tx/0x8cc7a1158bb4cb1e8e410428c05381010600b8fb26b7e9f030904c684ab8a509
- a: BTC
- a: （无可见文案·/explorer/tx/0xfce587291cb8dbfffe5f0428c0459d010a009f -> /explorer/tx/0xfce587291cb8dbfffe5f0428c0459d010a009f0eb7bbfad2a0ae327bdbbcb5ea
- a: BTC
- a: （无可见文案·/explorer/tx/0x2e5b42f80bd65a7b2fd40428c044c50104005a -> /explorer/tx/0x2e5b42f80bd65a7b2fd40428c044c50104005adda6d9794dd223ee4acada3465
- a: BTC
- a: （无可见文案·/explorer/tx/0x6d0ece25d623a3a06e880428c026c1010500e6 -> /explorer/tx/0x6d0ece25d623a3a06e880428c026c1010500e60b7126c27210d7797895277d8b
- a: BTC
- a: （无可见文案·/explorer/tx/0x5c272eda8364c9335da00428c0260b01070046 -> /explorer/tx/0x5c272eda8364c9335da00428c0260b01070046c01e67e805ffefda2d4268a31d
- a: BTC
- a: （无可见文案·/explorer/tx/0x140c368797506ccc15850428c022d00105004e -> /explorer/tx/0x140c368797506ccc15850428c022d00105004e6d32538b9eb7d4e1da565446b6
- a: BTC
- a: （无可见文案·/explorer/tx/0xbb3cc65bf02e7c1ebcb60428c02008010200de -> /explorer/tx/0xbb3cc65bf02e7c1ebcb60428c02008010200de418b219af05f0571aeaf225609
- a: BTC
- a: （无可见文案·/explorer/tx/0xaf364af650420e8db0b00428c011d701090062 -> /explorer/tx/0xaf364af650420e8db0b00428c011d701090062dbeb452d5f52fef6490f45e878
- a: BTC
- a: （无可见文案·/explorer/tx/0x11e9bf77216b481913630428c01137010b00d7 -> /explorer/tx/0x11e9bf77216b481913630428c01137010b00d75cbc6e66ebb5b26ac9e06f2203
- a: BTC
- a: （无可见文案·/explorer/tx/0x1e91c94295bcc4a6200b0428bfd4d5010200e1 -> /explorer/tx/0x1e91c94295bcc4a6200b0428bfd4d5010200e12830bfe378c25a749554b09e90
- a: BTC
- a: （无可见文案·/explorer/tx/0xbb12c7a978c2082dbc8c0428bfd440010400df -> /explorer/tx/0xbb12c7a978c2082dbc8c0428bfd440010400df8f13c526ff5edb72fc37c5e218
- a: BTC
- a: （无可见文案·/explorer/tx/0x7683adb1a2e733f877fd0428bfd1b1010100c5 -> /explorer/tx/0x7683adb1a2e733f877fd0428bfd1b1010100c5973dea52ca1a4c590461eb0de3
- a: BTC
- a: （无可见文案·/explorer/tx/0x52c0421b1996ce4554390428bfd069010c005a -> /explorer/tx/0x52c0421b1996ce4554390428bfd069010c005a00b499ed17f688ed6dd89aa82f
- a: BTC
- a: （无可见文案·/explorer/tx/0x2f6bcc0c97d659b930e50428bfc992010300e3 -> /explorer/tx/0x2f6bcc0c97d659b930e50428bfc992010300e3f232d9788bd334775f56da33a3
- a: BTC
- a: （无可见文案·/explorer/tx/0x2d59aa0c32a1773d2ed30428bfc936010400c1 -> /explorer/tx/0x2d59aa0c32a1773d2ed30428bfc936010400c1f1cda4960fd122555ef1a55127
- a: BTC
- a: （无可见文案·/explorer/tx/0xf990711e5b54b945fb0a0428bfbe2a01030089 -> /explorer/tx/0xf990711e5b54b945fb0a0428bfbe2a0103008903f657d8189d591c711a589330
- a: BTC
- a: （无可见文案·/explorer/tx/0x676288803c9c680968dc0428bfbd80010900a0 -> /explorer/tx/0x676288803c9c680968dc0428bfbd80010900a065d79f86db0b2b33d2fb9041f4
- a: BTC
- a: View All -> /tradeHistory/0x676569831D1002d061465b17368D774913e807F5
- a: Export as CSV
- a[外站]: Export More
- button[button]: Deposit
- button[button]: Perps
Spot
- button[button]: Withdraw
- a[外站]: Online
- a[外站]: Docs
- a[外站]: Support
- a: Terms -> /terms
- a: Privacy Policy -> /privacyPolicy
- div: Market
- div: Limit
- div: Pro
- div: Buy / Long
- div: Sell / Short
- div: Take Profit / Stop Loss
- div: Positions
- div: Open Orders
- div: Trade History
- div: Funding History
- div: Order History
- div: Market
- div: Market
- div: Size

===== 第 4 屏 =====
URL: https://app.hyperliquid-testnet.xyz/trade
TITLE: 25.500 | HYPE | Hyperliquid
TEXT:
Announcements
Manual borrowing now available
Use HYPE and BTC as collateral to borrow USDC and USDT
New listing: USELESS-USDC perps
New listing: PONS-USDC perps
Trade
Outcomes
Portfolio
Earn
Vaults
Staking
Referrals
Leaderboard
Faucet
More
Deposit
0x6765...07F5
HYPE-USD is a hyperp (Hyperliquid-only perp) for the pre-launch HYPE token, which uses recent average mark price for the funding oracle. See Docs for more details. Trading is on low leverage and isolated margin only. Beware of low liquidity, high volatility, and increased liquidation risk.
HYPE-USDC
10x
Mark
11.000
Oracle
35.334
24h Change
+0.000 / +0.00%
24h Volume
$47.08
Open Interest
$101.20
Funding / Countdown
0.0000%   00:07:43
Chart
Funding
Chart by TradingView
Order Book
Trades
 
0.001
HYPE
Price
Size (HYPE)
Total (HYPE)
91.345
0.58
39.92
89.108
0.60
39.34
85.507
0.63
38.74
83.248
0.64
38.11
80.988
0.66
37.47
80.083
0.26
36.81
78.805
0.79
36.55
78.729
0.68
35.76
71.545
0.39
35.08
40.500
24.69
34.69
40.000
10.00
10.00
Spread
29.000
113.725%
11.000
10.42
10.42
10.123
0.60
11.02
Isolated
10x
Manual
Market
Limit
Pro
Buy / Long
Sell / Short
Available to Trade
984.01 USDC
Current Position
0.00 HYPE
Price (USDC)
 Mid
Size
HYPE
%
Reduce Only
TIF
GTC
Take Profit / Stop Loss
Place Order
Liquidation Price
N/A
Order Value
N/A
Margin Required
N/A
Fees
0.0450% / 0.0150%
Balances (1)
Positions
Outcomes
Open Orders
TWAP
Chase
Trade History
Funding History
Order History
Side
Market
Time
	
Market
	
Size
	
Side
	
Payment
	
Rate

2026/9/16 02:00:00	ETH	
0.0400 ETH
	Long	
0.0119 USDC
	
-0.0121%

2026/9/16 01:00:00	ETH	
0.0400 ETH
	Long	
0.0097 USDC
	
-0.0100%

2026/9/16 00:00:00	ETH	
0.0400 ETH
	Long	
0.0157 USDC
	
-0.0162%

2026/9/15 23:00:00	ETH	
0.0400 ETH
	Long	
0.0103 USDC
	
-0.0107%

2026/9/15 22:00:00	ETH	
0.0400 ETH
	Long	
0.0063 USDC
	
-0.0064%

2026/9/15 21:00:00	ETH	
0.0400 ETH
	Long	
0.0051 USDC
	
-0.0051%

2026/9/15 20:00:00	ETH	
0.0400 ETH
	Long	
0.0044 USDC
	
-0.0045%

2026/9/15 19:00:00	ETH	
0.0400 ETH
	Long	
0.0044 USDC
	
-0.0044%

2026/9/15 18:00:00	ETH	
0.0400 ETH
	Long	
0.0008 USDC
	
-0.0008%

2026/9/15 17:00:00	ETH	
0.0400 ETH
	Long	
0.0021 USDC
	
-0.0022%

2026/9/15 16:00:00	ETH	
0.0400 ETH
	Long	
0.0089 USDC
	
-0.0090%

2026/9/15 15:00:00	ETH	
0.0400 ETH
	Long	
0.0093 USDC
	
-0.0094%

2026/9/15 14:00:00	ETH	
0.0400 ETH
	Long	
0.0096 USDC
	
-0.0096%

2026/9/15 13:00:00	ETH	
0.0400 ETH
	Long	
-0.0006 USDC
	
0.0006%

2026/9/15 12:00:00	ETH	
0.0400 ETH
	Long	
-0.0012 USDC
	
0.0013%

2026/9/15 11:00:00	ETH	
0.0400 ETH
	Long	
0.0028 USDC
	
-0.0027%

2026/9/15 10:00:00	ETH	
0.0400 ETH
	Long	
0.0091 USDC
	
-0.0090%

2026/9/15 09:00:00	ETH	
0.0400 ETH
	Long	
0.0063 USDC
	
-0.0062%

2026/9/15 08:00:00	ETH	
0.0400 ETH
	Long	
-0.0013 USDC
	
0.0013%

2026/9/15 07:00:00	ETH	
0.0400 ETH
	Long	
-0.0013 USDC
	
0.0013%

2026/9/15 06:00:00	ETH	
0.0400 ETH
	Long	
-0.0013 USDC
	
0.0013%

2026/9/15 05:00:00	ETH	
0.0400 ETH
	Long	
0.0073 USDC
	
-0.0071%

2026/9/15 04:00:00	ETH	
0.0400 ETH
	Long	
0.0351 USDC
	
-0.0345%

2026/9/15 03:00:00	ETH	
0.0400 ETH
	Long	
0.0295 USDC
	
-0.0291%

2026/9/15 02:00:00	ETH	
0.0400 ETH
	Long	
0.0106 USDC
	
-0.0105%

2026/9/15 01:00:00	ETH	
0.0400 ETH
	Long	
0.0096 USDC
	
-0.0095%

2026/9/15 00:00:00	ETH	
0.0400 ETH
	Long	
0.0245 USDC
	
-0.0244%

2026/9/14 23:00:00	ETH	
0.0400 ETH
	Long	
0.0246 USDC
	
-0.0246%

2026/9/14 22:00:00	ETH	
0.0400 ETH
	Long	
0.0206 USDC
	
-0.0206%

2026/9/14 21:00:00	ETH	
0.0400 ETH
	Long	
0.0362 USDC
	
-0.0361%
View All
Export as CSV
Deposit
Perps
Spot
Withdraw
Account Equity
Spot
$0.00
Perps
$984.02
Perps Overview
Balance
$984.02
Unrealized PNL
$0.00
Cross Margin Ratio
0.00%
Maintenance Margin
$0.00
Cross Account Leverage
0.00x
Online
Docs
Support
Terms
Privacy Policy
CONTROLS:
- a: （无可见文案·/trade） -> /trade
- a: Trade -> /trade
- a: Outcomes -> /outcomes
- a: Portfolio -> /portfolio
- a: Earn -> /earn
- a: Vaults -> /vaults
- a: Staking -> /staking
- a: Referrals -> /referrals
- a: Leaderboard -> /leaderboard
- a: Faucet -> /drip
- a: More
- button[button]: Deposit
- a[外站]: Docs
- a[外站]: Chart
- button[button]: Isolated
- button[button]: 10x
- button[button]: Manual
- input[text]: Price (USDC)
- a: Mid
- input[text]: Size
- input[text]: （无可见文案·输入框）
- button[button]: Place Order
- a: 0.0450% / 0.0150%
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: View All -> /fundingHistory/0x676569831D1002d061465b17368D774913e807F5
- a: Export as CSV
- button[button]: Deposit
- button[button]: Perps
Spot
- button[button]: Withdraw
- a[外站]: Online
- a[外站]: Docs
- a[外站]: Support
- a: Terms -> /terms
- a: Privacy Policy -> /privacyPolicy
- div: Market
- div: Limit
- div: Pro
- div: Buy / Long
- div: Sell / Short
- div: Take Profit / Stop Loss
- div: Positions
- div: Open Orders
- div: Trade History
- div: Funding History
- div: Order History
- div: Market
- div: Market
- div: Size

===== 第 5 屏 =====
URL: https://app.hyperliquid-testnet.xyz/trade
TITLE: 25.500 | HYPE | Hyperliquid
TEXT:
Announcements
Manual borrowing now available
Use HYPE and BTC as collateral to borrow USDC and USDT
New listing: USELESS-USDC perps
New listing: PONS-USDC perps
Trade
Outcomes
Portfolio
Earn
Vaults
Staking
Referrals
Leaderboard
Faucet
More
Deposit
0x6765...07F5
HYPE-USD is a hyperp (Hyperliquid-only perp) for the pre-launch HYPE token, which uses recent average mark price for the funding oracle. See Docs for more details. Trading is on low leverage and isolated margin only. Beware of low liquidity, high volatility, and increased liquidation risk.
HYPE-USDC
10x
Mark
11.000
Oracle
35.334
24h Change
+0.000 / +0.00%
24h Volume
$47.08
Open Interest
$101.20
Funding / Countdown
0.0000%   00:07:40
Chart
Funding
Chart by TradingView
Order Book
Trades
 
0.001
HYPE
Price
Size (HYPE)
Total (HYPE)
91.345
0.58
39.92
89.108
0.60
39.34
85.507
0.63
38.74
83.248
0.64
38.11
80.988
0.66
37.47
80.083
0.26
36.81
78.805
0.79
36.55
78.729
0.68
35.76
71.545
0.39
35.08
40.500
24.69
34.69
40.000
10.00
10.00
Spread
29.000
113.725%
11.000
10.42
10.42
10.123
0.60
11.02
Isolated
10x
Manual
Market
Limit
Pro
Buy / Long
Sell / Short
Available to Trade
984.01 USDC
Current Position
0.00 HYPE
Price (USDC)
 Mid
Size
HYPE
%
Reduce Only
TIF
GTC
Take Profit / Stop Loss
Place Order
Liquidation Price
N/A
Order Value
N/A
Margin Required
N/A
Fees
0.0450% / 0.0150%
Balances (1)
Positions
Outcomes
Open Orders
TWAP
Chase
Trade History
Funding History
Order History
Type
Side
Market
Time
	
Type
	
Market
	
Direction
	
Size
	
Filled Size
	
Order Value
	
Price
	
Reduce Only
	
Trigger Conditions
	
TP/SL
	
Status
	
Order ID

2026/9/16 02:45:58	Market	ETH	Close Long	--	0.0400	--	Market	Yes	N/A	--	Filled	60207518734
2026/9/12 23:24:00	Limit	ETH	Long	--	0.0100	--	2,520.4	No	N/A	--	Filled	59957864565
2026/9/12 23:23:24	Limit	ETH	Long	0.0100	--	25.20 USDC	2,520.4	No	N/A	--	Open	59957864565
2026/9/12 23:07:44	Limit	ETH	Long	--	0.0100	--	2,519.9	No	N/A	--	Filled	59957037159
2026/9/12 23:07:44	Limit	ETH	Long	0.0100	--	25.20 USDC	2,519.9	No	N/A	--	Open	59957037159
2026/9/12 22:39:36	Limit	ETH	Long	--	0.0100	--	2,524.4	No	N/A	--	Filled	59955614640
2026/9/12 22:39:36	Limit	ETH	Long	0.0100	--	25.24 USDC	2,524.4	No	N/A	--	Open	59955614640
2026/9/12 22:15:17	Limit	ETH	Long	--	0.0100	--	2,522.2	No	N/A	--	Filled	59954288234
2026/9/12 22:13:05	Limit	ETH	Long	0.0100	--	25.22 USDC	2,522.2	No	N/A	--	Open	59954288234
2026/9/12 22:07:01	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59953980081
2026/9/12 22:01:45	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59953702361
2026/9/12 21:55:00	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59953354341
2026/9/12 21:49:02	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59953054349
2026/9/12 21:24:25	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59951768824
2026/9/12 21:10:48	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59951049674
2026/9/12 21:05:09	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59950740689
2026/9/12 20:59:00	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59950417528
2026/9/12 20:53:34	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59950144591
2026/9/12 20:45:10	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59949718062
2026/9/12 20:37:03	Market	HYPE	Long	0.01	--	Market	Market	No	N/A	--	
Rejected
	59949301969
2026/9/12 20:31:27	Market	HYPE	Long	0.01	--	Market	Market	No	N/A	--	
Rejected
	59949019708
2026/9/12 20:25:49	Market	HYPE	Long	0.01	--	Market	Market	No	N/A	--	
Rejected
	59948737053
2026/9/12 19:41:29	Market	HYPE	Long	0.01	--	Market	Market	No	N/A	--	
Rejected
	59946477914
2026/9/12 18:35:08	Market	ETH	Close Long	--	0.0100	--	Market	Yes	N/A	--	Filled	59943145571
2026/9/12 18:35:08	Market	ETH	Close Long	0.0100	--	Market	Market	Yes	N/A	--	Open	59943145571
2026/9/12 18:32:44	Limit	ETH	Long	--	0.0100	--	2,513.7	No	N/A	--	Filled	59943020335
2026/9/12 18:32:35	Limit	ETH	Long	0.0100	--	25.14 USD
CONTROLS:
- a: （无可见文案·/trade） -> /trade
- a: Trade -> /trade
- a: Outcomes -> /outcomes
- a: Portfolio -> /portfolio
- a: Earn -> /earn
- a: Vaults -> /vaults
- a: Staking -> /staking
- a: Referrals -> /referrals
- a: Leaderboard -> /leaderboard
- a: Faucet -> /drip
- a: More
- button[button]: Deposit
- a[外站]: Docs
- a[外站]: Chart
- button[button]: Isolated
- button[button]: 10x
- button[button]: Manual
- input[text]: Price (USDC)
- a: Mid
- input[text]: Size
- input[text]: （无可见文案·输入框）
- button[button]: Place Order
- a: 0.0450% / 0.0150%
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: BTC
- a: BTC
- a: BTC
- a: View All -> /historicalOrders/0x676569831D1002d061465b17368D774913e807F5
- button[button]: Deposit
- button[button]: Perps
Spot
- button[button]: Withdraw
- a[外站]: Online
- a[外站]: Docs
- a[外站]: Support
- a: Terms -> /terms
- a: Privacy Policy -> /privacyPolicy
- div: Market
- div: Limit
- div: Pro
- div: Buy / Long
- div: Sell / Short
- div: Take Profit / Stop Loss
- div: Positions
- div: Open Orders
- div: Trade History
- div: Funding History
- div: Order History
- div: Market
- div: Market
- div: Size

===== 第 6 屏 =====
URL: https://app.hyperliquid-testnet.xyz/trade
TITLE: 25.500 | HYPE | Hyperliquid
TEXT:
Announcements
Manual borrowing now available
Use HYPE and BTC as collateral to borrow USDC and USDT
New listing: USELESS-USDC perps
New listing: PONS-USDC perps
Trade
Outcomes
Portfolio
Earn
Vaults
Staking
Referrals
Leaderboard
Faucet
More
Deposit
0x6765...07F5
HYPE-USD is a hyperp (Hyperliquid-only perp) for the pre-launch HYPE token, which uses recent average mark price for the funding oracle. See Docs for more details. Trading is on low leverage and isolated margin only. Beware of low liquidity, high volatility, and increased liquidation risk.
HYPE-USDC
10x
Mark
11.000
Oracle
35.334
24h Change
+0.000 / +0.00%
24h Volume
$47.08
Open Interest
$101.20
Funding / Countdown
0.0000%   00:07:37
Chart
Funding
Chart by TradingView
Order Book
Trades
 
0.001
HYPE
Price
Size (HYPE)
Total (HYPE)
91.345
0.58
39.92
89.108
0.60
39.34
85.507
0.63
38.74
83.248
0.64
38.11
80.988
0.66
37.47
80.083
0.26
36.81
78.805
0.79
36.55
78.729
0.68
35.76
71.545
0.39
35.08
40.500
24.69
34.69
40.000
10.00
10.00
Spread
29.000
113.725%
11.000
10.42
10.42
10.123
0.60
11.02
Isolated
10x
Manual
Market
Limit
Pro
Buy / Long
Sell / Short
Available to Trade
984.01 USDC
Current Position
0.00 HYPE
Price (USDC)
 Mid
Size
HYPE
%
Reduce Only
TIF
GTC
Take Profit / Stop Loss
Place Order
Liquidation Price
N/A
Order Value
N/A
Margin Required
N/A
Fees
0.0450% / 0.0150%
Balances (1)
Positions
Outcomes
Open Orders
TWAP
Chase
Trade History
Funding History
Order History
Type
Side
Market
Time
	
Type
	
Market
	
Direction
	
Size
	
Filled Size
	
Order Value
	
Price
	
Reduce Only
	
Trigger Conditions
	
TP/SL
	
Status
	
Order ID

2026/9/16 02:45:58	Market	ETH	Close Long	--	0.0400	--	Market	Yes	N/A	--	Filled	60207518734
2026/9/12 23:24:00	Limit	ETH	Long	--	0.0100	--	2,520.4	No	N/A	--	Filled	59957864565
2026/9/12 23:23:24	Limit	ETH	Long	0.0100	--	25.20 USDC	2,520.4	No	N/A	--	Open	59957864565
2026/9/12 23:07:44	Limit	ETH	Long	--	0.0100	--	2,519.9	No	N/A	--	Filled	59957037159
2026/9/12 23:07:44	Limit	ETH	Long	0.0100	--	25.20 USDC	2,519.9	No	N/A	--	Open	59957037159
2026/9/12 22:39:36	Limit	ETH	Long	--	0.0100	--	2,524.4	No	N/A	--	Filled	59955614640
2026/9/12 22:39:36	Limit	ETH	Long	0.0100	--	25.24 USDC	2,524.4	No	N/A	--	Open	59955614640
2026/9/12 22:15:17	Limit	ETH	Long	--	0.0100	--	2,522.2	No	N/A	--	Filled	59954288234
2026/9/12 22:13:05	Limit	ETH	Long	0.0100	--	25.22 USDC	2,522.2	No	N/A	--	Open	59954288234
2026/9/12 22:07:01	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59953980081
2026/9/12 22:01:45	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59953702361
2026/9/12 21:55:00	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59953354341
2026/9/12 21:49:02	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59953054349
2026/9/12 21:24:25	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59951768824
2026/9/12 21:10:48	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59951049674
2026/9/12 21:05:09	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59950740689
2026/9/12 20:59:00	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59950417528
2026/9/12 20:53:34	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59950144591
2026/9/12 20:45:10	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59949718062
2026/9/12 20:37:03	Market	HYPE	Long	0.01	--	Market	Market	No	N/A	--	
Rejected
	59949301969
2026/9/12 20:31:27	Market	HYPE	Long	0.01	--	Market	Market	No	N/A	--	
Rejected
	59949019708
2026/9/12 20:25:49	Market	HYPE	Long	0.01	--	Market	Market	No	N/A	--	
Rejected
	59948737053
2026/9/12 19:41:29	Market	HYPE	Long	0.01	--	Market	Market	No	N/A	--	
Rejected
	59946477914
2026/9/12 18:35:08	Market	ETH	Close Long	--	0.0100	--	Market	Yes	N/A	--	Filled	59943145571
2026/9/12 18:35:08	Market	ETH	Close Long	0.0100	--	Market	Market	Yes	N/A	--	Open	59943145571
2026/9/12 18:32:44	Limit	ETH	Long	--	0.0100	--	2,513.7	No	N/A	--	Filled	59943020335
2026/9/12 18:32:35	Limit	ETH	Long	0.0100	--	25.14 USD
CONTROLS:
- a: （无可见文案·/trade） -> /trade
- a: Trade -> /trade
- a: Outcomes -> /outcomes
- a: Portfolio -> /portfolio
- a: Earn -> /earn
- a: Vaults -> /vaults
- a: Staking -> /staking
- a: Referrals -> /referrals
- a: Leaderboard -> /leaderboard
- a: Faucet -> /drip
- a: More
- button[button]: Deposit
- a[外站]: Docs
- a[外站]: Chart
- button[button]: Isolated
- button[button]: 10x
- button[button]: Manual
- input[text]: Price (USDC)
- a: Mid
- input[text]: Size
- input[text]: （无可见文案·输入框）
- button[button]: Place Order
- a: 0.0450% / 0.0150%
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: BTC
- a: BTC
- a: BTC
- a: View All -> /historicalOrders/0x676569831D1002d061465b17368D774913e807F5
- button[button]: Deposit
- button[button]: Perps
Spot
- button[button]: Withdraw
- div: Chase
Scale
Stop Limit
Stop Market
Take Limit
Take Market
Tr
- div: Chase
- div: Scale
- div: Stop Limit
- div: Stop Market
- div: Take Limit
- a[外站]: Online
- a[外站]: Docs
- a[外站]: Support
- a: Terms -> /terms
- a: Privacy Policy -> /privacyPolicy
- div: Market
- div: Limit
- div: Pro
- div: Buy / Long
- div: Sell / Short
- div: Take Profit / Stop Loss
- div: Positions
- div: Open Orders
- div: Trade History
- div: Funding History
- div: Order History
- div: Market
- div: Market
- div: Size

===== 第 7 屏 =====
URL: https://app.hyperliquid-testnet.xyz/trade
TITLE: 25.500 | HYPE | Hyperliquid
TEXT:
Announcements
Manual borrowing now available
Use HYPE and BTC as collateral to borrow USDC and USDT
New listing: USELESS-USDC perps
New listing: PONS-USDC perps
Trade
Outcomes
Portfolio
Earn
Vaults
Staking
Referrals
Leaderboard
Faucet
More
Deposit
0x6765...07F5
HYPE-USD is a hyperp (Hyperliquid-only perp) for the pre-launch HYPE token, which uses recent average mark price for the funding oracle. See Docs for more details. Trading is on low leverage and isolated margin only. Beware of low liquidity, high volatility, and increased liquidation risk.
HYPE-USDC
10x
Mark
11.000
Oracle
35.334
24h Change
+0.000 / +0.00%
24h Volume
$47.08
Open Interest
$101.20
Funding / Countdown
0.0000%   00:07:34
Chart
Funding
Chart by TradingView
Order Book
Trades
 
0.001
HYPE
Price
Size (HYPE)
Total (HYPE)
91.345
0.58
39.92
89.108
0.60
39.34
85.507
0.63
38.74
83.248
0.64
38.11
80.988
0.66
37.47
80.083
0.26
36.81
78.805
0.79
36.55
78.729
0.68
35.76
71.545
0.39
35.08
40.500
24.69
34.69
40.000
10.00
10.00
Spread
29.000
113.725%
11.000
10.42
10.42
10.123
0.60
11.02
Isolated
10x
Manual
Market
Limit
Pro
Buy / Long
Sell / Short
Available to Trade
984.01 USDC
Current Position
0.00 HYPE
Price (USDC)
 Mid
Size
HYPE
%
Reduce Only
TIF
GTC
Take Profit / Stop Loss
TP Price
Gain
%
SL Price
Loss
%
Place Order
Liquidation Price
N/A
Order Value
N/A
Margin Required
N/A
Fees
0.0450% / 0.0150%
Balances (1)
Positions
Outcomes
Open Orders
TWAP
Chase
Trade History
Funding History
Order History
Type
Side
Market
Time
	
Type
	
Market
	
Direction
	
Size
	
Filled Size
	
Order Value
	
Price
	
Reduce Only
	
Trigger Conditions
	
TP/SL
	
Status
	
Order ID

2026/9/16 02:45:58	Market	ETH	Close Long	--	0.0400	--	Market	Yes	N/A	--	Filled	60207518734
2026/9/12 23:24:00	Limit	ETH	Long	--	0.0100	--	2,520.4	No	N/A	--	Filled	59957864565
2026/9/12 23:23:24	Limit	ETH	Long	0.0100	--	25.20 USDC	2,520.4	No	N/A	--	Open	59957864565
2026/9/12 23:07:44	Limit	ETH	Long	--	0.0100	--	2,519.9	No	N/A	--	Filled	59957037159
2026/9/12 23:07:44	Limit	ETH	Long	0.0100	--	25.20 USDC	2,519.9	No	N/A	--	Open	59957037159
2026/9/12 22:39:36	Limit	ETH	Long	--	0.0100	--	2,524.4	No	N/A	--	Filled	59955614640
2026/9/12 22:39:36	Limit	ETH	Long	0.0100	--	25.24 USDC	2,524.4	No	N/A	--	Open	59955614640
2026/9/12 22:15:17	Limit	ETH	Long	--	0.0100	--	2,522.2	No	N/A	--	Filled	59954288234
2026/9/12 22:13:05	Limit	ETH	Long	0.0100	--	25.22 USDC	2,522.2	No	N/A	--	Open	59954288234
2026/9/12 22:07:01	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59953980081
2026/9/12 22:01:45	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59953702361
2026/9/12 21:55:00	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59953354341
2026/9/12 21:49:02	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59953054349
2026/9/12 21:24:25	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59951768824
2026/9/12 21:10:48	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59951049674
2026/9/12 21:05:09	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59950740689
2026/9/12 20:59:00	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59950417528
2026/9/12 20:53:34	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59950144591
2026/9/12 20:45:10	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59949718062
2026/9/12 20:37:03	Market	HYPE	Long	0.01	--	Market	Market	No	N/A	--	
Rejected
	59949301969
2026/9/12 20:31:27	Market	HYPE	Long	0.01	--	Market	Market	No	N/A	--	
Rejected
	59949019708
2026/9/12 20:25:49	Market	HYPE	Long	0.01	--	Market	Market	No	N/A	--	
Rejected
	59948737053
2026/9/12 19:41:29	Market	HYPE	Long	0.01	--	Market	Market	No	N/A	--	
Rejected
	59946477914
2026/9/12 18:35:08	Market	ETH	Close Long	--	0.0100	--	Market	Yes	N/A	--	Filled	59943145571
2026/9/12 18:35:08	Market	ETH	Close Long	0.0100	--	Market	Market	Yes	N/A	--	Open	59943145571
2026/9/12 18:32:44	Limit	ETH	Long	--	0.0100	--	2,513.7	No	N/A	--	Filled	59943020335
2026/9/12 18:32:35	Li
CONTROLS:
- a: （无可见文案·/trade） -> /trade
- a: Trade -> /trade
- a: Outcomes -> /outcomes
- a: Portfolio -> /portfolio
- a: Earn -> /earn
- a: Vaults -> /vaults
- a: Staking -> /staking
- a: Referrals -> /referrals
- a: Leaderboard -> /leaderboard
- a: Faucet -> /drip
- a: More
- button[button]: Deposit
- a[外站]: Docs
- a[外站]: Chart
- button[button]: Isolated
- button[button]: 10x
- button[button]: Manual
- input[text]: Price (USDC)
- a: Mid
- input[text]: Size
- input[text]: （无可见文案·输入框）
- input[text]: TP Price
- input[text]: Gain
- input[text]: SL Price
- input[text]: Loss
- button[button]: Place Order
- a: 0.0450% / 0.0150%
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: BTC
- a: BTC
- a: BTC
- a: View All -> /historicalOrders/0x676569831D1002d061465b17368D774913e807F5
- button[button]: Deposit
- button[button]: Perps
Spot
- button[button]: Withdraw
- div: Chase
Scale
Stop Limit
Stop Market
Take Limit
Take Market
Tr
- div: Chase
- div: Scale
- div: Stop Limit
- div: Stop Market
- div: Take Limit
- a[外站]: Online
- a[外站]: Docs
- a[外站]: Support
- a: Terms -> /terms
- a: Privacy Policy -> /privacyPolicy
- div: Market
- div: Limit
- div: Pro
- div: Buy / Long
- div: Sell / Short
- div: Take Profit / Stop Loss
- div: Positions
- div: Open Orders
- div: Trade History
- div: Funding History
- div: Order History
- div: Market
- div: Market
- div: Size

===== 第 8 屏 =====
URL: https://app.hyperliquid-testnet.xyz/trade
TITLE: 25.500 | HYPE | Hyperliquid
TEXT:
Announcements
Manual borrowing now available
Use HYPE and BTC as collateral to borrow USDC and USDT
New listing: USELESS-USDC perps
New listing: PONS-USDC perps
Trade
Outcomes
Portfolio
Earn
Vaults
Staking
Referrals
Leaderboard
Faucet
More
Deposit
0x6765...07F5
HYPE-USD is a hyperp (Hyperliquid-only perp) for the pre-launch HYPE token, which uses recent average mark price for the funding oracle. See Docs for more details. Trading is on low leverage and isolated margin only. Beware of low liquidity, high volatility, and increased liquidation risk.
HYPE-USDC
10x
Mark
11.000
Oracle
35.334
24h Change
+0.000 / +0.00%
24h Volume
$47.08
Open Interest
$101.20
Funding / Countdown
0.0000%   00:07:31
Chart
Funding
Chart by TradingView
Order Book
Trades
 
0.001
HYPE
Price
Size (HYPE)
Total (HYPE)
91.345
0.58
39.92
89.108
0.60
39.34
85.507
0.63
38.74
83.248
0.64
38.11
80.988
0.66
37.47
80.083
0.26
36.81
78.805
0.79
36.55
78.729
0.68
35.76
71.545
0.39
35.08
40.500
24.69
34.69
40.000
10.00
10.00
Spread
29.000
113.725%
11.000
10.42
10.42
10.123
0.60
11.02
Isolated
10x
Manual
Market
Limit
Chase
Buy / Long
Sell / Short
Available to Trade
984.01 USDC
Current Position
0.00 HYPE
Chase Price
39.999
Size
HYPE
%
Reduce Only
Max Chase Distance
Place Order
Liquidation Price
N/A
Order Value
N/A
Margin Required
N/A
Fees
0.0450% / 0.0150%
Balances (1)
Positions
Outcomes
Open Orders
TWAP
Chase
Trade History
Funding History
Order History
Type
Side
Market
Time
	
Type
	
Market
	
Direction
	
Size
	
Filled Size
	
Order Value
	
Price
	
Reduce Only
	
Trigger Conditions
	
TP/SL
	
Status
	
Order ID

2026/9/16 02:45:58	Market	ETH	Close Long	--	0.0400	--	Market	Yes	N/A	--	Filled	60207518734
2026/9/12 23:24:00	Limit	ETH	Long	--	0.0100	--	2,520.4	No	N/A	--	Filled	59957864565
2026/9/12 23:23:24	Limit	ETH	Long	0.0100	--	25.20 USDC	2,520.4	No	N/A	--	Open	59957864565
2026/9/12 23:07:44	Limit	ETH	Long	--	0.0100	--	2,519.9	No	N/A	--	Filled	59957037159
2026/9/12 23:07:44	Limit	ETH	Long	0.0100	--	25.20 USDC	2,519.9	No	N/A	--	Open	59957037159
2026/9/12 22:39:36	Limit	ETH	Long	--	0.0100	--	2,524.4	No	N/A	--	Filled	59955614640
2026/9/12 22:39:36	Limit	ETH	Long	0.0100	--	25.24 USDC	2,524.4	No	N/A	--	Open	59955614640
2026/9/12 22:15:17	Limit	ETH	Long	--	0.0100	--	2,522.2	No	N/A	--	Filled	59954288234
2026/9/12 22:13:05	Limit	ETH	Long	0.0100	--	25.22 USDC	2,522.2	No	N/A	--	Open	59954288234
2026/9/12 22:07:01	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59953980081
2026/9/12 22:01:45	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59953702361
2026/9/12 21:55:00	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59953354341
2026/9/12 21:49:02	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59953054349
2026/9/12 21:24:25	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59951768824
2026/9/12 21:10:48	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59951049674
2026/9/12 21:05:09	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59950740689
2026/9/12 20:59:00	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59950417528
2026/9/12 20:53:34	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59950144591
2026/9/12 20:45:10	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59949718062
2026/9/12 20:37:03	Market	HYPE	Long	0.01	--	Market	Market	No	N/A	--	
Rejected
	59949301969
2026/9/12 20:31:27	Market	HYPE	Long	0.01	--	Market	Market	No	N/A	--	
Rejected
	59949019708
2026/9/12 20:25:49	Market	HYPE	Long	0.01	--	Market	Market	No	N/A	--	
Rejected
	59948737053
2026/9/12 19:41:29	Market	HYPE	Long	0.01	--	Market	Market	No	N/A	--	
Rejected
	59946477914
2026/9/12 18:35:08	Market	ETH	Close Long	--	0.0100	--	Market	Yes	N/A	--	Filled	59943145571
2026/9/12 18:35:08	Market	ETH	Close Long	0.0100	--	Market	Market	Yes	N/A	--	Open	59943145571
2026/9/12 18:32:44	Limit	ETH	Long	--	0.0100	--	2,513.7	No	N/A	--	Filled	59943020335
2026/9/12 18:32:35	Limit	ETH	Long	0.0100	--	25.14 USDC	2,513.7	
CONTROLS:
- a: （无可见文案·/trade） -> /trade
- a: Trade -> /trade
- a: Outcomes -> /outcomes
- a: Portfolio -> /portfolio
- a: Earn -> /earn
- a: Vaults -> /vaults
- a: Staking -> /staking
- a: Referrals -> /referrals
- a: Leaderboard -> /leaderboard
- a: Faucet -> /drip
- a: More
- button[button]: Deposit
- a[外站]: Docs
- a[外站]: Chart
- button[button]: Isolated
- button[button]: 10x
- button[button]: Manual
- input[text]: Size
- input[text]: （无可见文案·输入框）
- button[button]: Place Order
- a: 0.0450% / 0.0150%
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: BTC
- a: BTC
- a: BTC
- a: View All -> /historicalOrders/0x676569831D1002d061465b17368D774913e807F5
- button[button]: Deposit
- button[button]: Perps
Spot
- button[button]: Withdraw
- a[外站]: Online
- a[外站]: Docs
- a[外站]: Support
- a: Terms -> /terms
- a: Privacy Policy -> /privacyPolicy
- div: Market
- div: Limit
- div: Buy / Long
- div: Sell / Short
- div: Positions
- div: Open Orders
- div: Trade History
- div: Funding History
- div: Order History
- div: Market
- div: Market
- div: Size

===== 第 9 屏 =====
URL: https://app.hyperliquid-testnet.xyz/trade
TITLE: 25.500 | HYPE | Hyperliquid
TEXT:
Announcements
Manual borrowing now available
Use HYPE and BTC as collateral to borrow USDC and USDT
New listing: USELESS-USDC perps
New listing: PONS-USDC perps
Trade
Outcomes
Portfolio
Earn
Vaults
Staking
Referrals
Leaderboard
Faucet
More
Deposit
0x6765...07F5
HYPE-USD is a hyperp (Hyperliquid-only perp) for the pre-launch HYPE token, which uses recent average mark price for the funding oracle. See Docs for more details. Trading is on low leverage and isolated margin only. Beware of low liquidity, high volatility, and increased liquidation risk.
HYPE-USDC
10x
Mark
11.000
Oracle
35.334
24h Change
+0.000 / +0.00%
24h Volume
$47.08
Open Interest
$101.20
Funding / Countdown
0.0000%   00:07:25
Chart
Funding
Chart by TradingView
Order Book
Trades
 
0.001
HYPE
Price
Size (HYPE)
Total (HYPE)
91.345
0.58
39.92
89.108
0.60
39.34
85.507
0.63
38.74
83.248
0.64
38.11
80.988
0.66
37.47
80.083
0.26
36.81
78.805
0.79
36.55
78.729
0.68
35.76
71.545
0.39
35.08
40.500
24.69
34.69
40.000
10.00
10.00
Spread
29.000
113.725%
11.000
10.42
10.42
10.123
0.60
11.02
Isolated
10x
Manual
Market
Limit
Chase
Buy / Long
Sell / Short
Available to Trade
984.01 USDC
Current Position
0.00 HYPE
Chase Price
39.999
Size
HYPE
%
Reduce Only
Max Chase Distance
Place Order
Liquidation Price
N/A
Order Value
N/A
Margin Required
N/A
Fees
0.0450% / 0.0150%
Balances (1)
Positions
Outcomes
Open Orders
TWAP
Chase
Trade History
Funding History
Order History
Type
Side
Market
Time
	
Type
	
Market
	
Direction
	
Size
	
Filled Size
	
Order Value
	
Price
	
Reduce Only
	
Trigger Conditions
	
TP/SL
	
Status
	
Order ID

2026/9/16 02:45:58	Market	ETH	Close Long	--	0.0400	--	Market	Yes	N/A	--	Filled	60207518734
2026/9/12 23:24:00	Limit	ETH	Long	--	0.0100	--	2,520.4	No	N/A	--	Filled	59957864565
2026/9/12 23:23:24	Limit	ETH	Long	0.0100	--	25.20 USDC	2,520.4	No	N/A	--	Open	59957864565
2026/9/12 23:07:44	Limit	ETH	Long	--	0.0100	--	2,519.9	No	N/A	--	Filled	59957037159
2026/9/12 23:07:44	Limit	ETH	Long	0.0100	--	25.20 USDC	2,519.9	No	N/A	--	Open	59957037159
2026/9/12 22:39:36	Limit	ETH	Long	--	0.0100	--	2,524.4	No	N/A	--	Filled	59955614640
2026/9/12 22:39:36	Limit	ETH	Long	0.0100	--	25.24 USDC	2,524.4	No	N/A	--	Open	59955614640
2026/9/12 22:15:17	Limit	ETH	Long	--	0.0100	--	2,522.2	No	N/A	--	Filled	59954288234
2026/9/12 22:13:05	Limit	ETH	Long	0.0100	--	25.22 USDC	2,522.2	No	N/A	--	Open	59954288234
2026/9/12 22:07:01	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59953980081
2026/9/12 22:01:45	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59953702361
2026/9/12 21:55:00	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59953354341
2026/9/12 21:49:02	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59953054349
2026/9/12 21:24:25	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59951768824
2026/9/12 21:10:48	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59951049674
2026/9/12 21:05:09	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59950740689
2026/9/12 20:59:00	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59950417528
2026/9/12 20:53:34	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59950144591
2026/9/12 20:45:10	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59949718062
2026/9/12 20:37:03	Market	HYPE	Long	0.01	--	Market	Market	No	N/A	--	
Rejected
	59949301969
2026/9/12 20:31:27	Market	HYPE	Long	0.01	--	Market	Market	No	N/A	--	
Rejected
	59949019708
2026/9/12 20:25:49	Market	HYPE	Long	0.01	--	Market	Market	No	N/A	--	
Rejected
	59948737053
2026/9/12 19:41:29	Market	HYPE	Long	0.01	--	Market	Market	No	N/A	--	
Rejected
	59946477914
2026/9/12 18:35:08	Market	ETH	Close Long	--	0.0100	--	Market	Yes	N/A	--	Filled	59943145571
2026/9/12 18:35:08	Market	ETH	Close Long	0.0100	--	Market	Market	Yes	N/A	--	Open	59943145571
2026/9/12 18:32:44	Limit	ETH	Long	--	0.0100	--	2,513.7	No	N/A	--	Filled	59943020335
2026/9/12 18:32:35	Limit	ETH	Long	0.0100	--	25.14 USDC	2,513.7	
CONTROLS:
- a: （无可见文案·/trade） -> /trade
- a: Trade -> /trade
- a: Outcomes -> /outcomes
- a: Portfolio -> /portfolio
- a: Earn -> /earn
- a: Vaults -> /vaults
- a: Staking -> /staking
- a: Referrals -> /referrals
- a: Leaderboard -> /leaderboard
- a: Faucet -> /drip
- a: More
- button[button]: Deposit
- a[外站]: Docs
- a[外站]: Chart
- button[button]: Isolated
- button[button]: 10x
- button[button]: Manual
- input[text]: Size
- input[text]: （无可见文案·输入框）
- button[button]: Place Order
- a: 0.0450% / 0.0150%
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: BTC
- a: BTC
- a: BTC
- a: View All -> /historicalOrders/0x676569831D1002d061465b17368D774913e807F5
- button[button]: Deposit
- button[button]: Perps
Spot
- button[button]: Withdraw
- a[外站]: Online
- a[外站]: Docs
- a[外站]: Support
- a: Terms -> /terms
- a: Privacy Policy -> /privacyPolicy
- button[button]: Confirm
- div: Market
- div: Limit
- div: Buy / Long
- div: Sell / Short
- div: Positions
- div: Open Orders
- div: Trade History
- div: Funding History
- div: Order History
- div: Market
- div: Market
- div: Size
- div: Cross

===== 第 10 屏 =====
URL: https://app.hyperliquid-testnet.xyz/trade
TITLE: 25.500 | HYPE | Hyperliquid
TEXT:
Announcements
Manual borrowing now available
Use HYPE and BTC as collateral to borrow USDC and USDT
New listing: USELESS-USDC perps
New listing: PONS-USDC perps
Trade
Outcomes
Portfolio
Earn
Vaults
Staking
Referrals
Leaderboard
Faucet
More
Deposit
0x6765...07F5
HYPE-USD is a hyperp (Hyperliquid-only perp) for the pre-launch HYPE token, which uses recent average mark price for the funding oracle. See Docs for more details. Trading is on low leverage and isolated margin only. Beware of low liquidity, high volatility, and increased liquidation risk.
HYPE-USDC
10x
Mark
11.000
Oracle
35.334
24h Change
+0.000 / +0.00%
24h Volume
$47.08
Open Interest
$101.20
Funding / Countdown
0.0000%   00:07:22
Chart
Funding
Chart by TradingView
Order Book
Trades
 
0.001
HYPE
Price
Size (HYPE)
Total (HYPE)
91.345
0.58
39.92
89.108
0.60
39.34
85.507
0.63
38.74
83.248
0.64
38.11
80.988
0.66
37.47
80.083
0.26
36.81
78.805
0.79
36.55
78.729
0.68
35.76
71.545
0.39
35.08
40.500
24.69
34.69
40.000
10.00
10.00
Spread
29.000
113.725%
11.000
10.42
10.42
10.123
0.60
11.02
Isolated
10x
Manual
Market
Limit
Chase
Buy / Long
Sell / Short
Available to Trade
984.01 USDC
Current Position
0.00 HYPE
Chase Price
39.999
Size
HYPE
%
Reduce Only
Max Chase Distance
Place Order
Liquidation Price
N/A
Order Value
N/A
Margin Required
N/A
Fees
0.0450% / 0.0150%
Balances (1)
Positions
Outcomes
Open Orders
TWAP
Chase
Trade History
Funding History
Order History
Type
Side
Market
Time
	
Type
	
Market
	
Direction
	
Size
	
Filled Size
	
Order Value
	
Price
	
Reduce Only
	
Trigger Conditions
	
TP/SL
	
Status
	
Order ID

2026/9/16 02:45:58	Market	ETH	Close Long	--	0.0400	--	Market	Yes	N/A	--	Filled	60207518734
2026/9/12 23:24:00	Limit	ETH	Long	--	0.0100	--	2,520.4	No	N/A	--	Filled	59957864565
2026/9/12 23:23:24	Limit	ETH	Long	0.0100	--	25.20 USDC	2,520.4	No	N/A	--	Open	59957864565
2026/9/12 23:07:44	Limit	ETH	Long	--	0.0100	--	2,519.9	No	N/A	--	Filled	59957037159
2026/9/12 23:07:44	Limit	ETH	Long	0.0100	--	25.20 USDC	2,519.9	No	N/A	--	Open	59957037159
2026/9/12 22:39:36	Limit	ETH	Long	--	0.0100	--	2,524.4	No	N/A	--	Filled	59955614640
2026/9/12 22:39:36	Limit	ETH	Long	0.0100	--	25.24 USDC	2,524.4	No	N/A	--	Open	59955614640
2026/9/12 22:15:17	Limit	ETH	Long	--	0.0100	--	2,522.2	No	N/A	--	Filled	59954288234
2026/9/12 22:13:05	Limit	ETH	Long	0.0100	--	25.22 USDC	2,522.2	No	N/A	--	Open	59954288234
2026/9/12 22:07:01	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59953980081
2026/9/12 22:01:45	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59953702361
2026/9/12 21:55:00	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59953354341
2026/9/12 21:49:02	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59953054349
2026/9/12 21:24:25	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59951768824
2026/9/12 21:10:48	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59951049674
2026/9/12 21:05:09	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59950740689
2026/9/12 20:59:00	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59950417528
2026/9/12 20:53:34	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59950144591
2026/9/12 20:45:10	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59949718062
2026/9/12 20:37:03	Market	HYPE	Long	0.01	--	Market	Market	No	N/A	--	
Rejected
	59949301969
2026/9/12 20:31:27	Market	HYPE	Long	0.01	--	Market	Market	No	N/A	--	
Rejected
	59949019708
2026/9/12 20:25:49	Market	HYPE	Long	0.01	--	Market	Market	No	N/A	--	
Rejected
	59948737053
2026/9/12 19:41:29	Market	HYPE	Long	0.01	--	Market	Market	No	N/A	--	
Rejected
	59946477914
2026/9/12 18:35:08	Market	ETH	Close Long	--	0.0100	--	Market	Yes	N/A	--	Filled	59943145571
2026/9/12 18:35:08	Market	ETH	Close Long	0.0100	--	Market	Market	Yes	N/A	--	Open	59943145571
2026/9/12 18:32:44	Limit	ETH	Long	--	0.0100	--	2,513.7	No	N/A	--	Filled	59943020335
2026/9/12 18:32:35	Limit	ETH	Long	0.0100	--	25.14 USDC	2,513.7	
CONTROLS:
- a: （无可见文案·/trade） -> /trade
- a: Trade -> /trade
- a: Outcomes -> /outcomes
- a: Portfolio -> /portfolio
- a: Earn -> /earn
- a: Vaults -> /vaults
- a: Staking -> /staking
- a: Referrals -> /referrals
- a: Leaderboard -> /leaderboard
- a: Faucet -> /drip
- a: More
- button[button]: Deposit
- a[外站]: Docs
- a[外站]: Chart
- button[button]: Isolated
- button[button]: 10x
- button[button]: Manual
- input[text]: Size
- input[text]: （无可见文案·输入框）
- button[button]: Place Order
- a: 0.0450% / 0.0150%
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: BTC
- a: BTC
- a: BTC
- a: View All -> /historicalOrders/0x676569831D1002d061465b17368D774913e807F5
- button[button]: Deposit
- button[button]: Perps
Spot
- button[button]: Withdraw
- a[外站]: Online
- a[外站]: Docs
- a[外站]: Support
- a: Terms -> /terms
- a: Privacy Policy -> /privacyPolicy
- button[button]: Confirm
- a[外站]: Mainnet
- a: Explorer -> /explorer
- a: Sub-Accounts -> /subAccounts
- a: API -> /API
- a: Builder Codes -> /builderCodes
- a: Multi-Sig -> /multiSig
- a: Points -> /points
- a: Funding Comparison -> /fundingComparison
- a: Announcements -> /announcements
- a[外站]: Stats
- a[外站]: Docs
- div: Market
- div: Limit
- div: Buy / Long
- div: Sell / Short
- div: Positions
- div: Open Orders
- div: Trade History
- div: Funding History
- div: Order History
- div: Market
- div: Market
- div: Size
- div: Cross

===== 第 11 屏 =====
URL: https://app.hyperliquid-testnet.xyz/trade
TITLE: 25.500 | HYPE | Hyperliquid
TEXT:
Announcements
Manual borrowing now available
Use HYPE and BTC as collateral to borrow USDC and USDT
New listing: USELESS-USDC perps
New listing: PONS-USDC perps
Trade
Outcomes
Portfolio
Earn
Vaults
Staking
Referrals
Leaderboard
Faucet
More
Deposit
0x6765...07F5
HYPE-USD is a hyperp (Hyperliquid-only perp) for the pre-launch HYPE token, which uses recent average mark price for the funding oracle. See Docs for more details. Trading is on low leverage and isolated margin only. Beware of low liquidity, high volatility, and increased liquidation risk.
HYPE-USDC
10x
Mark
11.000
Oracle
35.334
24h Change
+0.000 / +0.00%
24h Volume
$47.08
Open Interest
$101.20
Funding / Countdown
0.0000%   00:07:20
Chart
Funding
Chart by TradingView
Order Book
Trades
 
0.001
HYPE
Price
Size (HYPE)
Total (HYPE)
91.345
0.58
39.92
89.108
0.60
39.34
85.507
0.63
38.74
83.248
0.64
38.11
80.988
0.66
37.47
80.083
0.26
36.81
78.805
0.79
36.55
78.729
0.68
35.76
71.545
0.39
35.08
40.500
24.69
34.69
40.000
10.00
10.00
Spread
29.000
113.725%
11.000
10.42
10.42
10.123
0.60
11.02
Isolated
10x
Manual
Market
Limit
Chase
Buy / Long
Sell / Short
Available to Trade
984.01 USDC
Current Position
0.00 HYPE
Chase Price
39.999
Size
HYPE
%
Reduce Only
Max Chase Distance
Place Order
Liquidation Price
N/A
Order Value
N/A
Margin Required
N/A
Fees
0.0450% / 0.0150%
Balances (1)
Positions
Outcomes
Open Orders
TWAP
Chase
Trade History
Funding History
Order History
Type
Side
Market
Time
	
Type
	
Market
	
Direction
	
Size
	
Filled Size
	
Order Value
	
Price
	
Reduce Only
	
Trigger Conditions
	
TP/SL
	
Status
	
Order ID

2026/9/16 02:45:58	Market	ETH	Close Long	--	0.0400	--	Market	Yes	N/A	--	Filled	60207518734
2026/9/12 23:24:00	Limit	ETH	Long	--	0.0100	--	2,520.4	No	N/A	--	Filled	59957864565
2026/9/12 23:23:24	Limit	ETH	Long	0.0100	--	25.20 USDC	2,520.4	No	N/A	--	Open	59957864565
2026/9/12 23:07:44	Limit	ETH	Long	--	0.0100	--	2,519.9	No	N/A	--	Filled	59957037159
2026/9/12 23:07:44	Limit	ETH	Long	0.0100	--	25.20 USDC	2,519.9	No	N/A	--	Open	59957037159
2026/9/12 22:39:36	Limit	ETH	Long	--	0.0100	--	2,524.4	No	N/A	--	Filled	59955614640
2026/9/12 22:39:36	Limit	ETH	Long	0.0100	--	25.24 USDC	2,524.4	No	N/A	--	Open	59955614640
2026/9/12 22:15:17	Limit	ETH	Long	--	0.0100	--	2,522.2	No	N/A	--	Filled	59954288234
2026/9/12 22:13:05	Limit	ETH	Long	0.0100	--	25.22 USDC	2,522.2	No	N/A	--	Open	59954288234
2026/9/12 22:07:01	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59953980081
2026/9/12 22:01:45	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59953702361
2026/9/12 21:55:00	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59953354341
2026/9/12 21:49:02	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59953054349
2026/9/12 21:24:25	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59951768824
2026/9/12 21:10:48	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59951049674
2026/9/12 21:05:09	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59950740689
2026/9/12 20:59:00	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59950417528
2026/9/12 20:53:34	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59950144591
2026/9/12 20:45:10	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59949718062
2026/9/12 20:37:03	Market	HYPE	Long	0.01	--	Market	Market	No	N/A	--	
Rejected
	59949301969
2026/9/12 20:31:27	Market	HYPE	Long	0.01	--	Market	Market	No	N/A	--	
Rejected
	59949019708
2026/9/12 20:25:49	Market	HYPE	Long	0.01	--	Market	Market	No	N/A	--	
Rejected
	59948737053
2026/9/12 19:41:29	Market	HYPE	Long	0.01	--	Market	Market	No	N/A	--	
Rejected
	59946477914
2026/9/12 18:35:08	Market	ETH	Close Long	--	0.0100	--	Market	Yes	N/A	--	Filled	59943145571
2026/9/12 18:35:08	Market	ETH	Close Long	0.0100	--	Market	Market	Yes	N/A	--	Open	59943145571
2026/9/12 18:32:44	Limit	ETH	Long	--	0.0100	--	2,513.7	No	N/A	--	Filled	59943020335
2026/9/12 18:32:35	Limit	ETH	Long	0.0100	--	25.14 USDC	2,513.7	
CONTROLS:
- a: （无可见文案·/trade） -> /trade
- a: Trade -> /trade
- a: Outcomes -> /outcomes
- a: Portfolio -> /portfolio
- a: Earn -> /earn
- a: Vaults -> /vaults
- a: Staking -> /staking
- a: Referrals -> /referrals
- a: Leaderboard -> /leaderboard
- a: Faucet -> /drip
- a: More
- button[button]: Deposit
- a[外站]: Docs
- a[外站]: Chart
- button[button]: Isolated
- button[button]: 10x
- button[button]: Manual
- input[text]: Size
- input[text]: （无可见文案·输入框）
- button[button]: Place Order
- a: 0.0450% / 0.0150%
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: BTC
- a: BTC
- a: BTC
- a: View All -> /historicalOrders/0x676569831D1002d061465b17368D774913e807F5
- button[button]: Deposit
- button[button]: Perps
Spot
- button[button]: Withdraw
- a[外站]: Online
- a[外站]: Docs
- a[外站]: Support
- a: Terms -> /terms
- a: Privacy Policy -> /privacyPolicy
- a[外站]: Mainnet
- a: Explorer -> /explorer
- a: Sub-Accounts -> /subAccounts
- a: API -> /API
- a: Builder Codes -> /builderCodes
- a: Multi-Sig -> /multiSig
- a: Points -> /points
- a: Funding Comparison -> /fundingComparison
- a: Announcements -> /announcements
- a[外站]: Stats
- a[外站]: Docs
- input[text]: （无可见文案·输入框）
- button[button]: Confirm
- div: Market
- div: Limit
- div: Buy / Long
- div: Sell / Short
- div: Positions
- div: Open Orders
- div: Trade History
- div: Funding History
- div: Order History
- div: Market
- div: Market
- div: Size

===== 第 12 屏 =====
URL: https://app.hyperliquid-testnet.xyz/trade
TITLE: 25.500 | HYPE | Hyperliquid
TEXT:
Announcements
Manual borrowing now available
Use HYPE and BTC as collateral to borrow USDC and USDT
New listing: USELESS-USDC perps
New listing: PONS-USDC perps
Trade
Outcomes
Portfolio
Earn
Vaults
Staking
Referrals
Leaderboard
Faucet
More
Deposit
0x6765...07F5
HYPE-USD is a hyperp (Hyperliquid-only perp) for the pre-launch HYPE token, which uses recent average mark price for the funding oracle. See Docs for more details. Trading is on low leverage and isolated margin only. Beware of low liquidity, high volatility, and increased liquidation risk.
HYPE-USDC
10x
Mark
11.000
Oracle
35.334
24h Change
+0.000 / +0.00%
24h Volume
$47.08
Open Interest
$101.20
Funding / Countdown
0.0000%   00:07:17
Chart
Funding
Chart by TradingView
Order Book
Trades
 
0.001
HYPE
Price
Size (HYPE)
Total (HYPE)
91.345
0.58
39.92
89.108
0.60
39.34
85.507
0.63
38.74
83.248
0.64
38.11
80.988
0.66
37.47
80.083
0.26
36.81
78.805
0.79
36.55
78.729
0.68
35.76
71.545
0.39
35.08
40.500
24.69
34.69
40.000
10.00
10.00
Spread
29.000
113.725%
11.000
10.42
10.42
10.123
0.60
11.02
Isolated
10x
Manual
Market
Limit
Chase
Buy / Long
Sell / Short
Available to Trade
984.01 USDC
Current Position
0.00 HYPE
Chase Price
39.999
Size
HYPE
%
Reduce Only
Max Chase Distance
Place Order
Liquidation Price
N/A
Order Value
N/A
Margin Required
N/A
Fees
0.0450% / 0.0150%
Balances (1)
Positions
Outcomes
Open Orders
TWAP
Chase
Trade History
Funding History
Order History
Type
Side
Market
Time
	
Type
	
Market
	
Direction
	
Size
	
Filled Size
	
Order Value
	
Price
	
Reduce Only
	
Trigger Conditions
	
TP/SL
	
Status
	
Order ID

2026/9/16 02:45:58	Market	ETH	Close Long	--	0.0400	--	Market	Yes	N/A	--	Filled	60207518734
2026/9/12 23:24:00	Limit	ETH	Long	--	0.0100	--	2,520.4	No	N/A	--	Filled	59957864565
2026/9/12 23:23:24	Limit	ETH	Long	0.0100	--	25.20 USDC	2,520.4	No	N/A	--	Open	59957864565
2026/9/12 23:07:44	Limit	ETH	Long	--	0.0100	--	2,519.9	No	N/A	--	Filled	59957037159
2026/9/12 23:07:44	Limit	ETH	Long	0.0100	--	25.20 USDC	2,519.9	No	N/A	--	Open	59957037159
2026/9/12 22:39:36	Limit	ETH	Long	--	0.0100	--	2,524.4	No	N/A	--	Filled	59955614640
2026/9/12 22:39:36	Limit	ETH	Long	0.0100	--	25.24 USDC	2,524.4	No	N/A	--	Open	59955614640
2026/9/12 22:15:17	Limit	ETH	Long	--	0.0100	--	2,522.2	No	N/A	--	Filled	59954288234
2026/9/12 22:13:05	Limit	ETH	Long	0.0100	--	25.22 USDC	2,522.2	No	N/A	--	Open	59954288234
2026/9/12 22:07:01	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59953980081
2026/9/12 22:01:45	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59953702361
2026/9/12 21:55:00	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59953354341
2026/9/12 21:49:02	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59953054349
2026/9/12 21:24:25	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59951768824
2026/9/12 21:10:48	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59951049674
2026/9/12 21:05:09	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59950740689
2026/9/12 20:59:00	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59950417528
2026/9/12 20:53:34	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59950144591
2026/9/12 20:45:10	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59949718062
2026/9/12 20:37:03	Market	HYPE	Long	0.01	--	Market	Market	No	N/A	--	
Rejected
	59949301969
2026/9/12 20:31:27	Market	HYPE	Long	0.01	--	Market	Market	No	N/A	--	
Rejected
	59949019708
2026/9/12 20:25:49	Market	HYPE	Long	0.01	--	Market	Market	No	N/A	--	
Rejected
	59948737053
2026/9/12 19:41:29	Market	HYPE	Long	0.01	--	Market	Market	No	N/A	--	
Rejected
	59946477914
2026/9/12 18:35:08	Market	ETH	Close Long	--	0.0100	--	Market	Yes	N/A	--	Filled	59943145571
2026/9/12 18:35:08	Market	ETH	Close Long	0.0100	--	Market	Market	Yes	N/A	--	Open	59943145571
2026/9/12 18:32:44	Limit	ETH	Long	--	0.0100	--	2,513.7	No	N/A	--	Filled	59943020335
2026/9/12 18:32:35	Limit	ETH	Long	0.0100	--	25.14 USDC	2,513.7	
CONTROLS:
- a: （无可见文案·/trade） -> /trade
- a: Trade -> /trade
- a: Outcomes -> /outcomes
- a: Portfolio -> /portfolio
- a: Earn -> /earn
- a: Vaults -> /vaults
- a: Staking -> /staking
- a: Referrals -> /referrals
- a: Leaderboard -> /leaderboard
- a: Faucet -> /drip
- a: More
- button[button]: Deposit
- a[外站]: Docs
- a[外站]: Chart
- button[button]: Isolated
- button[button]: 10x
- button[button]: Manual
- input[text]: Size
- input[text]: （无可见文案·输入框）
- button[button]: Place Order
- a: 0.0450% / 0.0150%
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: BTC
- a: BTC
- a: BTC
- a: View All -> /historicalOrders/0x676569831D1002d061465b17368D774913e807F5
- button[button]: Deposit
- button[button]: Perps
Spot
- button[button]: Withdraw
- a[外站]: Online
- a[外站]: Docs
- a[外站]: Support
- a: Terms -> /terms
- a: Privacy Policy -> /privacyPolicy
- a[外站]: Mainnet
- a: Explorer -> /explorer
- a: Sub-Accounts -> /subAccounts
- a: API -> /API
- a: Builder Codes -> /builderCodes
- a: Multi-Sig -> /multiSig
- a: Points -> /points
- a: Funding Comparison -> /fundingComparison
- a: Announcements -> /announcements
- a[外站]: Stats
- a[外站]: Docs
- button[button]: Confirm
- div: Market
- div: Limit
- div: Buy / Long
- div: Sell / Short
- div: Positions
- div: Open Orders
- div: Trade History
- div: Funding History
- div: Order History
- div: Market
- div: Market
- div: Size

===== 第 13 屏 =====
URL: https://app.hyperliquid-testnet.xyz/trade
TITLE: 25.500 | HYPE | Hyperliquid
TEXT:
Announcements
Manual borrowing now available
Use HYPE and BTC as collateral to borrow USDC and USDT
New listing: USELESS-USDC perps
New listing: PONS-USDC perps
Trade
Outcomes
Portfolio
Earn
Vaults
Staking
Referrals
Leaderboard
Faucet
More
Deposit
0x6765...07F5
HYPE-USD is a hyperp (Hyperliquid-only perp) for the pre-launch HYPE token, which uses recent average mark price for the funding oracle. See Docs for more details. Trading is on low leverage and isolated margin only. Beware of low liquidity, high volatility, and increased liquidation risk.
HYPE-USDC
10x
Mark
11.000
Oracle
35.334
24h Change
+0.000 / +0.00%
24h Volume
$47.08
Open Interest
$101.20
Funding / Countdown
0.0000%   00:07:15
Chart
Funding
Chart by TradingView
Order Book
Trades
 
0.001
HYPE
Price
Size (HYPE)
Total (HYPE)
91.345
0.58
39.92
89.108
0.60
39.34
85.507
0.63
38.74
83.248
0.64
38.11
80.988
0.66
37.47
80.083
0.26
36.81
78.805
0.79
36.55
78.729
0.68
35.76
71.545
0.39
35.08
40.500
24.69
34.69
40.000
10.00
10.00
Spread
29.000
113.725%
11.000
10.42
10.42
10.123
0.60
11.02
Isolated
10x
Manual
Market
Limit
Chase
Buy / Long
Sell / Short
Available to Trade
984.01 USDC
Current Position
0.00 HYPE
Chase Price
39.999
Size
HYPE
%
Reduce Only
Max Chase Distance
Place Order
Liquidation Price
N/A
Order Value
N/A
Margin Required
N/A
Fees
0.0450% / 0.0150%
Balances (1)
Positions
Outcomes
Open Orders
TWAP
Chase
Trade History
Funding History
Order History
Type
Side
Market
Time
	
Type
	
Market
	
Direction
	
Size
	
Filled Size
	
Order Value
	
Price
	
Reduce Only
	
Trigger Conditions
	
TP/SL
	
Status
	
Order ID

2026/9/16 02:45:58	Market	ETH	Close Long	--	0.0400	--	Market	Yes	N/A	--	Filled	60207518734
2026/9/12 23:24:00	Limit	ETH	Long	--	0.0100	--	2,520.4	No	N/A	--	Filled	59957864565
2026/9/12 23:23:24	Limit	ETH	Long	0.0100	--	25.20 USDC	2,520.4	No	N/A	--	Open	59957864565
2026/9/12 23:07:44	Limit	ETH	Long	--	0.0100	--	2,519.9	No	N/A	--	Filled	59957037159
2026/9/12 23:07:44	Limit	ETH	Long	0.0100	--	25.20 USDC	2,519.9	No	N/A	--	Open	59957037159
2026/9/12 22:39:36	Limit	ETH	Long	--	0.0100	--	2,524.4	No	N/A	--	Filled	59955614640
2026/9/12 22:39:36	Limit	ETH	Long	0.0100	--	25.24 USDC	2,524.4	No	N/A	--	Open	59955614640
2026/9/12 22:15:17	Limit	ETH	Long	--	0.0100	--	2,522.2	No	N/A	--	Filled	59954288234
2026/9/12 22:13:05	Limit	ETH	Long	0.0100	--	25.22 USDC	2,522.2	No	N/A	--	Open	59954288234
2026/9/12 22:07:01	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59953980081
2026/9/12 22:01:45	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59953702361
2026/9/12 21:55:00	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59953354341
2026/9/12 21:49:02	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59953054349
2026/9/12 21:24:25	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59951768824
2026/9/12 21:10:48	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59951049674
2026/9/12 21:05:09	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59950740689
2026/9/12 20:59:00	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59950417528
2026/9/12 20:53:34	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59950144591
2026/9/12 20:45:10	Limit	HYPE	Long	0.01	--	0.38 USDC	37.500	No	N/A	--	
Rejected
	59949718062
2026/9/12 20:37:03	Market	HYPE	Long	0.01	--	Market	Market	No	N/A	--	
Rejected
	59949301969
2026/9/12 20:31:27	Market	HYPE	Long	0.01	--	Market	Market	No	N/A	--	
Rejected
	59949019708
2026/9/12 20:25:49	Market	HYPE	Long	0.01	--	Market	Market	No	N/A	--	
Rejected
	59948737053
2026/9/12 19:41:29	Market	HYPE	Long	0.01	--	Market	Market	No	N/A	--	
Rejected
	59946477914
2026/9/12 18:35:08	Market	ETH	Close Long	--	0.0100	--	Market	Yes	N/A	--	Filled	59943145571
2026/9/12 18:35:08	Market	ETH	Close Long	0.0100	--	Market	Market	Yes	N/A	--	Open	59943145571
2026/9/12 18:32:44	Limit	ETH	Long	--	0.0100	--	2,513.7	No	N/A	--	Filled	59943020335
2026/9/12 18:32:35	Limit	ETH	Long	0.0100	--	25.14 USDC	2,513.7	
CONTROLS:
- a: （无可见文案·/trade） -> /trade
- a: Trade -> /trade
- a: Outcomes -> /outcomes
- a: Portfolio -> /portfolio
- a: Earn -> /earn
- a: Vaults -> /vaults
- a: Staking -> /staking
- a: Referrals -> /referrals
- a: Leaderboard -> /leaderboard
- a: Faucet -> /drip
- a: More
- button[button]: Deposit
- a[外站]: Docs
- a[外站]: Chart
- button[button]: Isolated
- button[button]: 10x
- button[button]: Manual
- input[text]: Size
- input[text]: （无可见文案·输入框）
- button[button]: Place Order
- a: 0.0450% / 0.0150%
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: HYPE
- a: ETH
- a: ETH
- a: ETH
- a: ETH
- a: BTC
- a: BTC
- a: BTC
- a: View All -> /historicalOrders/0x676569831D1002d061465b17368D774913e807F5
- button[button]: Deposit
- button[button]: Perps
Spot
- button[button]: Withdraw
- a[外站]: Online
- a[外站]: Docs
- a[外站]: Support
- a: Terms -> /terms
- a: Privacy Policy -> /privacyPolicy
- a[外站]: Mainnet
- a: Explorer -> /explorer
- a: Sub-Accounts -> /subAccounts
- a: API -> /API
- a: Builder Codes -> /builderCodes
- a: Multi-Sig -> /multiSig
- a: Points -> /points
- a: Funding Comparison -> /fundingComparison
- a: Announcements -> /announcements
- a[外站]: Stats
- a[外站]: Docs
- button[button]: Confirm
- button[button]: Scroll right
- div: Market
- div: Limit
- div: Buy / Long
- div: Sell / Short
- div: Positions
- div: Open Orders
- div: Trade History
- div: Funding History
- div: Order History
- div: Market
- div: Market
- div: Size



===== 这次探索停在第 13 屏 =====