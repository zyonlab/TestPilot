/** 只读：改写 When 与「用例没有真实动作」是不是同一件事。 */
import { config } from "dotenv";
import { join, resolve } from "node:path";
config({ path: join(resolve(import.meta.dirname, "../.."), "server/.env"), quiet: true } as never);
const { runLedger } = await import("../src/runService.js");
const { approvedExecutionBundle } = await import("../src/approvedRuns.js");
const l = runLedger();
const [runId, projectId, codeRevision] = process.argv.slice(2);
const b = approvedExecutionBundle(runId!, projectId!, codeRevision!) as any;
const st = l.readRevision(l.listRevisions(projectId!, runId!).filter((r: any) => r.name === "validated/stories").at(-1)!.id, projectId!).content as any;
const byId = new Map((st.stories ?? st).map((s: any) => [s.id, s]));
const norm = (x: string) => x.replace(/[\s“”"'（）()、,，。.]/g, "");
const whenOf = (ac: string) => (/When\s*([^/]+)/i.exec(ac))?.[1]?.trim() ?? "";
const NAV = /^\s*(打开|访问|导航|前往|进入|open|navigate|go to)/i;
const ACTION = /点击|单击|双击|按下|按住|长按|填入|填写|输入(?!框)|勾选|取消勾选|选择(?!器|框)|切换(?!器)|滚动|拖动|悬停|提交|上传|清空|click|tap|type|fill|enter|select|toggle|scroll|drag|hover|submit|upload|press/i;
const LOOK = /^\s*(查看|看一?下|观察|留意|注意|浏览|确认|验证|检查|断言|校验|读取|look|observe|inspect|view|assert|verify|ensure|check|confirm)/i;
const hasAction = (k: any) => (k.steps ?? []).some((s: string) => !NAV.test(s) && ACTION.test(s) && !LOOK.test(s));
let a = 0, bb = 0, c = 0, d = 0; const shown: string[] = [];
for (const k of b.cases) {
  const s: any = byId.get(k.storyId); const acs: string[] = s?.acceptance ?? [];
  const rewroteWhen = (k.acRefs ?? []).some((r: string) => {
    if (acs.some((x) => norm(x) === norm(r))) return false;
    const w = norm(whenOf(r)); return !!w && !acs.some((x) => norm(whenOf(x)) === w);
  });
  const act = hasAction(k);
  if (rewroteWhen && !act) { a++; if (shown.length < 5) shown.push(`${k.id}「${k.title.slice(0, 26)}」\n     故事 ${s.id} 的 When：${acs.map((x) => whenOf(x).slice(0, 26)).join(" ／ ")}\n     用例改成：${whenOf((k.acRefs ?? [])[0] ?? "").slice(0, 40)}\n     steps：${(k.steps ?? []).join(" | ").slice(0, 66)}`); }
  else if (rewroteWhen && act) bb++;
  else if (!rewroteWhen && !act) c++;
  else d++;
}
console.log("                     改写了 When   没改写");
console.log(`  用例没有真实动作        ${String(a).padStart(3)}         ${String(c).padStart(3)}`);
console.log(`  用例有真实动作          ${String(bb).padStart(3)}         ${String(d).padStart(3)}`);
console.log();
for (const x of shown) console.log("  " + x + "\n");
