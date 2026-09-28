import {z} from 'zod';
import {decimal} from './decimal.js';
const SYMBOL=/^[A-Za-z][A-Za-z0-9_]*$/;
/**
 * 表格里的一格（docs/v3/15 阶段 4.2）：按「行首那一列」的值定位行，再读 `label` 那一列。
 * 持仓、挂单这类表格的读数离表头很远，`label: 值` 那种读法读不到；同一行首出现两次（两笔 BTC 挂单）就是没量到。
 */
export const TableRowSchema=z.object({
 /** 行首那一格以它开头（例：`BTC`，匹配「BTC 20x」）。 */
 key:z.string().min(1),
 /** 行首那一格所在列的表头（例：`Market` / `Coin`）。 */
 keyColumn:z.string().min(1),
}).strict();
const ReadingInputSchema=z.object({id:z.string().regex(SYMBOL),label:z.string().min(1),unit:z.string().min(1),decimals:z.number().int().min(0).max(30),rounding:z.enum(['exact','nearest','truncate']),
 /** 给了就按表格读：`label` 是列头。格子里不带单位也认（「83,977」），带了别的单位不认。 */
 row:TableRowSchema.optional()}).strict();
/** Same-snapshot interval arithmetic. Formulas are bounded RPN tokens, never evaluated as code. */
export const DecimalEquationSchema=z.object({
 kind:z.literal('decimal-equation'),
 scope:z.object({start:z.string().min(1),end:z.string().min(1)}).strict(),
 inputs:z.array(ReadingInputSchema).min(1).max(40),
 actual:z.string().min(1), formula:z.array(z.string().min(1)).min(1).max(100),
 /**
  * 实际读数与公式结果怎么比（默认 eq：两个区间相交）。gt/gte/lt/lte 只在两个区间**完全分开**时判过或不过，
  * 落在显示精度之内分不清就是「没量到」。公式里可以写十进制常数（`0`、`10.5`）：
  * 2026-09-25 以前「Unrealized PNL 为 0」「可交易额大于 0」都写不出来，准备器只好拿 Balance 自减凑 0。
  */
 compare:z.enum(['eq','gt','gte','lt','lte','sign']).optional(),
 /*
  * sign：只比正负（docs/v3/15 阶段 4.3，POS-02-02「盈亏正负与价格高低一致」）。两个区间都严格在 0 的同一侧算过、
  * 严格在两侧算不过，任一边跨 0（显示成 $0.00）就是没量到。2026-09-26～27 测试网 201 张持仓截图里，
  * 用 eq 核对「PNL = Size × (Mark − Entry)」有 9 张对不上（PNL 与 Mark 列不是同一时刻的价），正负从没对不上过。
  */
 maxAgeMs:z.number().int().positive().max(60000),
 /**
  * 前面步骤用 `reading` 判据记下的读数（docs/v3/15 阶段 4.1），公式里按 id 引用。
  * 例：第 1 步后记 `liqBefore`，加仓后这里 `recorded:["liqBefore"]`、公式 `["liqBefore"]`、`compare:"gt"`。
  */
 recorded:z.array(z.string().regex(SYMBOL)).max(20).optional(),
}).strict();
/**
 * 记下一个读数，给后面步骤的 decimal-equation 用（docs/v3/15 阶段 4.1）。
 * 它本身不判产品对错：读得到就「过」并记下，读不到就是没量到——后面引用它的判据也跟着没量到。
 */
export const ReadingSchema=z.object({
 kind:z.literal('reading'),
 /** 与 decimal-equation 的一项输入同形：id 是后面引用它的名字。 */
 input:ReadingInputSchema,
 /** 同 decimal-equation 的取数范围；不给就在整屏里读，整屏里不唯一就是没量到。 */
 scope:z.object({start:z.string().min(1),end:z.string().min(1)}).strict().optional(),
}).strict();
export type Rat={n:bigint;d:bigint};export type DecimalInterval=[Rat,Rat];type Interval=DecimalInterval;
/** 一条用例执行期间记下的读数：id → 显示精度内的区间。 */
export type RecordedReadings=Map<string,DecimalInterval>;

