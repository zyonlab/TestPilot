/** 只读：用例与用户故事的对齐度——步数、有没有 When、验收准则覆盖。 */
import { config } from "dotenv";
import { join, resolve } from "node:path";
config({ path: join(resolve(import.meta.dirname, "../.."), "server/.env"), quiet: true } as never);
const { runLedger } = await import("../src/runService.js");
const { approvedExecutionBundle } = await import("../src/approvedRuns.js");
const l = runLedger();
const [runId, projectId, codeRevision] = process.argv.slice(2);
const b = approvedExecutionBundle(runId!, projectId!, codeRevision!) as any;
const st = l.readRevision(l.listRevisions(projectId!, runId!).filter((r: any) => r.name === "validated/stories").at(-1)!.id, projectId!).content as any;
const stories: any[] = st.stories ?? st;
const byId = new Map(stories.map((s) => [s.id, s]));

const NAV = /^\s*(打开|访问|导航|前往|进入|open|navigate|go to)/i;
const ACTION = /点击|单击|双击|按下|按住|长按|填入|填写|输入(?!框)|勾选|取消勾选|选择(?!器|框)|切换(?!器)|滚动|拖动|悬停|提交|上传|清空|click|tap|type|fill|enter|select|toggle|scroll|drag|hover|submit|upload|press/i;
const LOOK = /^\s*(查看|看一?下|观察|留意|注意|浏览|确认|验证|检查|断言|校验|look|observe|inspect|view|assert|verify|ensure|check|confirm)/i;

const dist = new Map<number, number>();
let noWhen = 0, navOnly = 0;
const offenders: string[] = [];
for (const k of b.cases) {
  const steps: string[] = k.steps ?? [];
  dist.set(steps.length, (dist.get(steps.length) ?? 0) + 1);
  const real = steps.filter((s) => !NAV.test(s) && ACTION.test(s) && !LOOK.test(s));
  if (!real.length) {
    noWhen++;
    if (steps.every((s) => NAV.test(s) || LOOK.test(s))) navOnly++;
    if (offenders.length < 14) offenders.push(`${k.id} [${k.scenarioType}/${k.designMethod}] ${k.title.slice(0, 30)} :: ${steps.join(" | ").slice(0, 78)}`);
  }
}
console.log("步数分布:", JSON.stringify([...dist].sort((a, z) => a[0] - z[0])));
console.log(`81 条里 **没有一个真实动作**（只有导航和看）的：${noWhen} 条，其中纯「打开+看」${navOnly} 条`);
for (const o of offenders) console.log("  " + o);

// 故事侧：每条故事几条用例，验收准则被 acRefs 认领了几条
let acTotal = 0, acCovered = 0, storiesWithNoCase = 0;
const perStory: number[] = [];
for (const s of stories) {
  const cs = b.cases.filter((k: any) => k.storyId === s.id);
  perStory.push(cs.length);
  if (!cs.length) storiesWithNoCase++;
  const acs: string[] = s.acceptance ?? [];
  acTotal += acs.length;
  const claimed = new Set(cs.flatMap((k: any) => k.acRefs ?? []));
  acCovered += acs.filter((a) => [...claimed].some((c) => String(c).slice(0, 40) === a.slice(0, 40) || String(c) === a)).length;
}
perStory.sort((a, z) => a - z);
console.log(`\n${stories.length} 条故事 / ${b.cases.length} 条用例：每条故事 ${(b.cases.length / stories.length).toFixed(2)} 条用例（最少 ${perStory[0]}，中位 ${perStory[Math.floor(perStory.length / 2)]}，最多 ${perStory.at(-1)}），一条用例都没有的故事 ${storiesWithNoCase} 条`);
console.log(`验收准则 ${acTotal} 条，被 acRefs 逐字认领的 ${acCovered} 条`);
