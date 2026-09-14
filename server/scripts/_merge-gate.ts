import { config } from "dotenv";
import { join, resolve } from "node:path";
config({ path: join(resolve(import.meta.dirname, "../.."), "server/.env"), quiet: true } as never);
const { adapterRunGrant } = await import("../src/runService.js");
const [runId, projectId] = process.argv.slice(2);
const token = adapterRunGrant(runId!, projectId!);
const call = async (path: string, body: unknown) => {
  const r = await fetch(`http://127.0.0.1:5301/api/projects/${projectId}/workflow-runs/${runId}/${path}`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body ?? {}) });
  const t = await r.text(); try { return JSON.parse(t); } catch { return { http: r.status, body: t.slice(0, 300) }; }
};
console.log("merge:", JSON.stringify(await call("stages/units/merge", { node: "cases" })).slice(0, 700));
console.log("begin gate:", JSON.stringify(await call("begin-stage", { node: "gate" })).slice(0, 200));
const g = await call("stages/gate", {});
console.log("gate:", JSON.stringify({ status: g.status, score: g.report?.score, findings: g.report?.findings?.length, stats: g.report?.stats }).slice(0, 600));
