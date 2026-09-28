import {describe,it,expect} from 'vitest';
import {DecimalEquationSchema,evaluateDecimalEquation} from '../src/exec/decimalEquation.js';
const oracle=DecimalEquationSchema.parse({kind:'decimal-equation',scope:{start:'ORDER',end:'END'},inputs:[{id:'q',label:'Quantity',unit:'ETH',decimals:3,rounding:'exact'},{id:'p',label:'Price',unit:'USD/ETH',decimals:2,rounding:'exact'},{id:'total',label:'Total',unit:'USD',decimals:2,rounding:'exact'}],actual:'total',formula:['q','p','*'],maxAgeMs:1000});
const text=(total='0.02')=>`ORDER\nQuantity: 0.1 ETH\nPrice: 0.2 USD/ETH\nTotal: ${total} USD\nEND`;
const check=(body=text(),o=oracle,capturedAt=1000)=>evaluateDecimalEquation(o,{text:body,capturedAt},1001).status;
describe('independent decimal equation',()=>{
 it('calculates 0.1 * 0.2 exactly',()=>expect(check()).toBe('pass'));
 it('fails incorrect amount',()=>expect(check(text('0.03'))).toBe('fail'));
 it('rejects stale snapshot',()=>expect(check(text(),oracle,0)).toBe('unobservable'));
 it('rejects future snapshot',()=>expect(check(text(),oracle,2000)).toBe('unobservable'));
 it('rejects ambiguous scope',()=>expect(check(text()+'ORDER')).toBe('unobservable'));
 it('rejects duplicate labels',()=>expect(check(text().replace('END','Quantity: 0.1 ETH\nEND'))).toBe('unobservable'));
 it('rejects incorrect unit',()=>expect(check(text().replace('0.1 ETH','0.1 BTC'))).toBe('unobservable'));
 it('rejects self-referential expectations',()=>expect(check(text(),{...oracle,formula:['total']})).toBe('unobservable'));
 it('rejects zero denominator',()=>expect(check(text().replace('0.2 USD/ETH','0 USD/ETH'),{...oracle,formula:['q','p','/']})).toBe('unobservable'));
 it('preserves large decimal values',()=>expect(check(text('9007199254740993.01').replace('0.1 ETH','1 ETH').replace('0.2 USD/ETH','9007199254740993.01 USD/ETH'))).toBe('pass'));
 it('accounts for known rounding precision',()=>expect(check(text().replace('0.1 ETH','0.101 ETH'),{...oracle,inputs:oracle.inputs.map(i=>({...i,rounding:'nearest' as const}))})).toBe('pass'));
 it('reads amounts whose unit is a prefix, with sign and thousands separators',()=>{
  const dollars=DecimalEquationSchema.parse({kind:'decimal-equation',scope:{start:'Perps Overview',end:'Cross Margin Ratio'},inputs:[{id:'bal',label:'Balance',unit:'$',decimals:2,rounding:'exact'},{id:'upnl',label:'Unrealized PNL',unit:'$',decimals:2,rounding:'exact'},{id:'equity',label:'Equity',unit:'$',decimals:2,rounding:'exact'}],actual:'equity',formula:['bal','upnl','+'],maxAgeMs:1000});
  const body=(upnl:string)=>`Perps Overview\nBalance\n$1,984.02\nUnrealized PNL\n${upnl}\nEquity\n$1,980.92\nCross Margin Ratio`;
  expect(check(body('-$3.10'),dollars)).toBe('pass');
  expect(check(body('$-3.10'),dollars)).toBe('pass');
  expect(check(body('$3.10'),dollars)).toBe('fail');
  expect(check(body('-$-3.10'),dollars)).toBe('unobservable');
 });
 it('compares against constants and supports inequalities, unknown when the display precision cannot tell',()=>{
  const one=(value:string,compare?:'eq'|'gt'|'gte'|'lt'|'lte',formula=['0'],rounding:'exact'|'nearest'='exact')=>check(`ORDER\nPNL\n${value}\nEND`,DecimalEquationSchema.parse({kind:'decimal-equation',scope:{start:'ORDER',end:'END'},inputs:[{id:'pnl',label:'PNL',unit:'$',decimals:2,rounding}],actual:'pnl',formula,maxAgeMs:1000,...(compare?{compare}:{})}));
  expect(one('$0.00')).toBe('pass');
  expect(one('$1.20')).toBe('fail');
  expect(one('$984.01','gt')).toBe('pass');
  expect(one('$0.00','gt')).toBe('fail');
  expect(one('-$3.10','lt')).toBe('pass');
  expect(one('$0.00','gte')).toBe('pass');
  expect(one('$0.00','gt',['0'],'nearest')).toBe('unobservable');
  expect(one('$10.00','eq',['2.5','4','*'])).toBe('pass');
 });
});
