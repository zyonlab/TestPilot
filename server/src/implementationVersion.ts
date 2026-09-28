import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import type {RunLedger} from './runLedger.js';

/** Workspace evidence at registration, never a claim about a host's loaded code. */
export function recordImplementation(ledger:RunLedger,runId:string,projectId:string){
  let commit:string|null=null,trackedDiff:string|null=null;
  try {
    const cwd=resolve(import.meta.dirname,'../..');
    commit=execFileSync('git',['rev-parse','HEAD'],{cwd,encoding:'utf8',timeout:3000}).trim();
    const diff=execFileSync('git',['diff','HEAD','--','server/src','packages','plugins/testpilot','pnpm-lock.yaml'],{cwd,timeout:3000,maxBuffer:8_000_000});
    trackedDiff=createHash('sha256').update(diff).digest('hex');
  } catch { /* Unavailable provenance stays unknown; registration still works. */ }
  ledger.putRevision({runId,projectId,name:'implementation/registration',kind:'report',content:{schemaVersion:'implementation-registration.v1',commit,trackedDiff,at:new Date().toISOString(),scope:'server-workspace-at-registration',loadedImplementation:null,untrackedFiles:'not-captured'}},{kind:'system',id:'version-recorder'});
}
