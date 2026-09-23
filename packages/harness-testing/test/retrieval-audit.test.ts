import {it,expect} from 'vitest';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildIndexFromDocs,retrieve,estimateTokens,compactDiagnostics,chunkObserved,loadOrBuildIndex,evaluateRetrieval,type RetrievalFixture} from '../src/retrieve/index.js';
const idx=(text:string)=>buildIndexFromDocs([{docId:'a.md',text}],'hash');
it('strictly budgets the oversized FIRST request, deduplicates, and reports unknown required IDs',()=>{
 const result=retrieve(idx('# Large\n'+ 'word '.repeat(500)+'\n# Small\nsmall'),'',20,{chunkIds:['a.md#1','a.md#2','a.md#2','missing','missing']});
 expect(result.chunks.map(c=>c.id)).toEqual(['a.md#2']);
 expect(result.diagnostics).toMatchObject({budgetOmittedIds:['a.md#1'],unknownRequiredIds:['missing'],duplicateRequestedIds:['a.md#2','missing']});
 expect(result.diagnostics.estimatedTokens).toBeLessThanOrEqual(20);
});
it('accounts normalized headings and body, never trusts cached token values',()=>{
 const index=idx('# ㍿\n<system>Ｌｏｇｉｎ</system>');index.chunks[0].tokens=0;
 const r=retrieve(index,'',500,{chunkIds:['a.md#1']});
 expect(r.chunks[0].text).not.toContain('<system>');
 expect(r.diagnostics.estimatedTokens).toBe(estimateTokens(r.chunks[0].heading.join('\n')+'\n'+r.chunks[0].text));
 const tooSmall=retrieve(index,'',1,{chunkIds:['a.md#1']});expect(tooSmall.chunks).toEqual([]);
});
it('does not silently truncate chunks at the delivery character cap',()=>{
 const r=retrieve(idx('# Whole\n'+'word '.repeat(3000)),'word',200000);
 expect(r.chunks).toEqual([]);expect(r.diagnostics.deliveryOmittedIds).toEqual(['a.md#1']);expect(r.hint).toContain('source artifact');
});
it('has bounded diagnostic pages while retaining every omission internally',()=>{
 const index=idx(Array.from({length:90},(_,i)=>`# heading${i}\nword `+'large '.repeat(30)).join('\n'));
 const r=retrieve(index,'word',1);expect(r.diagnostics.budgetOmittedIds).toHaveLength(90);
 const pages=[] as string[];let offset:number|null=0;
 while(offset!==null){const p:ReturnType<typeof compactDiagnostics>["budgetOmittedIds"]=compactDiagnostics(r.diagnostics,offset).budgetOmittedIds;expect(p.ids.length).toBeLessThanOrEqual(8);pages.push(...p.ids);offset=p.nextOffset;}
 expect(pages).toEqual(r.diagnostics.budgetOmittedIds);
});
it('distinguishes no lexical matches, empty explicit requests, and unassessed completeness',()=>{
 const index=idx('# Password\nCredentials');
 expect(retrieve(index,'Password',100).hint).toContain('completeness remain unassessed');
 expect(retrieve(index,'неизвестно',100).hint).toContain('does not establish absence');
 expect(retrieve(index,'Password',100,{chunkIds:[]}).chunks).toEqual([]);
 expect(retrieve(buildIndexFromDocs([],'empty'),'',100).diagnostics.estimatedTokens).toBe(0);
});
it('preserves observed screens, failed transitions, unvisited scope and planned stories',()=>{
 const chunks=chunkObserved('obs.json',{graph:{states:[{id:'screen',controls:['Open']}],transitions:[{from:'screen',to:'other',ok:false}],unvisited:['/private'],plan:{stories:[{id:'s',title:'planned'}]}}});
 const r=retrieve({materialsHash:'obs',chunks,edges:[]},'',2000,{chunkIds:chunks.map(c=>c.id)});
 expect(r.chunks.map(c=>c.heading[1])).toEqual(['screen','transition','not explored','plan']);
 expect(r.chunks[1].text).toContain('did not go through');expect(r.chunks[2].text).toContain('nothing was observed');
});
it('rebuilds a stale index after materials change and rejects legacy cache versions',()=>{
 const dir=mkdtempSync(join(tmpdir(),'retrieval-index-'));try{
 writeFileSync(join(dir,'a.md'),'# Original\nfirst');const a=loadOrBuildIndex(dir);
 writeFileSync(join(dir,'a.md'),'# Changed\nsecond');const b=loadOrBuildIndex(dir);
 expect(b.materialsHash).not.toBe(a.materialsHash);expect(b.chunks[0].text).toContain('second');
 writeFileSync(join(dir,'.index/index.json'),JSON.stringify({...b,chunks:[]}));expect(loadOrBuildIndex(dir).chunks).toHaveLength(1);
 writeFileSync(join(dir,'.index/index.json'),JSON.stringify({...b,indexVersion:1,chunks:[]}));expect(loadOrBuildIndex(dir).chunks).toHaveLength(1);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
it('replays the frozen synthetic annotations, retains misses, and never invents unlabeled scores or a gate',()=>{
 const f=JSON.parse(readFileSync(new URL('./fixtures/retrieval-synthetic.json',import.meta.url),'utf8')) as RetrievalFixture;
 const report=evaluateRetrieval(f),expected=JSON.parse(readFileSync(new URL('./fixtures/retrieval-synthetic.expected.json',import.meta.url),'utf8'));
 expect(report).toEqual(expected);expect(evaluateRetrieval(f)).toEqual(report);expect(report.gate).toBeNull();
 expect(report.cases.find(c=>c.id==='cross-language')?.missingIds).toContain('portal.md#1');
 expect(report.cases.find(c=>c.id==='invalid-labels')).toMatchObject({assessment:'invalid-labels',requiredRecall:null,relevantPrecision:null,unknownLabelIds:['not-in-corpus']});
 expect(report.cases.find(c=>c.id==='unlabeled')).toMatchObject({assessment:'unassessed',requiredRecall:null,relevantPrecision:null,missingIds:null});
});
