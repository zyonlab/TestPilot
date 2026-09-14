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
const s = stories.find((x) => x.id === "S-05") ?? stories[4];
console.log("故事", s.id, s.title);
for (const a of s.acceptance ?? []) console.log("  AC:", JSON.stringify(a));
for (const k of b.cases.filter((k: any) => k.storyId === s.id))
  console.log(`  用例 ${k.id}: acRefs=${JSON.stringify(k.acRefs)}`);
