import { createHash } from 'node:crypto';
import { z } from 'zod';

export const sha = (value: string) => createHash('sha256').update(value).digest('hex');
export const TaskSchema = z.object({id:z.string().regex(/^[a-z]+$/),split:z.enum(['dev','validation']),family:z.string(),title:z.string(),buttons:z.tuple([z.string(),z.string()]),initial:z.string(),intermediate:z.string(),final:z.string()});
export type Task = z.infer<typeof TaskSchema>;
export const PlanSchema = z.object({id:z.string(),title:z.string().min(1),steps:z.array(z.object({text:z.string()})).length(2),expected:z.string(),oracle:z.object({kind:z.literal('text'),value:z.string()}),assertions:z.array(z.object({statement:z.string(),afterStep:z.number().int().min(1).max(2),oracle:z.object({kind:z.literal('text'),value:z.string()})})).min(1).max(4)});
export type Plan = z.infer<typeof PlanSchema>;
const textOracle={type:'object',properties:{kind:{const:'text'},value:{type:'string'}},required:['kind','value'],additionalProperties:false};
export const GenerationSchema={type:'object',properties:{cases:{type:'array',minItems:4,maxItems:4,items:{type:'object',properties:{id:{type:'string'},title:{type:'string'},steps:{type:'array',minItems:2,maxItems:2,items:{type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false}},expected:{type:'string'},oracle:textOracle,assertions:{type:'array',minItems:1,maxItems:4,items:{type:'object',properties:{statement:{type:'string'},afterStep:{type:'integer',minimum:1,maximum:2},oracle:textOracle},required:['statement','afterStep','oracle'],additionalProperties:false}}},required:['id','title','steps','expected','oracle','assertions'],additionalProperties:false}}},required:['cases'],additionalProperties:false};
export type Trial = {taskId:string;split:string;family:string;arm:'baseline'|'candidate';variant:'healthy'|'intermediate'|'final';repeat:number;status:'passed'|'failed'|'unobservable';ms:number;actions:number;error?:string;evidence:string};

/** Invalid or missing execution is never a defect kill. Replicates are stability checks, not independent tasks. */
export function summarize(trials:Trial[], tasks:Task[]) {
  const arm = (name:Trial['arm'], split?:string) => {
    const rows=trials.filter(t=>t.arm===name&&(!split||t.split===split));
    const healthy=rows.filter(t=>t.variant==='healthy');
    const graded=rows.filter(t=>t.variant!=='healthy'&&t.status!=='unobservable'&&healthy.some(h=>h.taskId===t.taskId&&h.repeat===t.repeat&&h.status==='passed'));
    const expectedFaults=tasks.filter(t=>!split||t.split===split).length*2;
    const kills=new Set(graded.filter(t=>t.status==='failed').map(t=>t.taskId+':'+t.variant));
    const stableKills=[...kills].filter(key=>{const rs=rows.filter(t=>t.taskId+':'+t.variant===key);return rs.length===3&&rs.every(t=>t.status==='failed')&&healthy.filter(t=>t.taskId===rs[0].taskId).every(t=>t.status==='passed');});
    const unstable=tasks.filter(t=>!split||t.split===split).flatMap(t=>['healthy','intermediate','final'].map(v=>rows.filter(r=>r.taskId===t.id&&r.variant===v))).filter(rs=>new Set(rs.map(r=>r.status)).size>1).length;
    return {trials:rows.length,healthy:healthy.length,falseAlarms:healthy.filter(t=>t.status==='failed').length,unobservable:rows.filter(t=>t.status==='unobservable').length,stableKills:stableKills.length,stableKeys:stableKills.sort(),expectedFaults,mutationScore:expectedFaults?stableKills.length/expectedFaults:null,unstable,ms:rows.reduce((n,t)=>n+t.ms,0)};
  };
  const baseline=arm('baseline'),candidate=arm('candidate');
  const complete=trials.length===tasks.length*2*3*3&&tasks.every(task=>['baseline','candidate'].every(a=>['healthy','intermediate','final'].every(v=>[0,1,2].every(r=>trials.filter(t=>t.taskId===task.id&&t.arm===a&&t.variant===v&&t.repeat===r).length===1))));
  const lostDefects=baseline.stableKeys.filter(key=>!candidate.stableKeys.includes(key));
  const improved=lostDefects.length===0&&complete&&baseline.unobservable===0&&candidate.unobservable===0&&candidate.falseAlarms===0&&candidate.unstable===0&&candidate.stableKills>baseline.stableKills;
  return {baseline,candidate,dev:{baseline:arm('baseline','dev'),candidate:arm('candidate','dev')},validation:{baseline:arm('baseline','validation'),candidate:arm('candidate','validation')},complete,decision:improved?'bounded-improvement':'insufficient-evidence',scope:'Exporter assertion preservation only; not model generation quality, native-host parity, or generalization.',taskVariants:tasks.length,families:new Set(tasks.map(t=>t.family)).size,lostDefects,replicates:3};
}

export function validatePlan(raw:unknown, task:Task):Plan {
  const plan=PlanSchema.parse(raw);
  if(plan.id!==task.id||plan.expected!==task.final||plan.steps.some((s,i)=>s.text!==`Click ${task.buttons[i]}`)||plan.oracle.value!==task.final||!plan.assertions.some(a=>a.afterStep===1&&a.oracle.value===task.intermediate))throw new Error('generation_contract_mismatch:'+task.id);
  return plan;
}
