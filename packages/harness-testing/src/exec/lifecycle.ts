import { z } from 'zod';
import { PrerequisiteCheckSchema, type PrerequisiteReceipt } from './preparationChecks.js';

/** Reviewed obligations, not a second setup-script language. Actions remain in steps/postSteps. */
const evidence = PrerequisiteCheckSchema.refine(c => c.checks.every(p => p.kind === 'screen' && !!p.oracle), 'Lifecycle evidence must be deterministic and on screen');
export const LifecycleSchema = z.object({
  version: z.literal(1),
  mode: z.enum(['read-only', 'controlled']),
  rationale: z.string().min(1),
  sourceRefs: z.array(z.string().min(1)).min(1),
  supports: z.array(z.string().min(1)).min(1),
  baseline: z.array(evidence).min(1),
  resources: z.array(z.object({
    id: z.string().min(1), sourceRef: z.string().min(1),
    // Runner substitutes a fresh execution id. Existing shared resources cannot be claimed.
    identity: z.string().min(1).refine(s => s.includes('${env.TP_LIFECYCLE_ID}'), 'Use the runner-owned identity placeholder'),
    establishAfterStep: z.number().int().positive(),
    established: evidence,
    ownership: evidence,
  }).strict()).max(20),
  cleanup: z.array(z.object({
    id: z.string().min(1), resourceId: z.string().min(1),
    postStep: z.number().int().positive(), verified: evidence,
  }).strict()).max(30),
}).strict();
export type Lifecycle = z.infer<typeof LifecycleSchema>;
export type LifecycleReceipt = {
  version: 1; status: 'pass' | 'fail' | 'unknown';
  checks: Array<PrerequisiteReceipt & { id: string; phase: 'baseline' | 'establish' | 'ownership' | 'cleanup'; resourceId?: string }>;
  cleanup: Array<{id:string;resourceId?:string;postStep:number;status:'pass'|'fail'|'unknown'|'not-run';detail:string}>;
  pendingResources: Array<{id:string;identity:string;reason:string}>;
  safeToRetry: boolean;
};
export const LifecycleReceiptSchema = z.object({
  version:z.literal(1),status:z.enum(['pass','fail','unknown']),safeToRetry:z.boolean(),
  checks:z.array(z.object({id:z.string(),phase:z.enum(['baseline','establish','ownership','cleanup']),resourceId:z.string().optional(),statement:z.string(),status:z.enum(['pass','fail','unknown']),detail:z.string().optional()})),
  cleanup:z.array(z.object({id:z.string(),resourceId:z.string().optional(),postStep:z.number().int().positive(),status:z.enum(['pass','fail','unknown','not-run']),detail:z.string()})),
  pendingResources:z.array(z.object({id:z.string(),identity:z.string(),reason:z.string()})),
});
/** Lost runner receipts cannot establish whether the resource was created or cleaned. */
export function unavailableLifecycle(contract?:Lifecycle,postSteps:string[]=[]):LifecycleReceipt {
  return {version:1,status:'unknown',safeToRetry:false,checks:[],cleanup:(contract?.cleanup??postSteps.map((_,i)=>({id:`legacy-${i+1}`,postStep:i+1}))).map(x=>({...x,status:'not-run',detail:'Runner receipt unavailable; cleanup execution unknown'})),pendingResources:contract?.resources.map(r=>({id:r.id,identity:r.identity,reason:'Runner receipt unavailable; establishment and cleanup unknown'}))??(postSteps.length?[{id:'legacy-unknown',identity:'unknown',reason:'Runner receipt unavailable'}]:[])};
}
export function lifecycleIssues(c: {lifecycle?: Lifecycle; steps: string[]; postSteps: string[]; precondition?:string[]; sourceRefs?: string[]; assertions?:Array<{id:string}>}): string[] {
  const l=c.lifecycle; if(!l)return ['lifecycle_unknown'];
  const issues:string[]=[];
  const ids=new Set(l.resources.map(r=>r.id));
  if(ids.size!==l.resources.length||new Set(l.resources.map(r=>r.identity)).size!==l.resources.length||new Set(l.cleanup.map(r=>r.id)).size!==l.cleanup.length||new Set(l.cleanup.map(r=>r.postStep)).size!==l.cleanup.length)issues.push('lifecycle_duplicate_id');
  if(l.sourceRefs.some(ref=>!c.sourceRefs?.includes(ref))||l.resources.some(r=>!l.sourceRefs.includes(r.sourceRef)))issues.push('lifecycle_source_unbound');
  if(l.supports.some(id=>id!=='$expected'&&!c.assertions?.some(a=>a.id===id)))issues.push('lifecycle_assertion_unbound');
  if(c.precondition?.some(p=>!l.baseline.some(b=>b.statement===p)))issues.push('lifecycle_precondition_unbound');
  const namesIdentity=(check:z.infer<typeof PrerequisiteCheckSchema>,identity:string)=>check.checks.some(p=>p.kind==='screen'&&p.oracle&&JSON.stringify(p.oracle).includes(identity));
  if(l.mode==='read-only'&&(l.resources.length||l.cleanup.length||c.postSteps.length))issues.push('lifecycle_readonly_mutation');
  if(l.mode==='controlled'&&!l.resources.length)issues.push('lifecycle_resources_missing');
  for(const r of l.resources){
    if(r.establishAfterStep>c.steps.length||!c.steps[r.establishAfterStep-1]?.includes(r.identity))issues.push('lifecycle_establish_unbound:'+r.id);
    if(!l.cleanup.some(x=>x.resourceId===r.id))issues.push('lifecycle_compensation_missing:'+r.id);
    // Ownership may include project account details, but must also name this execution's resource.
    if(!namesIdentity(r.ownership,r.identity))issues.push('lifecycle_ownership_unbound:'+r.id);
    if(!namesIdentity(r.established,r.identity))issues.push('lifecycle_establish_evidence_unbound:'+r.id);
  }
  for(const x of l.cleanup)if(!ids.has(x.resourceId)||!c.postSteps[x.postStep-1]?.includes(l.resources.find(r=>r.id===x.resourceId)?.identity??'\0'))issues.push('lifecycle_cleanup_unbound:'+x.id);
  for(const x of l.cleanup){const resource=l.resources.find(r=>r.id===x.resourceId);if(resource&&!namesIdentity(x.verified,resource.identity))issues.push('lifecycle_cleanup_evidence_unbound:'+x.id);}
  if(c.postSteps.some((_,i)=>!l.cleanup.some(x=>x.postStep===i+1)))issues.push('lifecycle_cleanup_unmapped');
  return issues;
}

