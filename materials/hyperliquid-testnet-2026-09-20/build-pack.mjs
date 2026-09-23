import {writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const base=new URL('./',import.meta.url), prefix='materials/hyperliquid-testnet-2026-09-20/';
const docs='https://hyperliquid.gitbook.io/hyperliquid-docs/';
const sources=[
 ['scope','product-spec',prefix+'scope.md'],['ui','observation',prefix+'site-observations.md'],['domain','domain-reference',prefix+'domain-reference.md'],
 ['accounts','official-doc',docs+'trading/account-abstraction-modes'],['margin','official-doc',docs+'trading/margining'],['portfolio','official-doc',docs+'trading/portfolio-margin'],['contracts','official-doc',docs+'trading/contract-specifications'],['pnl','official-doc',docs+'trading/entry-price-and-pnl'],['orders','official-doc',docs+'trading/order-types'],['precision','official-doc',docs+'for-developers/api/tick-and-lot-size'],['errors','official-doc',docs+'for-developers/api/error-responses'],['fees','official-doc',docs+'trading/fees'],['funding','official-doc',docs+'trading/funding'],['tiers','official-doc',docs+'trading/margin-tiers'],['login-fixture','fixture-contract','fixtures/hyperliquid-testnet/cases.json']
].map(([id,kind,locator])=>({id,kind,locator,...(kind==='observation'?{observedAt:'2026-09-20',note:'本次未登录SPA观察；不证明成交或金额正确'}:{fetchedAt:'2026-09-20'}),...(kind==='official-doc'?{note:'官方通用文档；测试网/账户适用性需首跑确认'}:{})}));
const structure=[
 ['account','身份与账户资产',[['identity','钱包连接与授权'],['balances','资产与可用余额'],['modes','账户模式与抵押品']]],
 ['market','市场选择与合约参数',[['instrument','币对与结算单位'],['prices','行情价格与订单簿'],['precision','数量价格精度']]],
 ['risk','杠杆与保证金',[['margin','全仓逐仓'],['leverage','杠杆及档位'],['portfolio','跨资产风险']]],
 ['order','下单与预估',[['direction','方向与数量输入'],['preview','名义价值与成本预估'],['validation','下单边界与拒绝']]],
 ['execution','委托与成交',[['types','订单类型与有效期'],['fills','逐笔成交与撤改单'],['resilience','竞态与重连']]],
 ['position','持仓与退出',[['manage','开仓加仓与反手'],['protection','止盈止损与清算'],['exit','部分及全部平仓']]],
 ['settlement','资金结算与审计',[['pnl','盈亏与费用'],['cashflow','资金费与利息'],['reconciliation','逐币种及总权益核对']]]
];
const modules=structure.flatMap(([id,name,children])=>[{id,name,parentId:null},...children.map(([child,n])=>({id:id+'.'+child,name:n,parentId:id}))]);
const featureDefs=[
 ['wallet','account.identity','注入钱包与正确身份','ui'],['authorization','account.identity','交易授权与拒签','login-fixture'],['assets','account.balances','逐资产余额及可用额度','ui'],['transfers','account.balances','测试资金与内部划转','scope'],['account-mode','account.modes','Unified/Manual/Portfolio Margin','ui'],
 ['symbol','market.instrument','币对、DEX和结算币识别','ui'],['quotes','market.prices','Mark/Oracle/订单簿','ui'],['size-step','market.precision','数量步长','precision'],['price-step','market.precision','价格合法性','precision'],
 ['margin-mode','risk.margin','全仓逐仓与隔离','margin'],['leverage','risk.leverage','杠杆和风险档位','margin'],['multi-position','risk.portfolio','同抵押币多市场仓位','accounts'],['multi-collateral','risk.portfolio','多抵押品借贷风险','portfolio'],
 ['side','order.direction','Buy Long / Sell Short','ui'],['size-input','order.direction','数量/金额/百分比输入','ui'],['estimate','order.preview','预估数量、名义价值和保证金','ui'],['slippage','order.preview','费用与滑点预估','ui'],['minimum','order.validation','最小名义金额边界','errors'],['reject','order.validation','保证金/精度/流动性拒绝','errors'],
 ['order-types','execution.types','Market/Limit/TIF','orders'],['advanced','execution.types','高级订单','orders'],['fills','execution.fills','挂单、成交、部分成交和撤单','orders'],['idempotence','execution.resilience','重复点击、断线、重连及竞态','scope'],
 ['opening','position.manage','开仓和同向加仓','pnl'],['reversal','position.manage','反向减仓与反手','scope'],['protection','position.protection','TP/SL和Reduce Only','orders'],['liquidation','position.protection','清算风险','margin'],['closing','position.exit','部分平仓、全平与尘埃','scope'],
 ['pnl','settlement.pnl','入场均价、U-PNL、Closed PNL和ROE','pnl'],['fees','settlement.pnl','逐笔手续费与返佣','fees'],['funding','settlement.cashflow','资金费结算','funding'],['interest','settlement.cashflow','借款利息与资产收益','portfolio'],['reconcile','settlement.reconciliation','账户权益与逐币种资金守恒','scope'],['precision-oracle','settlement.reconciliation','十进制、精度和时间一致性','scope']
];
const features=featureDefs.map(([id,moduleId,name,src])=>({id,moduleId,name,description:'作为测试设计覆盖项；适用不等于已执行验证。',applicability:['advanced','multi-collateral','interest','reversal'].includes(id)?'unresolved':'applicable',applicabilitySourceRefs:[src]}));
const rules=[];
function rule(id,feature,claim,statement,src,verification,extra={}) {rules.push({id,featureIds:feature.split(','),claimType:claim,statement,sourceRefs:src.split(','),appliesWhen:'仅本测试网目标；记录实际账户/市场/模式并核对适用性',verification,...extra});}
const question=q=>({kind:'open-question',question:q});
const ui=t=>({kind:'ui-state',expect:{textPresent:[t]}});
// Verification is deliberately honest: numeric obligations are not marked proved by text presence.
rule('R01','wallet','normative','测试登录必须采用注入钱包，并核对连接地址、网络和所选账户。','scope',question('注入后的钱包地址是否匹配测试身份？连接入口与交易授权需首跑验证。'),{riskFloor:'P0'});
rule('R02','authorization','hypothesis','既有夹具使用Enable Trading后Establish Connection；本次新环境仍需确认。','login-fixture',question('本次注入环境是否出现同样授权流程，拒签后是否没有委托？'));
rule('R03','assets','observed','资产表区分总余额、可用余额和USDC估值。','ui',ui('Total Balance|Available Balance|USDC Value'));
rule('R04','account-mode,multi-position','normative','Unified按结算/抵押币共享相关全仓余额，Manual按DEX分账。','accounts',question('相同抵押币与不同抵押币场景下，余额归属及风险占用是否正确？'));
rule('R05','multi-collateral,interest','normative','Portfolio Margin允许合格抵押品、借款和利息，需满足当期资格与限额。','portfolio',question('当前测试账户是否满足准入？抵押折算、借款上限和利息是否可观察？'));
rule('R06','symbol','normative','所有金额核对必须绑定钱包、DEX、币对及单位，切币对不得串用参数。','scope',question('切换BTC/ETH等市场后精度、杠杆、输入单位和订单归属是否同步？'),{riskFloor:'P0'});
rule('R07','quotes','observed','交易页分别显示Mark、Oracle、资金费与倒计时。','ui',ui('Mark|Oracle|Funding / Countdown'));
rule('R08','quotes','normative','动态行情使用同一快照参与关系断言，不写成固定值。','scope',question('数值输入是否有时间戳及同步窗口？过期报价是否被标明？'));
rule('R09','size-step','normative','数量合法小数位由资产szDecimals确定。','precision',question('当前币对步长及超精度UI处理方式是什么？输入、预估和最终成交单位是否一致？'));
rule('R10','price-step','normative','永续价格兼顾5位有效数字与6-szDecimals小数位，整数价格按官方例外。','precision',question('边界价格被正确接受/拒绝，且没有默改成另一价格吗？'));
rule('R11','margin-mode','normative','Cross共享相关风险池；Isolated限制该仓位抵押风险。','margin',question('模式实际切换后字段、风险池及其他仓位保证金是否符合隔离关系？'));
rule('R12','leverage','normative','用户杠杆在1到该资产有效上限的整数范围内，档位变化需重新检查。','margin,tiers',question('下限、上限、越界和跨名义档位是否正确处理？'));
rule('R13','estimate,leverage','normative','初始保证金基式为数量×标记价/杠杆；下单预估需核实净增风险及费用口径。','margin',question('独立计算基式并逐项解释预估差额；现有仓位与挂单如何影响可用额度？'));
rule('R14','side','observed','下单面板区分Buy / Long和Sell / Short。','ui',ui('Buy / Long|Sell / Short'));
rule('R15','size-input,estimate','hypothesis','金额、保证金预算与比例输入的计算价、费用预留和分母需分别确认。','domain',question('切输入单位后数量是否一致？100%使用哪个余额，是否预留费用？'));
rule('R16','minimum','normative','普通永续订单存在10美元最小名义金额错误条件，不是固定币数量。','errors',question('在当前价格和数量步长下核对低于/等于/高于门槛；减仓及高级订单例外分开验证。'),{constants:{ordinaryMinNotional:'10'},unit:'USD notional; base quantity derived'});
rule('R17','minimum,precision-oracle','normative','边界样例必须在量化数量后重算名义金额，不用未量化值判断合规。','scope',question('用decimal-check.py中的ceil_to_step模型构造边界，并用实际价格/步长实例化。'),{riskFloor:'P0'});
rule('R18','reject','normative','保证金不足、Reduce Only增仓、价格异常与无流动性是不同拒绝原因。','errors',question('每个失败分别核对UI反馈及没有意外成交/持仓/资金变动。'));
rule('R19','estimate,slippage','normative','估计名义值和费用不能冒充逐笔成交值；按实际成交量价重算。','scope',question('滑点、部分成交与maker/taker变化能否解释估计到实际的差异？'),{riskFloor:'P0'});
rule('R20','order-types','normative','Limit不得劣于限价成交；ALO不立即吃单；IOC未立即成交部分取消。','orders',question('用订单/成交历史核对价格、数量、状态，不能仅看提交提示。'));
rule('R21','advanced','normative','高级订单有独立参数与约束，普通订单最小金额不能直接复用。','orders',question('当前页面支持哪些高级类型？分别查TWAP总额/时长等边界。'));
rule('R22','fills','normative','同一订单的已成交量加未成交/取消残量必须解释原始数量。','scope',question('逐笔数量与Original Size、剩余数量、撤单状态是否守恒？'),{riskFloor:'P0'});
rule('R23','fills','normative','撤单只取消未成交部分，已成交仓位不能随撤单消失。','scope',question('部分成交后撤单与撤单成交竞态能否重建唯一结果？'),{riskFloor:'P0'});
rule('R24','idempotence','normative','刷新、重连或重复提交反馈不能凭空增加/丢失交易。','scope',question('以订单标识及交易历史核对最终状态，超时不能直接算失败后重复交易。'),{riskFloor:'P0'});
rule('R25','opening,pnl','normative','同向加仓按成交量加权更新入场均价，部分平仓保留剩余入场价。','pnl',question('用各笔Q和P独立计算VWAP与加仓后的E，再核对仓位表。'));
rule('R26','pnl','normative','未实现盈亏按带符号仓位乘以标记价和入场价之差。','pnl',question('多空、盈亏正负和零点采用同步标记价计算，UI显示区间是否包含预期？'));
rule('R27','reversal','hypothesis','同市场反向成交可能先减仓，超出旧仓才反手；不得预设双向独立持仓。','domain',question('确认本账户净持仓行为；反手拆分平旧仓与开新仓的数量、费用与新入场价。'));
rule('R28','protection','normative','Reduce Only只能减少已有仓位，不能产生反方向新仓。','orders',question('无仓、超额减仓、部分成交和仓位已被其他订单平掉时是否仍不增仓？'));
rule('R29','protection','normative','TP/SL的触发与后续成交是不同事件；只挂出条件单不等于完成退出。','orders',question('触发价、方向、reduce-only、关联数量和最终成交分别核对。'));
rule('R30','closing','normative','部分平仓只减少指定市场指定数量；全平需核对残量及其他市场不被误改。','scope',question('平仓后同市场残量为零/预期剩余量，其他市场数量和入场价是否保持？'),{riskFloor:'P0'});
rule('R31','pnl','hypothesis','平台Closed PNL与独立毛实现盈亏可能有不同计价、费用及时间窗口径。','pnl,domain',question('建立UI字段字典后再核对，禁止直接把独立价差公式套到Closed PNL。'));
rule('R32','pnl','hypothesis','ROE分母依赖平台展示口径，不能直接以价格涨跌乘杠杆代替。','domain',question('确认分母是否含调整后的保证金、费用或累计项。'));
rule('R33','fees','normative','费用依赖费档及成交角色，可能包含折扣、返佣和部署方费用。','fees',question('逐笔确认费用币种及实际费率，按量价费率重算并防止重复扣费。'));
rule('R34','funding','normative','资金费按小时结算，结算名义值使用Oracle而非Mark。','funding',question('按结算仓位、该小时费率和Oracle算有符号现金流，并核对资金费历史。'));
rule('R35','interest,reconcile','normative','新增借款同时带来资产和负债，不能被记成账户收益。','scope',question('借入、偿还本金、利息与资产估值是否分别入账？'),{riskFloor:'P0'});
rule('R36','liquidation','normative','维持保证金按档位计算，清算风险须匹配全仓/逐仓及账户模式。','tiers,margin',question('实际风险档位、扣减项、保证金池和预估清算价假设是否一致？'));
rule('R37','multi-collateral','normative','Portfolio Margin风险须包含抵押折算、负债和借贷限制，不能按普通单资产余额判断。','portfolio',question('核对当期资格/上限后再测试，未满足条件时记录不可执行而非通过。'));
rule('R38','reconcile,transfers','normative','同账户边界的内部划转净额为零；分配保证金和挂单冻结不等于权益损失。','scope',question('逐币种流水与子账/总账边界能否解释所有可用余额与权益变化？'),{riskFloor:'P0'});
rule('R39','reconcile','normative','权益变化必须由净外部流入、实现盈亏、浮盈亏变化、费用、资金费、利息及已解释项组成。','scope',question('按domain-reference.md的资金守恒模型独立核对，任何差额单列不可用其他项抹平。'),{riskFloor:'P0'});
rule('R40','precision-oracle','normative','金融计算使用十进制、明确单位和误差传播；数据不可观测时不宣称准确通过。','scope',question('展示精度与时间不同步是否导致不可判？是否保存输入、预期、实际及误差区间？'),{riskFloor:'P0'});
rule('R41','assets,closing','normative','没有其他仓位/现金流的闭环交易结束后，余额差不能重复包含释放保证金。','scope',question('最终余额差是否恰由净交易损益与期间费用、资金费构成？'),{riskFloor:'P0'});
rule('R42','multi-position','normative','多个市场的盈亏和风险分别核对，再按正确抵押池汇总。','scope',question('操作一个市场不会改错其他市场数量/入场价；不同抵押币不能随意合并。'),{riskFloor:'P0'});
const lifecycle=[
 ['identity','确认钱包身份与交易授权',['wallet','authorization']],['assets','核对资产和账户模式',['assets','transfers','account-mode']],['market','选择市场并取得参数',['symbol','quotes','size-step','price-step']],['risk','确定保证金与风险预算',['margin-mode','leverage','multi-position','multi-collateral']],['preview','输入方向与数量并核对预估',['side','size-input','estimate','minimum','slippage','reject']],['submit','提交并识别订单状态',['order-types','fills','idempotence']],['holding','核对持仓并管理风险',['opening','pnl','protection','liquidation']],['accrual','核对持仓期间资金费与利息',['funding','interest']],['exit','部分退出或全平并处理反手',['closing','reversal','fills']],['audit','汇总费用与资金对账并重连复核',['fees','reconcile','precision-oracle','idempotence']]
].map(([id,name,featureIds],i)=>({id,name,order:i+1,featureIds,sourceRefs:['scope']}));
const targets=[];
function target(id,featureId,label,action='activate',requires=[],sideEffect='ui-only',expect=[]){targets.push({id,featureId,ruleRefs:rules.filter(r=>r.featureIds.includes(featureId)).map(r=>r.id),match:{label:[label],route:'^/trade(?:/|$)'},action,requires,sideEffect,...(expect.length?{expectOnScreen:expect}:{})});}
target('T-account-mode','account-mode','^Unified$','activate',[],'ui-only',['Account Type']);
target('T-market','order-types','^Market$');target('T-limit','order-types','^Limit$','activate',[],'ui-only',['Price']);
target('T-long','side','^Buy / Long$');target('T-short','side','^Sell / Short$');
target('T-balances','assets','^Balances$','activate',[],'ui-only',['Total Balance']);
target('T-positions','opening','^Positions$','activate',[],'ui-only',['Entry Price']);
target('T-orders','fills','^Open Orders$','activate',[],'ui-only',['Original Size']);
target('T-trades','fills','^Trade History$');target('T-funding','funding','^Funding History$');target('T-order-history','idempotence','^Order History$');
target('T-margin','margin-mode','^Cross$','activate',['wallet-session']);
target('T-pro','advanced','^Pro$');target('T-tp-sl','protection','^Take Profit / Stop Loss$');
target('T-size','size-input','^Size$','observe-only',[],'none');target('T-portfolio-value','reconcile','^Portfolio Value$','observe-only',[],'none');
const pack={schemaVersion:'product-rule-pack.v1',id:'hyperliquid-testnet-trade-lifecycle',version:'2026-09-20.1',domain:'crypto-linear-perpetuals',product:'Hyperliquid Testnet Trading SPA',network:'Hyperliquid testnet; wallet transport uses local configured test network',accountMode:'Observed logged-out default Unified; test Cross/Isolated separately; Manual and Portfolio Margin are explicit conditional branches',appliesTo:{urlPatterns:['^https://app\\.hyperliquid-testnet\\.xyz/trade(?:/[^?#]*)?(?:[?#].*)?$'],note:'测试网合约交易主链；非主网。多抵押品与高级类型必须先核对当前账户适用性。'},sources,modules,features,rules,targets,roles:[{id:'trader',name:'合约交易用户',goal:'在明确风险与资金成本下完成开仓、持仓管理及退出',sourceRefs:['scope']},{id:'auditor',name:'测试与资金复核人员',goal:'逐笔解释订单、仓位和账户权益变化',sourceRefs:['scope']}],lifecycle,externalCapabilities:['wallet-session','funded-test-account','clean-position-fixture','multi-market-fixture','portfolio-margin-eligible'],forbidLabels:['^Place Order$','^Confirm Order$','^Close All$','^Market Close$','^Cancel All$','^Deposit$','^Withdraw$','^Transfer$','^Borrow$','^Repay$'],gateLabels:['^Connect$','^Enable Trading$','^Establish Connection$','Terms of Use'],actionVocabulary:['开仓','加仓','减仓','平仓','反手','下单','撤单','改单','设置杠杆','划转','借款','还款','结算'],sideEffectLabels:['^Place Order$','^Confirm Order$','^Close All$','^Market Close$','^Cancel All$','^Deposit$','^Withdraw$','^Transfer$','^Borrow$','^Repay$'],volatileReadings:['Mark','Oracle','Funding','Countdown','Open Interest','24h Volume','Portfolio Value','Unrealized PNL','Liq. Price','Available to Trade']};
writeFileSync(new URL('rule-pack.json',base),JSON.stringify(pack,null,2)+'\n');
console.log(JSON.stringify({file:fileURLToPath(new URL('rule-pack.json',base)),modules:modules.length,topLevel:structure.length,features:features.length,rules:rules.length,targets:targets.length,lifecycle:lifecycle.length}));
