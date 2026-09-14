import { config } from "dotenv";
import { join, resolve } from "node:path";
config({ path: join(resolve(import.meta.dirname, "../.."), "server/.env"), quiet: true } as never);
const { runLedger } = await import("../src/runService.js");
const l = runLedger();
const [runId, projectId] = process.argv.slice(2);
const rev = l.listRevisions(projectId!, runId!).filter((r: any) => r.name === "report/acceptance-index").sort((a: any, z: any) => a.revision - z.revision).at(-1);
if (!rev) { console.log("还没有 acceptance-index"); process.exit(0); }
const c: any = l.readRevision(rev.id, projectId!).content;
const e = c.entries as any[];
const stories = new Set(e.map((x) => x.storyId));
console.log(`${stories.size} 条故事 · ${e.length} 条验收准则 · 要用户动手 ${e.filter((x) => x.actionable).length} 条（${Math.round(e.filter((x) => x.actionable).length / e.length * 100)}%）`);
console.log(`story_has_no_actionable_criterion: ${c.findings.length} 条`);
for (const f of c.findings) console.log("  " + f.message.slice(0, 120));
