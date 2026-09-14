/** 只读：把当前看板用例导出成工程，看文件树与一条 spec 长什么样。 */
import { config } from "dotenv";
import { join, resolve } from "node:path";
config({ path: join(resolve(import.meta.dirname, "../.."), "server/.env"), quiet: true } as never);
const db = await import("../src/db.js");
const { buildExportFiles } = await import("../src/export.js");
const projectId = process.argv[2]!;
const project = db.getProject(projectId)!;
const cases = db.listCases(projectId);
const files = buildExportFiles(project, cases, { environments: db.listEnvironments(projectId), secretKeys: [] });
console.log(`项目「${project.name}」· 看板用例 ${cases.length} 条 · 导出 ${Object.keys(files).length} 个文件\n`);
for (const f of Object.keys(files).sort()) console.log(`  ${f.padEnd(56)} ${String(files[f]!.length).padStart(6)} 字节`);
const spec = Object.keys(files).find((f) => f.endsWith(".spec.ts"));
if (spec) { console.log(`\n===== ${spec} =====`); console.log(files[spec]!.slice(0, 1400)); }
for (const f of ["tests/ai.ts", "tests/actions/index.ts", "tests/flows/index.ts"])
  if (files[f]) { console.log(`\n===== ${f} =====`); console.log(files[f]!.slice(0, 900)); }
