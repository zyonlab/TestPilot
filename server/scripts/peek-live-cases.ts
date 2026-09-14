/** 只读：批次还在跑时，从看板的 run 记录看已完成的用例。 */
import { config } from "dotenv";
import { join, resolve } from "node:path";
config({ path: join(resolve(import.meta.dirname, "../.."), "server/.env"), quiet: true } as never);
const { db } = await import("../src/db.js");
const t = (db as any).prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r: any) => r.name);
const table = t.find((n: string) => /^runs$/i.test(n)) ?? t.find((n: string) => /run/i.test(n) && !/wf|workflow|ledger/i.test(n));
console.log("表:", table, "|", t.join(", ").slice(0, 300));
if (table) {
  const rows = (db as any).prepare(`SELECT * FROM ${table} ORDER BY rowid DESC LIMIT ${process.argv[2] ?? 8}`).all();
  for (const r of rows.reverse()) console.log(JSON.stringify({ caseTitle: r.caseTitle, status: r.status, ms: r.durationMs, failCode: r.failCode, failKind: r.failKind, why: String(r.failureReason ?? "").split("\n")[0].slice(0, 110) }));
}
