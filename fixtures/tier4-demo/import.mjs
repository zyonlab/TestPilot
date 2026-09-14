#!/usr/bin/env node
/** 把 tier4-demo 的用例导进 TestPilot（建项目 + 环境 + 用例），只走公开 API。 node import.mjs [--gateway http://127.0.0.1:5301] */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const gateway = args[args.indexOf("--gateway") + 1] || "http://127.0.0.1:5301";
const spec = JSON.parse(readFileSync(join(here, "cases.json"), "utf8"));
const post = async (p, b) => { const r = await fetch(gateway + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${p} → ${r.status} ${JSON.stringify(j)}`); return j; };
const { project } = await post("/api/projects", { name: `tier4-demo ${new Date().toISOString().slice(0, 16)}`, targetUrl: spec.environment.baseUrl, targetPlatform: "web" });
const env = spec.environment;
await post(`/api/projects/${project.id}/environments`, { name: env.name, baseUrl: env.baseUrl, vars: env.vars, login: env.login, viewport: env.viewport, isDefault: true });
for (const c of spec.cases) await post("/api/cases", { ...c, projectId: project.id, envRef: env.name });
writeFileSync(join(here, ".claude", "project.json"), JSON.stringify({ projectId: project.id, gateway }, null, 2) + "\n");
console.log("project", project.id, `· ${spec.cases.length} cases · written to .claude/project.json`);
