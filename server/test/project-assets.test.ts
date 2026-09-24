import {afterEach,it,expect} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RunLedger} from '../src/runLedger.js';
import {ProjectAssets} from '../src/projectAssets.js';
import {captureWebModels} from './helpers/model-snapshot.js';
const human={kind:'human' as const,id:'operator'},agent={kind:'agent' as const,id:'planner'};
const cleanup:Array<()=>void>=[];
afterEach(()=>cleanup.splice(0).forEach(f=>f()));
function setup(){const dir=mkdtempSync(join(tmpdir(),'tp-assets-'));let ledger=new RunLedger(join(dir,'ledger.db'),join(dir,'blobs'));cleanup.push(()=>{ledger.close();rmSync(dir,{recursive:true,force:true});});
 const register=(projectId:string,externalId:string)=>ledger.register({projectId,externalId,idempotencyKey:externalId,binding:{schemaVersion:1,models:captureWebModels().binding,skillVersion:'fixture',loadedDigest:'a'.repeat(64),materialsHash:null,inputHash:null,environmentHash:null,materialRevisions:[]}},agent).runId;
 const run=register('p','one'),run2=register('p','two');
 const source=(value:unknown,runId=run)=>ledger.putRevision({projectId:'p',runId,name:'source-'+Math.random(),kind:'material',content:value},agent).id;
 const assets=new ProjectAssets(ledger);
 const propose=(assetKey:string,value:unknown,baseVersion:string|null=null,dependencies:string[]=[])=>assets.propose('p',{assetKey,sourceRevision:source(value),baseVersion,dependencies},agent);
 const adopt=(id:string,expectedHead:string|null=null)=>assets.decide('p',id,{action:'adopt',expectedHead,reason:'Reviewed candidate'},human);
 return {ledger,assets,run,run2,source,propose,adopt,reopen:()=>{ledger.close();ledger=new RunLedger(join(dir,'ledger.db'),join(dir,'blobs'));return new ProjectAssets(ledger);}};
}
it('imports immutable candidates idempotently without altering historical run artifacts',()=>{
 const s=setup(),ref=s.source({goal:'Open'}),input={assetKey:'story/open',sourceRevision:ref,baseVersion:null,dependencies:[]};
 const first=s.assets.propose('p',input,agent);expect(s.assets.propose('p',input,agent).id).toBe(first.id);
 expect(s.assets.heads('p')).toEqual({});expect(s.assets.list('p').versions[0].status).toBe('candidate');
 expect(s.ledger.readRevision(ref,'p').content).toEqual({goal:'Open'});
 expect(()=>s.assets.propose('other',input,agent)).toThrow('revision_project_conflict');expect(()=>s.assets.read('other',first.id)).toThrow('asset_project_conflict');
});
it('rejects agent adoption and concurrent stale heads, supports explicit rebasing',()=>{
 const s=setup(),a=s.propose('rules',{v:1}),b=s.propose('rules',{v:2});
 expect(()=>s.assets.decide('p',a.id,{action:'adopt',expectedHead:null,reason:'x'},agent)).toThrow('operator_action_required');
 s.adopt(a.id);expect(()=>s.adopt(b.id)).toThrow('asset_head_changed');expect(()=>s.adopt(b.id,a.id)).toThrow('asset_candidate_needs_rebase');
 const rebased=s.propose('rules',{v:2},a.id);s.adopt(rebased.id,a.id);expect(s.assets.heads('p').rules).toBe(rebased.id);
 expect(s.assets.list('p').versions.find(v=>v.id===a.id)?.status).toBe('superseded');
});
it('pins dependency closure and survives restart while project heads advance',()=>{
 const s=setup(),rule=s.propose('rules',{threshold:1});s.adopt(rule.id);
 const story=s.propose('story',{acceptance:'threshold'},null,[rule.id]);s.adopt(story.id);
 const snapshot=s.assets.snapshot('p','Before change',human),updated=s.propose('rules',{threshold:2},rule.id);s.adopt(updated.id,rule.id);
 expect(s.assets.readSnapshot('p',snapshot.id)).toEqual(snapshot);
 expect(s.assets.list('p').versions.find(v=>v.id===story.id)?.staleDependencies).toEqual([rule.id]);
 const reopened=s.reopen();expect(reopened.readSnapshot('p',snapshot.id).heads.rules).toBe(rule.id);expect(reopened.read('p',rule.id).content).toEqual({threshold:1});
 expect(()=>reopened.readSnapshot('other',snapshot.id)).toThrow('asset_project_conflict');
});
it('rejects missing, foreign, stale, self and cyclic dependencies',()=>{
 const s=setup(),a=s.propose('A',{v:1});s.adopt(a.id);
 expect(()=>s.propose('A',{v:2},a.id,[a.id])).toThrow('asset_self_dependency');
 expect(()=>s.propose('B',{},null,['missing'])).toThrow('asset_version_missing');
 const b=s.propose('B',{},null,[a.id]);s.adopt(b.id);
 const cycle=s.propose('A',{v:2},a.id,[b.id]);expect(()=>s.adopt(cycle.id,a.id)).toThrow('asset_dependency_cycle');
 const updated=s.propose('A',{v:3},a.id);s.adopt(updated.id,a.id);
 const stale=s.propose('C',{},null,[a.id]);expect(()=>s.adopt(stale.id)).toThrow('asset_dependency_not_current');
});
it('keeps test evidence out of adopted business assets and detects corrupted copies',()=>{
 const s=setup();const report=s.ledger.putRevision({projectId:'p',runId:s.run,name:'execution',kind:'report',content:{pass:true}},agent);
 expect(()=>s.assets.propose('p',{assetKey:'rules',sourceRevision:report.id,baseVersion:null},agent)).toThrow('asset_source_not_reusable');
 const a=s.propose('A',{});s.ledger.db.prepare('UPDATE project_asset_versions SET content=? WHERE id=?').run('{"changed":true}',a.id);expect(()=>s.assets.read('p',a.id)).toThrow('asset_content_changed');
});
