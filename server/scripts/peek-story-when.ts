import { config } from "dotenv";
import { join, resolve } from "node:path";
config({ path: join(resolve(import.meta.dirname, "../.."), "server/.env"), quiet: true } as never);
const { runLedger } = await import("../src/runService.js");
const l = runLedger();
const [runId, projectId] = process.argv.slice(2);
const st = l.readRevision(l.listRevisions(projectId!, runId!).filter((r: any) => r.name === "validated/stories").at(-1)!.id, projectId!).content as any;
const stories: any[] = st.stories ?? st;
const ACTION = /点击|单击|双击|按下|按住|长按|填入|填写|输入(?!框)|勾选|取消勾选|选择(?!器|框)|切换(?!器)|滚动|拖动|悬停|提交|上传|清空|设置|连接|断开|click|tap|type|fill|enter|select|toggle|scroll|drag|hover|submit|upload|press/i;
const whenOf = (ac: string) => (/When\s*([^/]+)/i.exec(ac))?.[1]?.trim() ?? "";
let total = 0, noWhen = 0, passive = 0, act = 0; const samples: string[] = [];
for (const s of stories) for (const a of (s.acceptance ?? []) as string[]) {
  total++; const w = whenOf(a);
  if (!w) noWhen++;
  else if (ACTION.test(w)) act++;
  else { passive++; if (samples.length < 6) samples.push(`${s.id}  When ${w.slice(0, 44)}`); }
}
console.log(`${stories.length} 条故事、${total} 条验收准则：When 是真实动作 ${act} 条 · When 是「看/存在」${passive} 条 · 没写 When ${noWhen} 条`);
for (const x of samples) console.log("  " + x);
