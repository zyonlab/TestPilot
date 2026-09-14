/** 只读：量一量项目总览这条路各段耗时（2026-09-12 它要 27 秒）。 */
import { config } from "dotenv";
import { join, resolve } from "node:path";
config({ path: join(resolve(import.meta.dirname, "../.."), "server/.env"), quiet: true } as never);
const t = async (label: string, fn: () => unknown) => { const a = Date.now(); const v = await fn(); console.log(label, Date.now() - a, "ms"); return v; };
const db = await import("../src/db.js");
const graphs = await import("../src/graphs.js");
const projects = await t("listProjects", () => db.listProjects()) as Array<{ id: string }>;
for (const p of projects.slice(0, 2)) await t(`listCases ${p.id}`, () => db.listCases(p.id));
await t("listRuns", () => graphs.outputStore.listRuns());
await t("outputCounts", () => graphs.outputCounts());
const ov = await import("../src/overview.js");
await t("projectOverview[0]", () => ov.projectOverview(projects[0]!.id));
await t("allProjectOverviews", () => ov.allProjectOverviews());
process.exit(0);
