import type { WorkflowRun } from '@/lib/workflowRuns';
/** Actual event recency, not graph position: retries must follow the restarted node. */
export function progressNode(run:Pick<WorkflowRun,'status'|'nodes'>):string {
  const recent=[...run.nodes].sort((a,b)=>b.at.localeCompare(a.at));
  if(['running','registered','queued'].includes(run.status)) {
    const active=recent.find(n=>n.phase==='running'||n.phase==='queued');
    if(active)return active.node;
  }
  if(run.status==='waiting_review'){const review=recent.find(n=>n.phase==='waiting_review');if(review)return review.node;}
  if(['failed','cancelled','interrupted'].includes(run.status)){const stopped=recent.find(n=>['failed','cancelled','blocked','running','queued'].includes(n.phase));if(stopped)return stopped.node;}
  return recent.find(n=>['done','failed','cancelled','waiting_review','running'].includes(n.phase))?.node
    ??recent.find(n=>n.phase!=='queued')?.node??recent[0]?.node??'source';
}
