import {beforeAll,afterAll,it,expect,vi} from 'vitest';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
let dir:string,project:string,hosts:typeof import('../src/plannerHost.js'),database:typeof import('../src/db.js');
beforeAll(async()=>{
 dir=mkdtempSync(join(tmpdir(),'tp-host-test-'));const script=join(dir,'host');writeFileSync(script,`#!/usr/bin/env node
 const args=process.argv.slice(2);
 if(args[0]==='login'||args[0]==='auth'){if(process.env.TP_FAKE_HOST_OFF==='1'){console.error('Not logged in');process.exit(1);}console.log(args[0]==='login'?'Logged in using ChatGPT':JSON.stringify({loggedIn:true}));}
 else{let text='';process.stdin.on('data',c=>text+=c);process.stdin.on('end',()=>{if(process.env.TP_PLANNER_API_KEY||process.env.MIDSCENE_MODEL_API_KEY)process.exit(2);if(args[0]==='-a'){console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'{"reply":"host draft"}'}}));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:4,output_tokens:2}}));}else console.log(JSON.stringify({result:'{"reply":"claude draft"}',usage:{input_tokens:3,output_tokens:2},modelUsage:{'reported-model':{}}}));});}
 `,{mode:0o700});vi.stubEnv('TP_DATA_DIR',dir);vi.stubEnv('TP_CODEX_BIN',script);vi.stubEnv('TP_CLAUDE_BIN',script);vi.stubEnv('MIDSCENE_MODEL_API_KEY','executor-not-planner');
 database=await import('../src/db.js');hosts=await import('../src/plannerHost.js');project=database.createProject('test','http://localhost').id;
});
afterAll(async()=>{(await import('../src/runService.js')).runLedger().close();database.db.close();vi.unstubAllEnvs();rmSync(dir,{recursive:true,force:true});});
it('reports authentication without pretending to know model or active chat, and requires a choice for two hosts',async()=>{const s=await hosts.hostStatus(project);expect(s.hosts.map(h=>h.state)).toEqual(['ready','ready']);expect(s.selected).toBeNull();expect(s.hosts.every(h=>h.model===null)).toBe(true);await expect(hosts.requireHost(project)).rejects.toThrow('selection_required');});
it('persists selection, rejects unavailable authentication and does not fall back',async()=>{await hosts.selectHost(project,'codex');expect(await hosts.requireHost(project)).toBe('codex');vi.stubEnv('TP_FAKE_HOST_OFF','1');await expect(hosts.requireHost(project)).rejects.toThrow('not_ready');expect((await hosts.hostStatus(project)).selected).toBe('codex');vi.stubEnv('TP_FAKE_HOST_OFF','0');await expect(hosts.selectHost(project,'other')).rejects.toThrow('invalid');});
it('draft adapters use host defaults, bounded independent processes, no managed planner keys',async()=>{const request={stable:'draft only',variable:'write a greeting'};expect(await hosts.nativeHostChat('codex',request)).toMatchObject({text:'{"reply":"host draft"}',tokens:6});expect(await hosts.nativeHostChat('claude-code',request)).toMatchObject({text:'{"reply":"claude draft"}',tokens:5,model:'reported-model'});expect(hosts.nativeDraftArgs('codex')).toContain('read-only');expect(hosts.nativeDraftArgs('claude-code')).toContain('--tools');expect(hosts.nativeDraftArgs('codex')).not.toContain('--model');});
