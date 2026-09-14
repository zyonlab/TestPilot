/** Local versioned contract; defaults healthy. Defects are explicit and never affect external exchanges. */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export const LAB_VERSION = 'perp-lab-v2';
// v2 (2026-09-10): margin mode, reduce-only, stop-limit trigger and TP/SL panel added for domain-guided exploration; v1 endpoints and defects unchanged.
// 'tpsl-panel' is a UI-only defect: the TP/SL toggle changes state but never reveals the price inputs.
export const DEFECTS = ['round-size', 'leverage-cap', 'price-band', 'margin-check', 'reduce-only-open', 'tpsl-panel'];
const initial = () => ({ position: null, orders: [], leverage: 20, marginMode: 'cross', balance: '1000', unit: 'BTC', quoteUnit: 'USDC', lastError: null });
const amount = raw => { if (!/^\d+(?:\.\d{1,8})?$/.test(String(raw))) return null; const [whole,part=''] = String(raw).split('.'); return BigInt(whole)*100000000n+BigInt(part.padEnd(8,'0')); };
const decimal = n => `${n/1000n}.${String(n%1000n).padStart(3,'0')}`;
export function createPerpLab({ defect = null } = {}) {
 if (defect !== null && !DEFECTS.includes(defect)) throw new Error('Unknown fixture defect');
 let state = initial();
 const server = createServer(async (req,res) => {
  const url = new URL(req.url,'http://local');
  const json=(status,body)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));};
  const reject=message=>{state.lastError=message;return json(400,{error:message});};
  if(req.method==='GET' && url.pathname==='/api/clearinghouse') return json(200,{...state,version:LAB_VERSION,observedAt:new Date().toISOString()});
  if(req.method==='GET' && url.pathname==='/api/contract') return json(200,{version:LAB_VERSION,baseUnit:'BTC',quoteUnit:'USDC',step:'0.001',tick:'0.5',referencePrice:'80000',maxLeverage:40,balance:'1000',marginModes:['cross','isolated'],orderTypes:['market','limit','stop'],reduceOnly:true,tpsl:true});
  if(req.method==='GET' && url.pathname==='/') {res.writeHead(200,{'content-type':'text/html; charset=utf-8'});const html=readFileSync(new URL('./public/index.html',import.meta.url),'utf8');res.end(defect==='tpsl-panel'?html.replace('<script>','<script>window.__LAB_DEFECT="tpsl-panel";'):html);return;}
  let body={}; if(req.method==='POST'){let text='';for await(const chunk of req){text+=chunk;if(text.length>4096)return json(413,{error:'body too large'});}try{body=JSON.parse(text||'{}');}catch{return json(400,{error:'invalid JSON'});}}
  if(req.method!=='POST')return json(404,{error:'not found'});
  state.lastError=null;
  if(url.pathname==='/api/reset'){state=initial();return json(200,{ok:true});}
  if(url.pathname==='/api/margin'){if(!['cross','isolated'].includes(body.mode))return reject('Margin mode must be cross or isolated');state.marginMode=body.mode;return json(200,{marginMode:body.mode});}
  if(url.pathname==='/api/leverage'){const value=Number(body.value);if(!Number.isInteger(value)||value<1||value>(defect==='leverage-cap'?100:40))return reject('Leverage must be an integer from 1 to 40');state.leverage=value;return json(200,{leverage:value});}
  if(url.pathname==='/api/order'){
   const raw=amount(body.size);if(raw===null)return reject('Invalid size');const lots=(raw+(defect==='round-size'?50000n:0n))/100000n;if(lots<1n)return reject('Size must be at least 0.001');
   const size=decimal(lots);
   const tickOk=v=>{const px=amount(v);return px!==null&&px>0n&&px%50000000n===0n;};
   if(body.tp!==undefined&&body.tp!==''&&!tickOk(body.tp))return reject('Take profit price must align to tick 0.5');
   if(body.sl!==undefined&&body.sl!==''&&!tickOk(body.sl))return reject('Stop loss price must align to tick 0.5');
   if(body.type==='stop'){if(!tickOk(body.triggerPx))return reject('Trigger price must align to tick 0.5');if(!tickOk(body.price))return reject('Invalid price');state.orders.push({oid:state.orders.length+1,coin:'BTC',limitPx:String(body.price),triggerPx:String(body.triggerPx),sz:size,reduceOnly:!!body.reduceOnly});return json(200,{ok:true,order:state.orders.at(-1)});}
   if(body.reduceOnly===true&&body.type!=='limit'){
    // Reduce Only closes exposure in the opposite direction; it never opens or flips a position.
    const prior=state.position?BigInt(state.position.szi.replace('.','')):0n;
    if(prior===0n&&defect!=='reduce-only-open')return reject('Reduce Only requires an open position');
    if(lots>prior&&defect!=='reduce-only-open')return reject('Reduce Only size exceeds position '+decimal(prior)+' BTC');
    const left=prior-lots;state.position=left<=0n?null:{...state.position,szi:decimal(left)};return json(200,{ok:true,position:state.position});
   }
   if(body.type==='limit'){const px=amount(body.price);if(px===null||px<=0n)return reject('Invalid price');if(px%50000000n!==0n)return reject('Price must align to tick 0.5');if(defect!=='price-band'&&(px<16000n*100000000n||px>144000n*100000000n))return reject('Order price cannot be more than 80% away from the reference price');state.orders.push({oid:state.orders.length+1,coin:'BTC',limitPx:String(body.price),sz:size});return json(200,{ok:true,order:state.orders.at(-1)});}
   // lots × 0.001 BTC × 80000 USDC/BTC <= balance × leverage.
   if(defect!=='margin-check'&&lots*80n>1000n*BigInt(state.leverage))return reject('Not Enough Margin');
   const prior=state.position?BigInt(state.position.szi.replace('.','')):0n;state.position={coin:'BTC',szi:decimal(prior+lots),leverage:state.leverage};return json(200,{ok:true,position:state.position});
  }
  if(url.pathname==='/api/close'){state.position=null;return json(200,{ok:true});}
  if(url.pathname==='/api/cancel'){state.orders=[];return json(200,{ok:true});}
  return json(404,{error:'not found'});
 });
 return server;
}
if(process.argv[1] && fileURLToPath(import.meta.url)===process.argv[1]) {const at=process.argv.indexOf('--port'), port=at<0?5391:Number(process.argv[at+1]); const d=process.argv.indexOf('--defect'),defect=d<0?null:process.argv[d+1];createPerpLab({defect}).listen(port,'127.0.0.1',()=>console.log(JSON.stringify({version:LAB_VERSION,port,defect})));}
