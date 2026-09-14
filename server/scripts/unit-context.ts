/** 每个单元实际拿到多少材料（字符），用来证明单元循环把上下文压住了。 */
import { config } from "dotenv";
import { join, resolve } from "node:path";
config({ path: join(resolve(import.meta.dirname, "../.."), "server/.env"), quiet: true } as never);
const [projectId, runId] = process.argv.slice(2);
const { unitMaterials } = await import("../src/workUnits.js");
const { runLedger } = await import("../src/runService.js");
const rows = runLedger().db.prepare("SELECT json FROM run_work_units WHERE runId=?").all(runId!) as Array<{ json: string }>;
const sizes = rows.map((r) => JSON.parse(r.json)).map((u) => ({ unitId: u.unitId, node: u.node,
  chars: JSON.stringify(unitMaterials(runId!, projectId!, { ...u, runId })).length }));
sizes.sort((a, b) => a.chars - b.chars);
const nums = sizes.map((s) => s.chars);
const pct = (p: number) => nums[Math.min(nums.length - 1, Math.floor(nums.length * p))];
console.log(JSON.stringify({ units: nums.length, min: nums[0], median: pct(0.5), p90: pct(0.9), max: nums.at(-1),
  total: nums.reduce((a, b) => a + b, 0), largest: sizes.slice(-3) }, null, 1));
