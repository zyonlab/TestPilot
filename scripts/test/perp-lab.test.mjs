import { test } from 'node:test';import assert from 'node:assert/strict';import {once}from'node:events';import{createPerpLab}from'../../fixtures/perp-lab/server.mjs';
test('controlled contract: exact size, leverage, price-band, margin and reset boundaries; each explicit mutant changes its intended result',async()=>{
 for(const defect of [null,'round-size','leverage-cap','price-band','margin-check']){
  const server=createPerpLab({defect});server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
  const post=async(path,body={})=>{const r=await fetch(base+'/api/'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return{status:r.status,body:await r.json()};};
  const state=async()=>fetch(base+'/api/clearinghouse').then(r=>r.json());
  try{
   for(const [size,expected]of[['0.001','0.001'],['0.003','0.003'],['0.0016',defect==='round-size'?'0.002':'0.001']]){await post('reset');assert.equal((await post('order',{size,type:'market'})).body.position.szi,expected);}
   await post('reset');assert.equal((await post('order',{size:'0.0001'})).status,400);assert.equal((await state()).position,null);
   assert.equal((await post('leverage',{value:40})).status,200);assert.equal((await post('leverage',{value:41})).status,defect==='leverage-cap'?200:400);assert.equal((await post('leverage',{value:1.5})).status,400);
   await post('reset');assert.equal((await state()).leverage,20);
   for(const price of ['16000','144000']){await post('reset');assert.equal((await post('order',{size:'0.001',type:'limit',price})).status,200);}
   assert.equal((await post('order',{size:'0.001',type:'limit',price:'144000.5'})).status,defect==='price-band'?200:400);
   assert.equal((await post('order',{size:'0.001',type:'limit',price:'80000.1'})).status,400);
   await post('reset');assert.equal((await post('order',{size:'0.250',type:'market'})).status,200);await post('reset');assert.equal((await post('order',{size:'0.251',type:'market'})).status,defect==='margin-check'?200:400);
   await post('reset');assert.deepEqual((await state()).orders,[]);assert.equal((await state()).balance,'1000');
  }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
 }
});
test('v2 contract: margin mode, reduce-only, stop trigger and TP/SL are enforced; reduce-only-open and tpsl-panel defects change only their own result',async()=>{
 for(const defect of [null,'reduce-only-open','tpsl-panel']){
  const server=createPerpLab({defect});server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
  const post=async(path,body={})=>{const r=await fetch(base+'/api/'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return{status:r.status,body:await r.json()};};
  const state=async()=>fetch(base+'/api/clearinghouse').then(r=>r.json());
  try{
   await post('reset');assert.equal((await state()).marginMode,'cross');
   assert.equal((await post('margin',{mode:'isolated'})).status,200);assert.equal((await state()).marginMode,'isolated');assert.equal((await post('margin',{mode:'hedge'})).status,400);
   await post('reset');
   // reduce-only with no position: rejected unless the defect opens positions through it
   assert.equal((await post('order',{size:'0.001',type:'market',reduceOnly:true})).status,defect==='reduce-only-open'?200:400);
   await post('reset');await post('order',{size:'0.010',type:'market'});
   assert.equal((await post('order',{size:'0.011',type:'market',reduceOnly:true})).status,defect==='reduce-only-open'?200:400);
   if(defect!=='reduce-only-open'){assert.equal((await post('order',{size:'0.004',type:'market',reduceOnly:true})).body.position.szi,'0.006');assert.equal((await post('order',{size:'0.006',type:'market',reduceOnly:true})).body.position,null);}
   await post('reset');assert.equal((await post('order',{size:'0.001',type:'stop',price:'80000',triggerPx:'79000.1'})).status,400);assert.equal((await post('order',{size:'0.001',type:'stop',price:'80000',triggerPx:'79000'})).status,200);assert.equal((await state()).orders[0].triggerPx,'79000');
   await post('reset');assert.equal((await post('order',{size:'0.001',type:'market',tp:'90000.1'})).status,400);assert.equal((await post('order',{size:'0.001',type:'market',tp:'90000',sl:'70000'})).status,200);
   const html=await fetch(base+'/').then(r=>r.text());assert.equal(html.includes('window.__LAB_DEFECT="tpsl-panel"'),defect==='tpsl-panel');
   for(const id of ['tab-stop','mode-isolated','ro','tpsl','tpsl-panel'])assert.ok(html.includes(`id="${id}"`),id);
  }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
 }
});
