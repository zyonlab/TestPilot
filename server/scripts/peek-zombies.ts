/** 只读：还挂在 running 的运行，各自的 runtime / session / 产物目录还在不在。 */
import { config } from "dotenv";
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
config({ path: join(resolve(import.meta.dirname, "../.."), "server/.env"), quiet: true } as never);
const { outputStore } = await import("../src/graphs.js");
for (const row of outputStore.listRuns(200)) {
  if (String(row.status) !== "running") continue;
  const d = (outputStore.getRun(String(row.id))?.detail ?? {}) as { runtime?: string; penguin?: { sessionId?: string; outDir?: string } };
  const out = d.penguin?.outDir;
  const ev = out ? join(out, "events.jsonl") : "";
  const age = ev && existsSync(ev) ? Math.round((Date.now() - statSync(ev).mtimeMs) / 60000) : -1;
  console.log(`${String(row.id).slice(4, 12)} runtime=${d.runtime} session=${d.penguin?.sessionId ?? "（无）"} 事件文件${age < 0 ? "不存在" : `${age} 分钟没动`}`);
}