/** One receipt per obligation, including interruptions. No model-supplied verification flags. */
export function lifecycleExecution(contract: Lifecycle | undefined, postSteps: string[], io: {
  check: (check: z.infer<typeof PrerequisiteCheckSchema>) => Promise<PrerequisiteReceipt>;
  resolve: (text:string)=>string;
  redact: (text:string)=>string;
  act: (text:string)=>Promise<void>;
  available: ()=>boolean;
}) {
  const receipt:LifecycleReceipt={version:1,status:'unknown',checks:[],cleanup:[],pendingResources:[],safeToRetry:true};
  const armed=new Set<string>(); let started=false,preparationStarted=false;
  const verify=async(id:string,phase:LifecycleReceipt['checks'][number]['phase'],check:z.infer<typeof PrerequisiteCheckSchema>,resourceId?:string)=>{
    let out:PrerequisiteReceipt;
    try{out=await io.check(check);}catch(e){out={statement:check.statement,status:'unknown',detail:io.redact(String(e instanceof Error?e.message:e))};}
    receipt.checks.push({...out,id,phase,resourceId});
    if(out.status!=='pass')receipt.status=out.status==='fail'?'fail':receipt.status==='fail'?'fail':'unknown';
    return out;
  };
  const identityCheck=(identity:string,absent=false)=>({statement:`${absent?'Absent':'Owned resource'}: ${identity}`,checks:[{kind:'screen' as const,statement:identity,oracle:{kind:absent?'noText' as const:'text' as const,value:identity}}]});
  return { receipt,
    async baseline(){
      for(const [i,check] of (contract?.baseline??[]).entries())if((await verify(`baseline-${i+1}`,'baseline',check)).status!=='pass')throw new Error('LIFECYCLE_BASELINE_NOT_VERIFIED');
      for(const r of contract?.resources??[])if((await verify(r.id,'baseline',identityCheck(r.identity,true),r.id)).status!=='pass')throw new Error('LIFECYCLE_RESOURCE_ALREADY_EXISTS');
      if(contract)receipt.status='pass';
    },
    beforePreparation(){preparationStarted=true;receipt.safeToRetry=false;},
    beforeStep(step:number){started=true;receipt.safeToRetry=contract?.mode==='read-only';for(const r of contract?.resources??[])if(r.establishAfterStep===step)armed.add(r.id);},
    async afterStep(step:number){
      for(const r of contract?.resources??[])if(r.establishAfterStep===step){
        if((await verify(r.id,'establish',r.established,r.id)).status!=='pass')throw new Error('LIFECYCLE_ESTABLISH_NOT_VERIFIED');
      }
    },
    async finish(){
      if(!contract){
        for(const [i,step] of postSteps.entries()){
          const item:LifecycleReceipt['cleanup'][number]={id:`legacy-${i+1}`,postStep:i+1,status:'not-run',detail:'Business actions did not start'};
          receipt.cleanup.push(item);
          if(!started)continue;
          if(!io.available()){item.detail='Session closed or execution cancelled';continue;}
          try{await io.act(step);item.status='unknown';item.detail='Cleanup action completed; legacy artifact has no verification oracle';}
          catch(e){item.status=io.available()?'fail':'unknown';item.detail=io.redact(String(e instanceof Error?e.message:e));if(item.status==='fail')receipt.status='fail';}
        }
        if(started&&postSteps.length)receipt.pendingResources.push({id:'legacy-unknown',identity:'unknown',reason:'Legacy cleanup outcome cannot be verified'});
        return receipt;
      }
      if(contract.mode==='read-only' && started)for(const [i,check] of contract.baseline.entries())await verify(`baseline-after-${i+1}`,'cleanup',check);
      const cleaned=new Set<string>();
      for(const x of contract.cleanup){
        const r=contract.resources.find(r=>r.id===x.resourceId)!;
        const item:LifecycleReceipt['cleanup'][number]={id:x.id,resourceId:x.resourceId,postStep:x.postStep,status:'not-run',detail:'Resource establishment was not attempted'};
        receipt.cleanup.push(item);
        if(!r || !armed.has(r.id))continue;
        if(!io.available()){item.detail='Session closed or execution cancelled';receipt.status=receipt.status==='fail'?'fail':'unknown';continue;}
        const identity=await verify(x.id,'ownership',identityCheck(r.identity),r.id);
        const ownership=identity.status==='pass'?await verify(x.id,'ownership',r.ownership,r.id):identity;
        if(ownership.status!=='pass'){item.status=ownership.status;item.detail='Resource ownership not verified; cleanup withheld';continue;}
        try{
          if(!io.available())throw new Error('Session closed or execution cancelled');
          await io.act(postSteps[x.postStep-1]!);
          const verdict=await verify(x.id,'cleanup',x.verified,r.id);
          item.status=verdict.status;item.detail=verdict.detail??verdict.statement;
          if(verdict.status==='pass')cleaned.add(x.id);
        }catch(e){item.status=io.available()?'fail':'unknown';item.detail=io.redact(String(e instanceof Error?e.message:e));receipt.status=item.status==='fail'?'fail':receipt.status==='fail'?'fail':'unknown';}
      }
      for(const r of contract.resources)if(armed.has(r.id)&&contract.cleanup.some(x=>x.resourceId===r.id&&!cleaned.has(x.id)))receipt.pendingResources.push({id:r.id,identity:io.resolve(r.identity),reason:'Required cleanup was not verified'});
      if(receipt.pendingResources.length&&receipt.status==='pass')receipt.status='unknown';
      // Even clean compensation cannot prove replaying business effects is safe.
      receipt.safeToRetry=(!started&&!preparationStarted) || (started&&contract.mode==='read-only'&&receipt.status==='pass');
      return receipt;
    },
  };
}
