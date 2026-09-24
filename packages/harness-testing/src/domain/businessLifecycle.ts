import {z} from 'zod';
/** Planning obligations, never a receipt that a state exists or an action is authorized. */
export const BusinessTransitionSchema=z.object({
 id:z.string().min(1), featureId:z.string().min(1), name:z.string().min(1),
 claimType:z.enum(['normative','hypothesis']), sourceRefs:z.array(z.string().min(1)).min(1),
 preconditions:z.array(z.string().min(1)).min(1), action:z.string().min(1), outcome:z.string().min(1),
 failureModes:z.array(z.string().min(1)).min(1),
 preparation:z.string().min(1),
}).strict();
export type BusinessTransition=z.infer<typeof BusinessTransitionSchema>;