const rat=(n:bigint,d=1n):Rat=>d<0n?{n:-n,d:-d}:{n,d};
const add=(a:Rat,b:Rat)=>rat(a.n*b.d+b.n*a.d,a.d*b.d);
const neg=(a:Rat)=>rat(-a.n,a.d);
const mul=(a:Rat,b:Rat)=>rat(a.n*b.n,a.d*b.d);
const cmp=(a:Rat,b:Rat)=>{const n=a.n*b.d-b.n*a.d;return n<0n?-1:n>0n?1:0;};
const escape=(s:string)=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
type ReadingInput=z.infer<typeof ReadingInputSchema>;
const NUM='[+-]?\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|[+-]?\\d+(?:\\.\\d+)?';
function interval(sign:string|undefined,digits:string,input:Pick<ReadingInput,'decimals'|'rounding'>):Interval|undefined {
 const body=digits.replace(/,/g,'');
 if(sign&&/^[+-]/.test(body))return;
 const raw=sign==='-'?`-${body}`:body;const value=decimal(raw);if(!value||value.scale>input.decimals)return;
 const v=rat(value.coefficient,10n**BigInt(value.scale));const step=rat(1n,10n**BigInt(input.decimals));
 if(input.rounding==='exact')return[v,v];
 if(input.rounding==='nearest'){const half=rat(step.n,step.d*2n);return[add(v,neg(half)),add(v,half)];}
 // Truncation towards zero. Endpoints are conservative inclusive bounds.
 return value.coefficient<0n?[add(v,neg(step)),v]:value.coefficient>0n?[v,add(v,step)]:[neg(step),step];
}
function range(text:string,input:ReadingInput):Interval|undefined {
 // 单位可以写在数值后（`12.5 USDC`）也可以写在前面（`$984.02`、`-$3.10`）；千分位逗号照读。
 // 2026-09-25 以前只认后缀，「Balance\n$984.02」读不出来，三次探查都卡在这。
 if(input.row)return tableRange(text,input,input.row);
 const unit=escape(input.unit);
 const re=new RegExp(`^\\s*${escape(input.label)}\\s*[:：]?\\s*(?:([+-]?)\\s*${unit}\\s*(${NUM})|(${NUM})\\s*${unit})\\s*$`,'gm');
 const matches=[...text.matchAll(re)];if(matches.length!==1)return;
 const m=matches[0]!;return interval(m[1],m[2]??m[3]!,input);
}
/**
 * 表格读法。页面文字（innerText）里一格与一格之间是制表符，表头最后一格与第一行第一格之间是空行：
 * `Market\n\t\nSize\n\t\n…Liq. Price\n\t\n…TP/SL\n\nBTC  20x\t\n0.00100 BTC\n\t\n…`（2026-09-26 测试网实录）。
 * 先按制表符与空行切格，找表头里 keyColumn 与 label 两格算出列距，再找行首以 key 开头的那一格，隔同样的列距取值。
 * 表头或行不唯一、格子里不是这个单位的数，一律读不到——没量到，不猜。
 */
