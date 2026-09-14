/**
 * 出处核对的两个基底从哪来。规则本身在 `harness-testing/src/casegen/provenance.ts`，
 * 这里只负责把 trace 与索引读成两个 id 集合。
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const RETRIEVE_TOOL = /(^|__)retrieve_spec$/;

/** trace 里 `retrieve_spec` 每次返回的段 id。输出是包在 `<spec_material>` 里的 JSON，先拆围栏。 */
export function retrievedIdsFromTrace(tracePath, unwrap) {
  const ids = new Set();
  let calls = 0;
  if (!tracePath || !existsSync(tracePath)) return { ids, calls };
  const pending = new Set();
  for (const line of readFileSync(tracePath, "utf8").split("\n")) {
    if (!line) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const p = row?.payload;
    if (!p || row.type !== "model_msg") continue;
    if (p.type === "tool_call" && RETRIEVE_TOOL.test(String(p.name ?? ""))) {
      pending.add(p.tool_call_id);
      calls += 1;
    } else if (p.type === "tool_call_output" && pending.has(p.tool_call_id)) {
      pending.delete(p.tool_call_id);
      try {
        const body = JSON.parse(unwrap(String(p.output ?? "")));
        for (const c of body?.chunks ?? []) if (typeof c?.id === "string") ids.add(c.id);
      } catch {
        // 一次读不出来的输出不算取到过任何段——它也没给模型任何可引用的 id。
      }
    }
  }
  return { ids, calls };
}

/** 材料索引里的全部段 id。没有索引就是空集。 */
export function idsFromIndex(workspace) {
  const p = path.join(workspace, "materials", ".index", "index.json");
  if (!existsSync(p)) return null;
  try {
    const idx = JSON.parse(readFileSync(p, "utf8"));
    return new Set((idx?.chunks ?? []).map((c) => c.id).filter((x) => typeof x === "string"));
  } catch {
    return null;
  }
}

