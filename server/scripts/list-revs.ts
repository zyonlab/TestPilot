import { config } from "dotenv";
import { join, resolve } from "node:path";
config({ path: join(resolve(import.meta.dirname, "../.."), "server/.env"), quiet: true } as never);
const { runLedger } = await import("../src/runService.js");
const l = runLedger();
for (const r of l.listRevisions(process.argv[2]!, process.argv[3]!))
  console.log([r.name, "v" + r.revision, r.id, r.kind, JSON.stringify(r.createdBy), r.createdAt].join("  "));
