import { it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { benchmarkCatalog } from '../src/benchmarkCatalog.js';
import { saveGold, freezeGold, createGoldDraft } from '../src/gold.js';
it('creates a project scaffold without inheriting human approval or overwriting a dataset', () => {
 const root=mkdtempSync(join(tmpdir(),'tp-draft-'));
 try {
  const file={id:'new-ui',items:[{id:'one',title:'Visible state',match:{anyOf:['state']},reviewReceipt:{reviewer:'claimed',at:'now',contentHash:'forged'}}]};
  const state=createGoldDraft('new-ui',file,'project-one',root);
  expect(state.draft?.reviewPolicy).toBe('individual-v1');
  expect(state.draft?.items[0].reviewReceipt).toBeUndefined();
  expect(state.gold).toBeNull();expect(state.frozenHash).toBeNull();
  const dir=join(root,'benchmark','new-ui');
  for(const name of ['materials','rubric','held-out']) expect(existsSync(join(dir,name))).toBe(true);
  expect(readFileSync(join(dir,'README.md'),'utf8')).toContain('gold.json 还不存在');
  expect(benchmarkCatalog(join(root,'benchmark'))[0].projectId).toBe('project-one');
  expect(()=>createGoldDraft('new-ui',file,'project-two',root)).toThrow('benchmark_already_exists');
  expect(()=>createGoldDraft('../escape',{...file,id:'../escape'},'project-one',root)).toThrow('invalid_capability');
 } finally {rmSync(root,{recursive:true,force:true});}
});
it('archived datasets remain discoverable and cannot be overwritten or frozen', () => {
 const root=mkdtempSync(join(tmpdir(),'tp-catalog-'));
 try {
  const dir=join(root,'benchmark','old');mkdirSync(dir,{recursive:true});
  writeFileSync(join(dir,'catalog.json'),JSON.stringify({archived:true,reason:'historical'}));
  expect(benchmarkCatalog(join(root,'benchmark'))).toEqual([{capability:'old',archived:true,reason:'historical'}]);
  expect(()=>saveGold('old',{id:'old',items:[]},{root,newLineage:true})).toThrow('benchmark_archived_read_only');
  expect(()=>freezeGold('old',root)).toThrow('benchmark_archived_read_only');
 } finally { rmSync(root,{recursive:true,force:true}); }
});
