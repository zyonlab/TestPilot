import {z} from 'zod';
import {decimal} from './decimal.js';
/** Same-snapshot interval arithmetic. Formulas are bounded RPN tokens, never evaluated as code. */
export const DecimalEquationSchema=z.object({
 kind:z.literal('decimal-equation'),
 scope:z.object({start:z.string().min(1),end:z.string().min(1)}).strict(),
 inputs:z.array(z.object({id:z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/),label:z.string().min(1),unit:z.string().min(1),decimals:z.number().int().min(0).max(30),rounding:z.enum(['exact','nearest','truncate'])}).strict()).min(2).max(40),
 actual:z.string().min(1), formula:z.array(z.string().min(1)).min(1).max(100),
 maxAgeMs:z.number().int().positive().max(60000),
}).strict();
type Rat={n:bigint;d:bigint};type Interval=[Rat,Rat];
const rat=(n:bigint,d=1n):Rat=>d<0n?{n:-n,d:-d}:{n,d};
const add=(a:Rat,b:Rat)=>rat(a.n*b.d+b.n*a.d,a.d*b.d);
const neg=(a:Rat)=>rat(-a.n,a.d);
const mul=(a:Rat,b:Rat)=>rat(a.n*b.n,a.d*b.d);
const cmp=(a:Rat,b:Rat)=>{const n=a.n*b.d-b.n*a.d;return n<0n?-1:n>0n?1:0;};
const escape=(s:string)=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
function range(text:string,input:z.infer<typeof DecimalEquationSchema>['inputs'][number]):Interval|undefined {
 const re=new RegExp(`^\\s*${escape(input.label)}\\s*[:：]?\\s*([+-]?\\d+(?:\\.\\d+)?)\\s*${escape(input.unit)}\\s*$`,'gm');
 const matches=[...text.matchAll(re)];if(matches.length!==1)return;
 const raw=matches[0]![1]!;const value=decimal(raw);if(!value||value.scale>input.decimals)return;
 const v=rat(value.coefficient,10n**BigInt(value.scale));const step=rat(1n,10n**BigInt(input.decimals));
 if(input.rounding==='exact')return[v,v];
 if(input.rounding==='nearest'){const half=rat(step.n,step.d*2n);return[add(v,neg(half)),add(v,half)];}
 // Truncation towards zero. Endpoints are conservative inclusive bounds.
 return value.coefficient<0n?[add(v,neg(step)),v]:value.coefficient>0n?[v,add(v,step)]:[neg(step),step];
}
export function evaluateDecimalEquation(oracle:z.infer<typeof DecimalEquationSchema>,snapshot:{text:string;capturedAt?:number},now=Date.now()):{status:'pass'|'fail'|'unobservable';detail:string} {
 const unknown=(detail:string)=>({status:'unobservable' as const,detail});
 if(!snapshot.capturedAt||now<snapshot.capturedAt||now-snapshot.capturedAt>oracle.maxAgeMs)return unknown('缺少同时间窗快照或快照已过期');
 const starts=snapshot.text.split(oracle.scope.start);if(starts.length!==2)return unknown('账户/市场/订单范围不唯一');
 const ends=starts[1]!.split(oracle.scope.end);if(ends.length!==2)return unknown('无法确定取数范围的结束边界');
 const values=new Map<string,Interval>();
 for(const input of oracle.inputs){if(values.has(input.id))return unknown('重复输入标识');const r=range(ends[0]!,input);if(!r)return unknown(`无法唯一读取数值或币种/精度不匹配：${input.id}`);values.set(input.id,r);}
 const stack:Interval[]=[];
 for(const token of oracle.formula){
  if(values.has(token)){stack.push(values.get(token)!);continue;}
  if(!['+','-','*','/'].includes(token)||stack.length<2)return unknown('公式缺输入或运算符无效');
  const b=stack.pop()!,a=stack.pop()!;
  if(token==='+')stack.push([add(a[0],b[0]),add(a[1],b[1])]);
  else if(token==='-')stack.push([add(a[0],neg(b[1])),add(a[1],neg(b[0]))]);
  else {
   if(token==='/'&&cmp(b[0],rat(0n))<=0&&cmp(b[1],rat(0n))>=0)return unknown('分母区间包含零');
   const products=a.flatMap(x=>b.map(y=>token==='*'?mul(x,y):mul(x,rat(y.d,y.n)))).sort(cmp);
   stack.push([products[0]!,products[3]!]);
  }
 }
 const actual=values.get(oracle.actual);if(!actual||stack.length!==1)return unknown('结果输入或公式不完整');
 if(oracle.formula.includes(oracle.actual))return unknown('不能用被测结果自身重建预期值');
 const expected=stack[0]!;const intersects=cmp(actual[1],expected[0])>=0&&cmp(expected[1],actual[0])>=0;
 return {status:intersects?'pass':'fail',detail:intersects?'同快照十进制计算区间与显示区间相交（仅证明显示精度内一致）':'同快照十进制计算区间与显示区间不相交'};
}
