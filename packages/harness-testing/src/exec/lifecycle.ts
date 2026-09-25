import { z } from 'zod';
import { PrerequisiteCheckSchema, type PrerequisiteReceipt } from './preparationChecks.js';

/** Reviewed obligations, not a second setup-script language. Actions remain in steps/postSteps. */
const evidence = PrerequisiteCheckSchema.refine(c => c.checks.every(p => p.kind === 'screen' && !!p.oracle), 'Lifecycle evidence must be deterministic and on screen');
const base = {
  mode: z.enum(['read-only', 'controlled']),
  rationale: z.string().min(1),
  sourceRefs: z.array(z.string().min(1)).min(1),
  supports: z.array(z.string().min(1)).min(1),
  baseline: z.array(evidence).min(1),
};
const LifecycleV1Schema = z.object({
  version: z.literal(1), ...base,
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
/**
 * v2（2026-09-24）：v1 只会「新建一条带运行标签的记录，再删掉」——增删改查应用的形状。
 * 交易类 SPA 的状态大多不是这样：持久设置（原值→新值→还原）、每个键只有一个的格位（按市场的持仓）、
 * 屏幕上不显示自定义标签的实体（只能靠一个本次选定的可见属性值认出来）、会话变化、不可逆副作用。
 * 领域事实（哪些设置会保存、什么是格位）来自项目材料/规则包；这里只有通用机制。
 */
const ResourceV2Schema = z.object({
  id: z.string().min(1), sourceRef: z.string().min(1),
  /** generated：标识含 ${env.TP_LIFECYCLE_ID}；attribute：标识含一个 ${env.*} 变量，准备阶段绑定成屏幕上可见的唯一值；slot：标识是格位键，靠 vacant 证明空位。 */
  identityKind: z.enum(['generated', 'attribute', 'slot']),
  identity: z.string().min(1),
  establishAfterStep: z.number().int().positive(),
  established: evidence,
  ownership: evidence,
  vacant: evidence.optional(),
  /**
   * 用例自己的哪一步把它拿掉（撤单、平仓就是被测动作的那种）。那一步跑完核对它确实不在了，收尾就不再动它；
   * 没跑到那一步，照常补偿。2026-09-25：「下单→撤单」用例收尾前先找挂单，找不到就当「归属未核实」，永远过不了。
   */
  releasedByStep: z.number().int().positive().optional(),
}).strict().superRefine((r, ctx) => {
  if (r.identityKind === 'generated' && !r.identity.includes('${env.TP_LIFECYCLE_ID}')) ctx.addIssue({ code: 'custom', path: ['identity'], message: 'generated identity must contain ${env.TP_LIFECYCLE_ID}' });
  if (r.identityKind === 'attribute' && !/\$\{env\.[A-Z0-9_]+\}/.test(r.identity)) ctx.addIssue({ code: 'custom', path: ['identity'], message: 'attribute identity must contain a ${env.*} value bound by preparation' });
  if (r.releasedByStep !== undefined && r.releasedByStep <= r.establishAfterStep) ctx.addIssue({ code: 'custom', path: ['releasedByStep'], message: 'releasedByStep must come after establishAfterStep' });
  if (r.identityKind === 'slot' && !r.vacant) ctx.addIssue({ code: 'custom', path: ['vacant'], message: 'slot resources must prove the slot is vacant' });
});
const SettingV2Schema = z.object({
  id: z.string().min(1), sourceRef: z.string().min(1),
  /** 屏幕上的设置名与作用范围，例如「某市场的杠杆」。 */
  name: z.string().min(1),
  /** 执行前应显示的原值；还原步骤与还原判据都要写出它。 */
  original: z.string().min(1),
  changedAfterStep: z.number().int().positive(),
  /** 执行前屏幕显示原值的判据。 */
  observed: evidence,
}).strict();
const LifecycleV2Schema = z.object({
  version: z.literal(2), ...base,
  /** changed：用例改了会话（断开钱包、切网络、登出）；执行器用完就丢弃这个浏览器，不留给下一条用例。 */
  session: z.enum(['unchanged', 'changed']).default('unchanged'),
  resources: z.array(ResourceV2Schema).max(20).default([]),
  settings: z.array(SettingV2Schema).max(20).default([]),
  cleanup: z.array(z.object({
    id: z.string().min(1), resourceId: z.string().min(1).optional(), settingId: z.string().min(1).optional(),
    postStep: z.number().int().positive(), verified: evidence,
  }).strict().refine(x => !!x.resourceId !== !!x.settingId, 'cleanup names exactly one resourceId or settingId')).max(30).default([]),
  /** 不可逆、无法补偿的副作用（手续费等），只声明；判据不能要求它们还原。 */
  sideEffects: z.array(z.string().min(1)).max(10).default([]),
}).strict();
export const LifecycleSchema = z.discriminatedUnion('version', [LifecycleV1Schema, LifecycleV2Schema]);
export type Lifecycle = z.infer<typeof LifecycleSchema>;
export type LifecycleV2 = z.infer<typeof LifecycleV2Schema>;
/** v1 是 v2 的特例：全部资源都是 generated，没有设置，会话不变。逻辑只写一份。 */
export function normalizeLifecycle(l: Lifecycle): LifecycleV2 {
  if (l.version === 2) return { ...l, session: l.session ?? 'unchanged', resources: l.resources ?? [], settings: l.settings ?? [], cleanup: l.cleanup ?? [], sideEffects: l.sideEffects ?? [] };
  return { ...l, version: 2, session: 'unchanged', settings: [], sideEffects: [], resources: l.resources.map(r => ({ ...r, identityKind: 'generated' as const })), cleanup: l.cleanup.map(x => ({ ...x })) };
}
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
export function unavailableLifecycle(raw?:Lifecycle,postSteps:string[]=[]):LifecycleReceipt {
  const contract=raw?normalizeLifecycle(raw):undefined;
  return {version:1,status:'unknown',safeToRetry:false,checks:[],cleanup:(contract?.cleanup??postSteps.map((_,i)=>({id:`legacy-${i+1}`,postStep:i+1}))).map(x=>({...x,status:'not-run',detail:'Runner receipt unavailable; cleanup execution unknown'})),pendingResources:contract?.resources.map(r=>({id:r.id,identity:r.identity,reason:'Runner receipt unavailable; establishment and cleanup unknown'}))??(postSteps.length?[{id:'legacy-unknown',identity:'unknown',reason:'Runner receipt unavailable'}]:[])};
}
/** 这份契约有没有把义务钉在具体步骤上（建立步骤、改设置的步骤、清理步骤）。只读契约没有。 */
export function lifecycleBindsActions(raw: Lifecycle): boolean {
  const l = normalizeLifecycle(raw);
  return l.resources.length > 0 || l.settings.length > 0 || l.cleanup.length > 0;
}

/**
 * 修复单要能照着改：只给一个代码，模型只能猜（2026-09-24 实测 84/84 被点到，同一个毛病）。
 * 门禁与单元修复都用这张表把代码翻成「改哪里、写什么」。
 */
export const LIFECYCLE_ISSUE_HINTS: Record<string, string> = {
  lifecycle_unknown: 'add a lifecycle object (version 2); a case without one cannot be admitted',
  lifecycle_duplicate_id: 'resource, setting and cleanup ids must be unique, one cleanup per postStep',
  lifecycle_source_unbound: 'lifecycle.sourceRefs and each resource/setting sourceRef must be among the case sourceRefs',
  lifecycle_assertion_unbound: 'supports may only name $expected or ids of this case\'s assertions',
  lifecycle_precondition_unbound: 'every precondition string needs a baseline entry whose statement is exactly that string',
  lifecycle_readonly_mutation: 'read-only cases have empty postSteps, resources, settings and cleanup; UI-only state (tabs, panels, typed input) needs no undo because every case starts on a fresh page, and session changes are declared with session:"changed" instead of a postStep; if the case really changes a persisted setting or creates something, use mode controlled',
  lifecycle_resources_missing: 'a controlled case declares at least one resource or setting it changes',
  lifecycle_establish_unbound: 'the step at establishAfterStep must contain the resource identity text exactly',
  lifecycle_release_unbound: 'releasedByStep must be a real step after establishment that contains the resource identity text exactly',
  lifecycle_compensation_missing: 'every resource and every setting needs a cleanup entry whose postStep undoes it',
  lifecycle_ownership_unbound: 'for generated/attribute identities the ownership screen check oracle must contain the identity text',
  lifecycle_establish_evidence_unbound: 'for generated/attribute identities the established screen check oracle must contain the identity text',
  lifecycle_cleanup_unbound: 'the cleanup postStep must contain the resource identity (or the setting\'s original value) exactly',
  lifecycle_cleanup_evidence_unbound: 'for generated/attribute identities, and for settings, the cleanup verified oracle must contain the identity (or the original value)',
  lifecycle_setting_unbound: 'the setting observed check oracle must contain the original value, and changedAfterStep must be a real step',
  lifecycle_cleanup_unmapped: 'every postStep must be referenced by exactly one cleanup entry; postSteps that only restore UI state should be removed',
};
export const lifecycleIssueHint = (issue: string): string => LIFECYCLE_ISSUE_HINTS[issue.split(':')[0]!] ?? issue;

export function lifecycleIssues(c: {lifecycle?: Lifecycle; steps: string[]; postSteps?: string[]; precondition?:string[]; sourceRefs?: string[]; assertions?:Array<{id:string}>}): string[] {
  if(!c.lifecycle)return ['lifecycle_unknown'];
  const l=normalizeLifecycle(c.lifecycle),postSteps=c.postSteps??[];
  const issues:string[]=[];
  const ids=new Set(l.resources.map(r=>r.id)),settingIds=new Set(l.settings.map(s=>s.id));
  if(ids.size!==l.resources.length||settingIds.size!==l.settings.length||[...ids].some(id=>settingIds.has(id))||new Set(l.resources.map(r=>r.identity)).size!==l.resources.length||new Set(l.cleanup.map(r=>r.id)).size!==l.cleanup.length||new Set(l.cleanup.map(r=>r.postStep)).size!==l.cleanup.length)issues.push('lifecycle_duplicate_id');
  if(l.sourceRefs.some(ref=>!c.sourceRefs?.includes(ref))||[...l.resources,...l.settings].some(r=>!l.sourceRefs.includes(r.sourceRef)))issues.push('lifecycle_source_unbound');
  if(l.supports.some(id=>id!=='$expected'&&!c.assertions?.some(a=>a.id===id)))issues.push('lifecycle_assertion_unbound');
  if(c.precondition?.some(p=>!l.baseline.some(b=>b.statement===p)))issues.push('lifecycle_precondition_unbound');
  const names=(check:z.infer<typeof PrerequisiteCheckSchema>,text:string)=>check.checks.some(p=>p.kind==='screen'&&p.oracle&&JSON.stringify(p.oracle).includes(JSON.stringify(text).slice(1,-1)));
  if(l.mode==='read-only'&&(l.resources.length||l.settings.length||l.cleanup.length||postSteps.length))issues.push('lifecycle_readonly_mutation');
  if(l.mode==='controlled'&&!l.resources.length&&!l.settings.length)issues.push('lifecycle_resources_missing');
  for(const r of l.resources){
    const bound=r.identityKind!=='slot';
    if(r.establishAfterStep>c.steps.length||!c.steps[r.establishAfterStep-1]?.includes(r.identity))issues.push('lifecycle_establish_unbound:'+r.id);
    if(r.releasedByStep!==undefined&&(r.releasedByStep>c.steps.length||!c.steps[r.releasedByStep-1]?.includes(r.identity)))issues.push('lifecycle_release_unbound:'+r.id);
    if(!l.cleanup.some(x=>x.resourceId===r.id))issues.push('lifecycle_compensation_missing:'+r.id);
    // Ownership may include project account details, but must also name this execution's resource.
    if(bound&&!names(r.ownership,r.identity))issues.push('lifecycle_ownership_unbound:'+r.id);
    if(bound&&!names(r.established,r.identity))issues.push('lifecycle_establish_evidence_unbound:'+r.id);
  }
  for(const s of l.settings){
    if(s.changedAfterStep>c.steps.length||!names(s.observed,s.original))issues.push('lifecycle_setting_unbound:'+s.id);
    if(!l.cleanup.some(x=>x.settingId===s.id))issues.push('lifecycle_compensation_missing:'+s.id);
  }
  for(const x of l.cleanup){
    const r=x.resourceId?l.resources.find(r=>r.id===x.resourceId):undefined,s=x.settingId?l.settings.find(s=>s.id===x.settingId):undefined;
    const key=r?.identity??s?.original;
    if(!key||!postSteps[x.postStep-1]?.includes(key))issues.push('lifecycle_cleanup_unbound:'+x.id);
    if(key&&(s||r?.identityKind!=='slot')&&!names(x.verified,key))issues.push('lifecycle_cleanup_evidence_unbound:'+x.id);
  }
  if(postSteps.some((_,i)=>!l.cleanup.some(x=>x.postStep===i+1)))issues.push('lifecycle_cleanup_unmapped');
  return issues;
}

/** One receipt per obligation, including interruptions. No model-supplied verification flags. */
export function lifecycleExecution(raw: Lifecycle | undefined, postSteps: string[], io: {
  check: (check: z.infer<typeof PrerequisiteCheckSchema>) => Promise<PrerequisiteReceipt>;
  resolve: (text:string)=>string;
  redact: (text:string)=>string;
  act: (text:string)=>Promise<void>;
  available: ()=>boolean;
  /** 重新打开入口页（读回持久状态、丢掉界面临时状态）；没有就在当前页复核。 */
  reopen?: ()=>Promise<void>;
}) {
  const contract=raw?normalizeLifecycle(raw):undefined;
  const receipt:LifecycleReceipt={version:1,status:'unknown',checks:[],cleanup:[],pendingResources:[],safeToRetry:true};
  const armed=new Set<string>(),released=new Set<string>(); let started=false,preparationStarted=false;
  const verify=async(id:string,phase:LifecycleReceipt['checks'][number]['phase'],check:z.infer<typeof PrerequisiteCheckSchema>,resourceId?:string)=>{
    let out:PrerequisiteReceipt;
    try{out=await io.check(check);}catch(e){out={statement:check.statement,status:'unknown',detail:io.redact(String(e instanceof Error?e.message:e))};}
    receipt.checks.push({...out,id,phase,resourceId});
    if(out.status!=='pass')receipt.status=out.status==='fail'?'fail':receipt.status==='fail'?'fail':'unknown';
    return out;
  };
  const identityCheck=(identity:string,absent=false)=>({statement:`${absent?'Absent':'Owned resource'}: ${identity}`,checks:[{kind:'screen' as const,statement:identity,oracle:{kind:absent?'noText' as const:'text' as const,value:identity}}]});
  return { receipt,
    /** 会话被改过的用例，执行器用完就丢掉浏览器。 */
    sessionChanged: contract?.session==='changed',
    async baseline(){
      for(const [i,check] of (contract?.baseline??[]).entries())if((await verify(`baseline-${i+1}`,'baseline',check)).status!=='pass')throw new Error('LIFECYCLE_BASELINE_NOT_VERIFIED');
      for(const r of contract?.resources??[]){
        // 格位：屏幕上到处都有格位键（比如市场名），「标识不存在」没有意义；要的是「这个格位现在是空的」。
        if(r.identityKind==='slot'){if((await verify(r.id,'baseline',r.vacant!,r.id)).status!=='pass')throw new Error('LIFECYCLE_SLOT_OCCUPIED');}
        else if((await verify(r.id,'baseline',identityCheck(r.identity,true),r.id)).status!=='pass')throw new Error('LIFECYCLE_RESOURCE_ALREADY_EXISTS');
      }
      if(contract)receipt.status='pass';
    },
    /**
     * 设置的原值在**改它的那一步之前**核对，不在入口页一次查完（2026-09-25：某市场的保证金模式在另一个市场的入口页上
     * 根本不显示，先切市场再改模式的用例在基线就失败）。核对不过就不做这一步，也不会去还原一个没改过的设置。
     */
    async beforeAction(step:number){
      for(const s of contract?.settings??[])if(s.changedAfterStep===step&&(await verify(s.id,'baseline',s.observed,s.id)).status!=='pass')throw new Error('LIFECYCLE_SETTING_BASELINE_NOT_VERIFIED');
    },
    beforePreparation(){preparationStarted=true;receipt.safeToRetry=false;},
    beforeStep(step:number){started=true;receipt.safeToRetry=contract?.mode==='read-only';
      for(const r of contract?.resources??[])if(r.establishAfterStep===step)armed.add(r.id);
      for(const s of contract?.settings??[])if(s.changedAfterStep===step)armed.add(s.id);},
    async afterStep(step:number){
      for(const r of contract?.resources??[])if(r.establishAfterStep===step){
        if((await verify(r.id,'establish',r.established,r.id)).status!=='pass')throw new Error('LIFECYCLE_ESTABLISH_NOT_VERIFIED');
      }
      // 用例自己拿掉了它：核对确实不在了才算释放；不在的证据不成立就留给收尾照常补偿。
      for(const r of contract?.resources??[])if(r.releasedByStep===step&&armed.has(r.id)){
        const gone=r.identityKind==='slot'?r.vacant!:identityCheck(r.identity,true);
        if((await verify(r.id,'cleanup',gone,r.id)).status==='pass')released.add(r.id);
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
      /**
       * 只读用例跑完复核基线，查的是「有没有改到会保存的东西」。先重新打开入口页：会保存的状态刷新后还在，
       * 切 Tab、选订单类型这类界面临时状态不在——v2 明说后者不用还原（2026-09-25：C-ORD-01-01 切到 Limit 后
       * 在当前页复核「处于 Market」失败，而那正是用例本身的效果）。打不开入口页就照旧在当前页复核。
       */
      if(contract.mode==='read-only' && started){
        if(io.reopen && io.available()){try{await io.reopen();}catch{/* 复核照旧在当前页做；失败会记在复核结果里 */}}
        for(const [i,check] of contract.baseline.entries())await verify(`baseline-after-${i+1}`,'cleanup',check);
      }
      const cleaned=new Set<string>();
      for(const x of contract.cleanup){
        const r=x.resourceId?contract.resources.find(r=>r.id===x.resourceId):undefined;
        const s=x.settingId?contract.settings.find(s=>s.id===x.settingId):undefined;
        const target=r??s,targetId=target?.id;
        const item:LifecycleReceipt['cleanup'][number]={id:x.id,resourceId:targetId,postStep:x.postStep,status:'not-run',detail:r?'Resource establishment was not attempted':'Setting change was not attempted'};
        receipt.cleanup.push(item);
        if(!target || !armed.has(target.id))continue;
        if(r&&released.has(r.id)){item.status='pass';item.detail=`Released by step ${r.releasedByStep}; absence verified`;cleaned.add(x.id);continue;}
        if(!io.available()){item.detail='Session closed or execution cancelled';receipt.status=receipt.status==='fail'?'fail':'unknown';continue;}
        if(r){
          // 格位没有可在屏幕上认出的本次标识，只核对归属（账户/上下文）；其余先认出本次的资源再动手。
          const identity=r.identityKind==='slot'?undefined:await verify(x.id,'ownership',identityCheck(r.identity),r.id);
          const ownership=!identity||identity.status==='pass'?await verify(x.id,'ownership',r.ownership,r.id):identity;
          if(ownership.status!=='pass'){item.status=ownership.status;item.detail='Resource ownership not verified; cleanup withheld';continue;}
        }
        try{
          if(!io.available())throw new Error('Session closed or execution cancelled');
          await io.act(postSteps[x.postStep-1]!);
          const verdict=await verify(x.id,'cleanup',x.verified,target.id);
          item.status=verdict.status;item.detail=verdict.detail??verdict.statement;
          if(verdict.status==='pass')cleaned.add(x.id);
        }catch(e){item.status=io.available()?'fail':'unknown';item.detail=io.redact(String(e instanceof Error?e.message:e));receipt.status=item.status==='fail'?'fail':receipt.status==='fail'?'fail':'unknown';}
      }
      for(const r of contract.resources)if(armed.has(r.id)&&contract.cleanup.some(x=>x.resourceId===r.id&&!cleaned.has(x.id)))receipt.pendingResources.push({id:r.id,identity:io.resolve(r.identity),reason:'Required cleanup was not verified'});
      for(const s of contract.settings)if(armed.has(s.id)&&contract.cleanup.some(x=>x.settingId===s.id&&!cleaned.has(x.id)))receipt.pendingResources.push({id:s.id,identity:`${s.name} = ${io.resolve(s.original)}`,reason:'Setting was not verified as restored'});
      if(receipt.pendingResources.length&&receipt.status==='pass')receipt.status='unknown';
      // Even clean compensation cannot prove replaying business effects is safe.
      receipt.safeToRetry=(!started&&!preparationStarted) || (started&&contract.mode==='read-only'&&receipt.status==='pass');
      return receipt;
    },
  };
}
