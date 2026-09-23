import type {Revision} from '@/lib/workflowRuns';
type Loaded={revision:Revision;content:any};
export function nodeKnowledge(node:string,all:Revision[],loaded:Loaded[],started:boolean){
 const found=new Map<string,Set<string>>();
 const add=(id:string,via:string)=>{if(!all.some(r=>r.id===id&&r.name.startsWith('knowledge/')))return;const s=found.get(id)??new Set<string>();s.add(via);found.set(id,s);};
 for(const {revision:r,content:c} of loaded){
  if(r.name==='context/'+node||r.name.startsWith('context/'+node+'/')){
   (c.knowledge??[]).forEach((k:any)=>add(k.revision,'direct'));
  }
  if(r.name==='validated/instructions'&&started&&['modules','stories','cases','gate'].includes(node)){
   const scope=c.runScope??{};
   if(Array.isArray(scope.knowledgeRefs))scope.knowledgeRefs.forEach((id:string)=>add(id,'shared'));
   else {
    // Old instruction snapshots contain text/id/version, but no revision ids.
    const candidates=loaded.filter(k=>k.revision.name.startsWith('knowledge/')&&k.revision.createdAt<=r.createdAt);
    const latest=(items:Loaded[])=>items.sort((a,b)=>b.revision.revision-a.revision.revision)[0];
    if(scope.domainReference){const hit=latest(candidates.filter(k=>k.content.text===scope.domainReference));if(hit)add(hit.revision.id,'sharedLegacy');}
    if(scope.rulePack){const hit=latest(candidates.filter(k=>k.content.rulePack?.id===scope.rulePack.id&&k.content.rulePack?.version===scope.rulePack.version));if(hit)add(hit.revision.id,'sharedLegacy');}
   }
  }
 }
 return [...found].map(([id,sources])=>({id,sources:[...sources]}));
}
