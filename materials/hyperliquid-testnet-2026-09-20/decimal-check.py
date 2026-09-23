"""Independent arithmetic fixtures only. Does not execute or validate the live trading site."""
from decimal import Decimal as D, ROUND_CEILING
import json
from pathlib import Path

def close_gross(q, entry, exit, amount):
    return (D(1) if D(q)>0 else D(-1))*D(amount)*(D(exit)-D(entry))

def minimum_size(min_notional, price, step):
    return (D(min_notional)/D(price)/D(step)).to_integral_value(rounding=ROUND_CEILING)*D(step)

results=[]
def check(name, actual, expected):
    assert actual==D(expected), (name,actual,expected)
    results.append({'name':name,'actual':str(actual),'expected':expected,'passed':True})

check('minimum size at 80000 with step .00001',minimum_size('10','80000','.00001'),'.00013')
check('below minimum notional',D('.00012')*D('80000'),'9.6')
check('first valid notional',D('.00013')*D('80000'),'10.4')
check('initial margin baseline',D('.002')*D('80000')/D('5'),'32')
check('same direction weighted entry',(D('.001')*D('80000')+D('.002')*D('83000'))/D('.003'),'82000')
check('long unrealized',D('.002')*(D('81000')-D('80000')),'2')
check('short unrealized',D('-.002')*(D('79000')-D('80000')),'2')
check('long roundtrip net after two .045 percent fees',close_gross('.002','80000','82000','.002')-D('.002')*(D('80000')+D('82000'))*D('.00045'),'3.8542')
check('short roundtrip net after two .045 percent fees',close_gross('-.002','80000','78000','.002')-D('.002')*(D('80000')+D('78000'))*D('.00045'),'3.8578')
check('partial close gross',close_gross('.003','82000','83000','.001'),'1')
check('reversal closes old long only',close_gross('.003','82000','83000','.003'),'3')
check('reversal residual short',D('.003')-D('.005'),'-.002')
check('positive funding long cashflow',-D('.002')*D('80000')*D('.0001'),'-.016')
check('flat closing balance includes fees funding once',D('1000')+D('4')-D('.1458')-D('.016'),'1003.8382')
check('new borrowing produces zero equity',D('100')-D('100'),'0')
Path(__file__).with_name('arithmetic-checks.json').write_text(json.dumps({'scope':'offline arithmetic fixtures; not live website results','checks':results},indent=2)+'\n')
print(json.dumps({'offlineArithmeticChecks':len(results),'passed':True,'liveTradesExecuted':False}))
