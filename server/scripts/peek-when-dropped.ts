/** 只读：故事的验收准则里有 When，而认领它的用例一个真实动作都没有。 */
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
const NAV = /^\s*(打开|访问|导航|前往|进入|open|navigate|go to)/i;
const ACTION = /点击|单击|双击|按下|按住|长按|填入|填写|输入(?!框)|勾选|取消勾选|选择(?!器|框)|切换(?!器)|滚动|拖动|悬停|提交|上传|清空|click|tap|type|fill|enter|select|toggle|scroll|drag|hover|submit|upload|press/i;
const LOOK = /^\s*(查看|看一?下|观察|留意|注意|浏览|确认|验证|检查|断言|校验|读取|look|observe|inspect|view|assert|verify|ensure|check|confirm)/i;
const hasAction = (k: any) => (k.steps ?? []).some((s: string) => !NAV.test(s) && ACTION.test(s) && !LOOK.test(s));
// When 子句里有没有一个用户动作
const whenOf = (ac: string) => (/\/\s*When\s+([^/]+)/i.exec(ac) ?? /When\s+([^/]+)/i.exec(ac))?.[1]?.trim();
let whenAc = 0, dropped = 0; const shown: string[] = [];
for (const s of stories) {
  for (const ac of (s.acceptance ?? []) as string[]) {
    const w = whenOf(ac);
    if (!w || !ACTION.test(w)) continue;   // 这条准则本身没要求用户做动作
    whenAc++;
    const cs = b.cases.filter((k: any) => k.storyId === s.id && (k.acRefs ?? []).some((r: string) => String(r).slice(0, 40) === ac.slice(0, 40)));
    if (!cs.length || cs.every((k: any) => !hasAction(k))) {
      dropped++;
      if (shown.length < 6) shown.push(`【${s.id}】When ${w.slice(0, 52)}\n     认领它的用例：${cs.length ? cs.map((k: any) => `${k.id}「${k.title.slice(0, 22)}」steps=[${(k.steps ?? []).join(" | ").slice(0, 62)}]`).join("  ") : "（没有用例认领）"}`);
    }
  }
}
console.log(`验收准则里 **When 要求用户做一个动作** 的：${whenAc} 条`);
console.log(`其中被「一个真实动作都没有的用例」认领、或根本没人认领的：${dropped} 条\n`);
for (const x of shown) console.log("  " + x + "\n");