function tableRange(text:string,input:ReadingInput,row:z.infer<typeof TableRowSchema>):Interval|undefined {
 const cell=tableCell(text,row.key,row.keyColumn,input.label);if(cell===undefined)return;
 const first=cell.split('\n').map(l=>l.trim()).find(Boolean)??'';
 const unit=escape(input.unit);
 const m=new RegExp(`^([+-]?)\\s*(?:${unit}\\s*)?(${NUM})(?:\\s*(${unit}))?`).exec(first);if(!m)return;
 const rest=first.slice(m[0].length).trim();
 // 数后面跟的只能是空、说明性的括号（「$4.20 (Cross)」「-$0.00 (-0.0%)」）。跟着别的单位就不是要读的那一格。
 if(rest&&!rest.startsWith('('))return;
 return interval(m[1],m[2]!,input);
}
const clean=(s:string)=>s.replace(/\u00a0/g,' ').replace(/[ \t]+/g,' ').trim();
const lastLine=(s:string)=>{const lines=clean(s).split('\n').map(l=>l.trim()).filter(Boolean);return lines[lines.length-1]??'';};
const firstLine=(s:string)=>clean(s).split('\n').map(l=>l.trim()).filter(Boolean)[0]??'';
const same=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
export function tableCell(text:string,key:string,keyColumn:string,column:string):string|undefined {
 const cells=text.split(/\t|\n[ \u00a0]*\n/);
 // 表头：keyColumn 那格之后 30 格内第一个 column 格。列距要唯一。
 const headers:Array<{at:number;offset:number}>=[];
 for(let i=0;i<cells.length;i++){
  if(!same(lastLine(cells[i]!),keyColumn))continue;
  if(same(keyColumn,column)){headers.push({at:i,offset:0});continue;}
  for(let j=i+1;j<Math.min(cells.length,i+31);j++)if(same(firstLine(cells[j]!),column)||same(lastLine(cells[j]!),column)){headers.push({at:j,offset:j-i});break;}
 }
 if(headers.length!==1)return;
 const {at,offset}=headers[0]!;
 const keyRe=new RegExp(`^${escape(key)}(?:\\s|$)`,'i');
 const rows=cells.map((c,k)=>({c,k})).filter(({c,k})=>k>at&&keyRe.test(firstLine(c)));
 if(rows.length!==1)return;
 return cells[rows[0]!.k+offset];
}
const show=(r:Rat)=>{const d=Number(r.n)/Number(r.d);return Number.isFinite(d)?String(Number(d.toPrecision(12))):`${r.n}/${r.d}`;};
const showInterval=(x:Interval)=>cmp(x[0],x[1])===0?show(x[0]):`[${show(x[0])}, ${show(x[1])}]`;
function scoped(text:string,scope:{start:string;end:string}|undefined):string|{error:string} {
 if(!scope)return text;
 const starts=text.split(scope.start);if(starts.length!==2)return {error:'账户/市场/订单范围不唯一'};
 const ends=starts[1]!.split(scope.end);if(ends.length!==2)return {error:'无法确定取数范围的结束边界'};
 return ends[0]!;
}
/** `reading`：读到就记下并算过，读不到是没量到。 */
export function evaluateReading(oracle:z.infer<typeof ReadingSchema>,snapshot:{text:string},readings:RecordedReadings):{status:'pass'|'unobservable';detail:string} {
 const {input}=oracle;
 const text=scoped(snapshot.text,oracle.scope);
 if(typeof text!=='string')return {status:'unobservable',detail:`读数 ${input.id}：${text.error}`};
 const r=range(text,input);
 if(!r){readings.delete(input.id);return {status:'unobservable',detail:`读数 ${input.id}：无法唯一读取「${input.label}」${input.row?`（${input.row.key} 那一行）`:''}或单位/精度不匹配`};}
 readings.set(input.id,r);
 return {status:'pass',detail:`记下 ${input.id} = ${showInterval(r)}`};
}
export function evaluateDecimalEquation(oracle:z.infer<typeof DecimalEquationSchema>,snapshot:{text:string;capturedAt?:number},now=Date.now(),readings?:RecordedReadings):{status:'pass'|'fail'|'unobservable';detail:string} {
 const unknown=(detail:string)=>({status:'unobservable' as const,detail});
 if(!snapshot.capturedAt||now<snapshot.capturedAt||now-snapshot.capturedAt>oracle.maxAgeMs)return unknown('缺少同时间窗快照或快照已过期');
 const starts=snapshot.text.split(oracle.scope.start);if(starts.length!==2)return unknown('账户/市场/订单范围不唯一');
 const ends=starts[1]!.split(oracle.scope.end);if(ends.length!==2)return unknown('无法确定取数范围的结束边界');
 const values=new Map<string,Interval>();
 for(const input of oracle.inputs){if(values.has(input.id))return unknown('重复输入标识');const r=range(ends[0]!,input);if(!r)return unknown(`无法唯一读取数值或币种/精度不匹配：${input.id}`);values.set(input.id,r);}
 // 前面步骤记下的读数。没记下（那一步读不到、或者根本没那一步）就是没量到，不是失败。
 for(const id of oracle.recorded??[]){if(values.has(id))return unknown(`读数 ${id} 与本屏输入同名`);const r=readings?.get(id);if(!r)return unknown(`读数 ${id} 没有在之前的步骤记下`);values.set(id,r);}
 const stack:Interval[]=[];
 for(const token of oracle.formula){
  if(values.has(token)){stack.push(values.get(token)!);continue;}
  if(/^-?\d+(?:\.\d+)?$/.test(token)){const v=decimal(token)!;const r=rat(v.coefficient,10n**BigInt(v.scale));stack.push([r,r]);continue;}
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
 const op=oracle.compare??'eq';
 if(op==='sign'){
  const side=(x:Interval)=>cmp(x[0],rat(0n))>0?1:cmp(x[1],rat(0n))<0?-1:0;
  const a=side(actual),e=side(expected);
  if(!a||!e)return unknown('读数或计算结果在显示精度内可能为 0，分不清正负');
  return a===e?{status:'pass',detail:`实际读数与计算结果同为${a>0?'正':'负'}`}:{status:'fail',detail:`实际读数为${a>0?'正':'负'}，计算结果为${e>0?'正':'负'}`};
 }
 if(op==='eq')return {status:intersects?'pass':'fail',detail:intersects?'同快照十进制计算区间与显示区间相交（仅证明显示精度内一致）':'同快照十进制计算区间与显示区间不相交'};
 // 区间完全在一侧才下结论；strict 比较要求严格分开，非 strict 允许端点相接。
 const above=op==='gt'?cmp(actual[0],expected[1])>0:cmp(actual[0],expected[1])>=0;
 const below=op==='lt'?cmp(actual[1],expected[0])<0:cmp(actual[1],expected[0])<=0;
 const wantAbove=op==='gt'||op==='gte';
 if(wantAbove?above:below)return {status:'pass',detail:`实际读数区间整体${wantAbove?'高于':'低于'}计算区间（${op}）`};
 const opposite=wantAbove?cmp(actual[1],expected[0])<(op==='gte'?0:1):cmp(actual[0],expected[1])>(op==='lte'?0:-1);
 return opposite?{status:'fail',detail:`实际读数区间不满足 ${op}`}:unknown(`实际读数与计算结果在显示精度内分不清（${op}）`);
}
