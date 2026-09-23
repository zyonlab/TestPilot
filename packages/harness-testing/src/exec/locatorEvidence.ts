import { createHash } from 'node:crypto';
import { z } from 'zod';

export const LocatorEvidenceSchema = z.object({
  capturedAt:z.string().datetime(), url:z.string().url(), stateDigest:z.string().min(1),
  label:z.string().min(1), region:z.string().min(1), role:z.string(), selector:z.string().min(1),
}).strict();
export type LocatorEvidence=z.infer<typeof LocatorEvidenceSchema>;
export type LocatorPage={evaluate:Function};

/** Same UI-only reader at collection and execution. Never retains field values or body text. */
export async function inspectLocator(page:LocatorPage,selector:string){
  const raw=await page.evaluate((sel:string)=>{
    const all=[...document.querySelectorAll('button,a,[role=button],[role=tab],[role=menuitem],input,select,textarea')];
    const controls=[];
    for(const el of all){
      const e=el as HTMLElement;
      if(!e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})||!e.getBoundingClientRect().width||!e.getBoundingClientRect().height)continue;
      // Input values and all numeric labels are omitted from structural state evidence.
      const label=(['INPUT','SELECT','TEXTAREA'].includes(e.tagName)?e.getAttribute('aria-label')??'':e.innerText??'').replace(/\s+/g,' ').trim();
      controls.push([e.tagName,e.id,e.getAttribute('role'),/\d/.test(label)?'':label.slice(0,120),e.getAttribute('aria-selected'),e.getAttribute('aria-expanded'),e.getAttribute('aria-disabled'),e.hasAttribute('disabled')]);
    }
    const structure=[];
    for(const el of document.querySelectorAll('main,section,dialog,[hidden],[aria-hidden],[role=dialog],[role=tabpanel]')){const e=el as HTMLElement;structure.push([e.tagName,e.id,e.getAttribute('role'),e.hidden,e.getAttribute('aria-hidden'),e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})]);}
    const hits=[...document.querySelectorAll(sel)];
    if(hits.length!==1)return {count:hits.length,reason:'not_unique'};
    const e=hits[0] as HTMLElement;
    const label=(e.innerText||e.getAttribute('aria-label')||'').replace(/\s+/g,' ').trim();
    const r=e.getBoundingClientRect();
    const visible=e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})&&r.width>0&&r.height>0;
    const enabled=!e.matches(':disabled,[disabled],[aria-disabled=true]')&&!e.closest('[inert],[aria-disabled=true]');
    const center=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
    const actionable=visible&&enabled&&!!center&&(center===e||e.contains(center))&&getComputedStyle(e).pointerEvents!=='none';
    const region=[];
    for(let n=e.parentElement;n;n=n.parentElement){
      region.push([n.tagName,n.id,n.getAttribute('role')??'',(n.getAttribute('aria-label')??'').replace(/\d+/g,'#'),Array.prototype.indexOf.call(n.parentElement?.children??[],n)].join(':'));
    }
    return {count:1,visible,enabled,actionable,label,role:e.getAttribute('role')||e.tagName.toLowerCase(),region:region.join('/'),url:location.href,controls:[controls,structure]};
  },selector) as {count:number;reason?:string;visible?:boolean;enabled?:boolean;actionable?:boolean;label?:string;role?:string;region?:string;url?:string;controls?:unknown[]};
  const reason=raw.reason??(!raw.visible?'hidden':!raw.enabled?'disabled':!raw.actionable?'not_actionable':!raw.label||/\d/.test(raw.label)?'identity_unknown':undefined);
  if(reason)return {ok:false as const,reason};
  return {ok:true as const,evidence:LocatorEvidenceSchema.parse({capturedAt:new Date().toISOString(),selector,label:raw.label,role:raw.role,region:raw.region,url:raw.url,stateDigest:createHash('sha256').update(JSON.stringify(raw.controls)).digest('hex')})};
}
