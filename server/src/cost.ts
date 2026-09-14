/**
 * 成本账（07 T-21）：`GET /api/projects/:id/cost` 与 `scripts/cost-report.mjs --json` 是**同一份聚合**——
 * `scripts/lib/cost-aggregate.mjs`。两边逐字段一致由构造保证，`test/cost-shared.test.ts` 钉住。
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { aggregate, type CostReport, type CostRow } from "../../scripts/lib/cost-aggregate.mjs";
import { DATA_DIR } from "./datadir.js";
import { listProjectRunRows } from "./db.js";

export function readDegrades(dataDir: string = DATA_DIR): Array<Record<string, unknown>> {
  const p = resolve(dataDir, "degrades.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((x): x is Record<string, unknown> => !!x);
}

export function projectCost(projectId: string, last = 10): CostReport & { project: string; last: number } {
  const rows = listProjectRunRows(projectId) as unknown as CostRow[];
  const usd = process.env.TP_USD_PER_MTOK ? Number(process.env.TP_USD_PER_MTOK) : undefined;
  return { project: projectId, last, ...aggregate(rows, readDegrades(), { last, usdPerMtok: usd }) };
}
