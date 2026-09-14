/**
 * `write_stories` / `write_cases` 的实现（07 T-09）：门禁在工具里。
 * 判决来自 `harness-testing/casegen/validate.ts`（和 hook 同一份）；这里只管三件事：
 * 出处基底从哪来（这个进程里 `retrieve_spec` 返回过的 id，退到材料索引）、拒写时记 `holds.jsonl`、通过时写盘。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { validateCases, validateStories } from "@testpilot/harness-testing/casegen";
import { Held } from "./contracts.js";
import { DEFAULT_RUNS_DIR } from "./runs.js";

export interface SessionBasis {
  retrievedIds: Set<string>;
  retrieveCalls: number;
}

/** 材料索引里的全部段 id；没有索引就是 null。和 hook 里 `idsFromIndex` 同一条规则。 */
export function indexedIds(materialsDir: string): Set<string> | null {
  const p = join(materialsDir, ".index", "index.json");
  if (!existsSync(p)) return null;
  try {
    const idx = JSON.parse(readFileSync(p, "utf8")) as { chunks?: Array<{ id?: unknown }> };
    return new Set((idx.chunks ?? []).map((c) => c.id).filter((x): x is string => typeof x === "string"));
  } catch {
    return null;
  }
}

/** 一次拒写落一行 `holds.jsonl`——和 hook 的 `deny()` 同一个账本、同一套词。 */
function recordHold(runDir: string, hold: Record<string, unknown>): void {
  try {
    mkdirSync(runDir, { recursive: true });
    appendFileSync(join(runDir, "holds.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...hold }) + "\n");
  } catch {
    /* 记不下来不该改变这次拒绝 */
  }
}

export function writeArtifact(
  name: "stories" | "cases",
  args: { runId: string; runsDir?: string; content: unknown; materialsDir?: string },
  basis: SessionBasis,
): Record<string, unknown> {
  const runsDir = resolvePath(args.runsDir ?? DEFAULT_RUNS_DIR);
  const runDir = join(runsDir, args.runId);
  const file = join(runDir, `${name}.json`);
  const verdict =
    name === "stories"
      ? validateStories(args.content)
      : validateCases(args.content, {
          retrieved: basis.retrievedIds,
          retrieveCalls: basis.retrieveCalls,
          indexed: indexedIds(args.materialsDir ?? join(dirname(runsDir), "materials")),
        });
  if (!verdict.ok) {
    recordHold(runDir, { hook: `write_${name}`, gate: verdict.gate, reason: verdict.reason, ...verdict.output });
    throw new Held(verdict.gate, verdict.reason);
  }
  mkdirSync(runDir, { recursive: true });
  writeFileSync(file, JSON.stringify(verdict.data, null, 2) + "\n");
  return { written: file, ...verdict.output, reason: verdict.reason };
}
