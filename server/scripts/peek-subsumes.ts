/** 只读：模型到底有没有声明「长故事覆盖短故事」，以及它带来的结构变化。 */
import { config } from "dotenv";
import { join, resolve } from "node:path";
config({ path: join(resolve(import.meta.dirname, "../.."), "server/.env"), quiet: true } as never);
const { runLedger } = await import("../src/runService.js");
const l = runLedger();
const [runId, projectId] = process.argv.slice(2);
const revs = l.listRevisions(projectId!, runId!);
const st: any = l.readRevision(revs.filter((r: any) => r.name === "validated/stories").at(-1)!.id, projectId!).content;
const stories: any[] = st.stories ?? st;
const covering = stories.filter((s) => (s.subsumes ?? []).length);
const covered = new Set(stories.flatMap((s) => s.subsumes ?? []));
console.log(`故事 ${stories.length} 条 · 声明覆盖的 ${covering.length} 条 · 被覆盖的 ${covered.size} 条`);
for (const s of covering) console.log(`  ${s.id}「${s.title.slice(0, 26)}」 覆盖 → ${(s.subsumes ?? []).join(", ")}`);
const caseRevs = revs.filter((r: any) => /^units\/cases\//.test(r.name));
const cases = caseRevs.flatMap((r: any) => (l.readRevision(r.id, projectId!).content as any).cases ?? []);
console.log(`\n用例单元 ${caseRevs.length} 个（故事 ${stories.length} 条，少的就是被覆盖的）· 用例 ${cases.length} 条`);
