import {z} from 'zod';
/** Planning obligations, never a receipt that a state exists or an action is authorized. */
export const BusinessTransitionSchema=z.object({
 id:z.string().min(1), featureId:z.string().min(1), name:z.string().min(1),
 claimType:z.enum(['normative','hypothesis']), sourceRefs:z.array(z.string().min(1)).min(1),
 preconditions:z.array(z.string().min(1)).min(1), action:z.string().min(1), outcome:z.string().min(1),
 failureModes:z.array(z.string().min(1)).min(1),
 preparation:z.string().min(1),
 /**
  * 状态衔接（2026-09-24）：这个转换成功之前需要哪些业务状态、成功之后产出哪些。
  * 状态 id 在规则包的 states 里声明。「平仓要先有持仓」这种链由此可算，而不是写在自由文本里。
  * 可选且没有默认值：不写就不进规则包哈希，旧规则包的哈希不变。
  */
 requiresStates:z.array(z.string().min(1)).max(10).optional(),
 producesStates:z.array(z.string().min(1)).max(10).optional(),
}).strict();
/** 规则包声明的业务状态：它是什么种类，决定用例怎么建立、怎么收拾它（见 Lifecycle v2）。 */
export const BusinessStateSchema=z.object({
 id:z.string().min(1), name:z.string().min(1),
 kind:z.enum(['resource','setting','session']),
 /** resource 在屏幕上怎么认出来：generated 名字 / attribute 本次选定的可见值 / slot 每个键最多一个。 */
 identity:z.enum(['generated','attribute','slot']).optional(),
 description:z.string().min(1).optional(),
}).strict();
export type BusinessState=z.infer<typeof BusinessStateSchema>;
export type BusinessTransition=z.infer<typeof BusinessTransitionSchema>;
