import { config } from "dotenv";
import { join, resolve } from "node:path";
config({ path: join(resolve(import.meta.dirname, "../.."), "server/.env"), quiet: true } as never);
const { runLedger } = await import("../src/runService.js");
const l = runLedger();
const [runId, projectId] = process.argv.slice(2);
const st = l.readRevision(l.listRevisions(projectId!, runId!).filter((r: any) => r.name === "validated/stories").at(-1)!.id, projectId!).content as any;
const stories: any[] = st.stories ?? st;
const ACTION = /点击|单击|双击|按下|按住|长按|填入|填写|输入(?!框)|勾选|取消勾选|选择(?!器|框)|切换(?!器)|滚动|拖动|悬停|提交|上传|清空|设置|连接|断开|下单|撤单|平仓|click|tap|type|fill|enter|select|toggle|scroll|drag|hover|submit|upload|press/i;
const whenOf = (ac: string) => (/When\s*([^/]+)/i.exec(ac))?.[1]?.trim() ?? "";
let allPassive = 0;
for (const s of stories) {
  const acs = (s.acceptance ?? []) as string[];
  const act = acs.filter((a) => ACTION.test(whenOf(a)));
  if (!act.length) { allPassive++; console.log(`⚠ ${s.id} 「${s.title}」 ${acs.length} 条准则，没有一条 When 是动作`);
    for (const a of acs) console.log(`     When ${whenOf(a).slice(0, 46)}`); }
}
console.log(`\n${stories.length} 条故事里，**一条动作型验收准则都没有** 的：${allPassive} 条`);
