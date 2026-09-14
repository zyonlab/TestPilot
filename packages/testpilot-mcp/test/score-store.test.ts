import{expect,it}from'vitest';import{mkdtempSync,writeFileSync,rmSync,readFileSync}from'node:fs';import{tmpdir}from'node:os';import{join}from'node:path';import{spawn}from'node:child_process';import{storedScoreboard,storeScoreboardEntry}from'../src/score-store.js';
it('concurrent processes retain every score and repair a stale/torn YAML projection from SQLite',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'tp-score-store-')),file=join(dir,'scoreboard.yaml');writeFileSync(file,'# synthetic evaluations\nentries: []\n');
 try{storeScoreboardEntry(file,{runId:'initial',goldHash:'synthetic-hash',id:'initial'}as any);
 const module=new URL('../src/score-store.ts',import.meta.url).href;
 const children=Array.from({length:8},(_,i)=>new Promise<void>((ok,reject)=>{const code=`import {storeScoreboardEntry} from ${JSON.stringify(module)};storeScoreboardEntry(${JSON.stringify(file)},{runId:'run-${i}',goldHash:'synthetic-hash',id:'${i}'});`;const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',code],{stdio:['ignore','ignore','pipe']});let stderr='';child.stderr.on('data',b=>stderr+=b);child.on('error',reject);child.on('close',c=>c===0?ok():reject(new Error(stderr)));}));await Promise.all(children);expect(storedScoreboard(file)).toHaveLength(9);writeFileSync(file,'deliberately broken projection');expect(storedScoreboard(file)).toHaveLength(9);expect(readFileSync(file,'utf8')).toContain('synthetic evaluations');
 }finally{rmSync(dir,{recursive:true,force:true});}
},15000);
