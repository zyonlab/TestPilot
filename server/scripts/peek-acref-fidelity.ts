/** 只读：acRefs 到底有没有指向故事里真实存在的那条验收准则。 */
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
const norm = (x: string) => x.replace(/[\s“”"'（）()、,，。.]/g, "");
let refs = 0, exact = 0, none = 0, noRefs = 0;
const whenOf = (ac: string) => (/When\s*([^/]+)/i.exec(ac))?.[1]?.trim() ?? "";
let whenChanged = 0;
for (const k of b.cases) {
  const s: any = byId.get(k.storyId);
  const acs: string[] = s?.acceptance ?? [];
  const rs: string[] = k.acRefs ?? [];
  if (!rs.length) { noRefs++; continue; }
  for (const r of rs) {
    refs++;
    if (acs.some((a) => norm(a) === norm(r))) exact++;
    else {
      none++;
      // 这条 acRefs 改写的 When，和故事里任何一条的 When 都不一样吗？
      const w = norm(whenOf(r));
      if (w && !acs.some((a) => norm(whenOf(a)) === w)) whenChanged++;
    }
  }
}
console.log(`${b.cases.length} 条用例，acRefs 共 ${refs} 条（没有 acRefs 的用例 ${noRefs} 条）`);
console.log(`  逐字指向故事里真实存在的验收准则： ${exact} 条`);
console.log(`  自己改写了一条（故事里没有这句）：  ${none} 条`);
console.log(`    其中连 When 都改掉了（故事里没有任何一条是这个 When）：${whenChanged} 条`);
