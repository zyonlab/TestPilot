/** 只读：g2 产物里的 81 条用例按模块分组。 */
import { config } from "dotenv";
import { join, resolve } from "node:path";
config({ path: join(resolve(import.meta.dirname, "../.."), "server/.env"), quiet: true } as never);
const { runLedger } = await import("../src/runService.js");
const { approvedExecutionBundle } = await import("../src/approvedRuns.js");
const l = runLedger();
const [runId, projectId, codeRevision] = process.argv.slice(2);
const b = approvedExecutionBundle(runId!, projectId!, codeRevision!) as any;
console.log("bundle keys:", Object.keys(b).join(", "));
console.log("case keys:", Object.keys(b.cases[0]).join(", "));
// 故事 → 模块：从 stories 产物里找
const revs = l.listRevisions(projectId!, runId!).filter((r: any) => /stories/.test(r.name));
console.log("stories 修订:", revs.map((r: any) => `${r.name}@${r.revision}`).join(", "));
const last = revs.sort((a: any, z: any) => a.revision - z.revision).at(-1);
const st = last ? (l.readRevision(last.id, projectId!).content as any) : null;
const stories: any[] = st?.stories ?? st ?? [];
const modOf = new Map<string, string>();
for (const s of stories) modOf.set(s.id, (s.moduleIds ?? [])[0] ?? "(无)");
const byMod = new Map<string, string[]>();
for (const k of b.cases) {
  const m = modOf.get(k.storyId) ?? `(故事 ${k.storyId} 不在清单里)`;
  byMod.set(m, [...(byMod.get(m) ?? []), k.id]);
}
console.log(`\n${b.cases.length} 条 / ${byMod.size} 个模块：`);
for (const [m, ids] of [...byMod].sort((a, z) => z[1].length - a[1].length))
  console.log(`  ${String(ids.length).padStart(3)} 条  ${m}  ${ids.slice(0, 4).join(",")}${ids.length > 4 ? "…" : ""}`);
