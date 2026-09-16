import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { diffPng } from "@testpilot/harness-testing";
import { ARTIFACT_DIR, getBaseline, upsertBaseline, type VisualDiff } from "./db.js";

/** 超过这个不匹配百分比就算一处视觉差异，等人判。 */
export const VISUAL_THRESHOLD = 0.5;

/**
 * 把一次运行的逐步截图和该用例的视觉基线比。第一次跑就地立基线。
 *
 * 从 `index.ts` 抽出来是为了**让工作流执行也能用**：在此之前只有旧的单用例路径调它，
 * 于是工作流跑出来的截图一张都没进过基线，界面上那页「待审批基线」永远是空的
 * （docs/v3/history/23 §17）。它不知道调用者是谁，也不该知道。
 */
export function processVisual(caseId: string, runId: string, pngBuffers: Buffer[], thresholdPct = VISUAL_THRESHOLD): VisualDiff[] {
  const out: VisualDiff[] = [];
  for (let i = 0; i < pngBuffers.length; i += 1) {
    const cur = pngBuffers[i]!;
    const currentRef = `current/${runId}-${i}.png`;
    writeFileSync(resolve(ARTIFACT_DIR, currentRef), cur);
    const baseline = getBaseline(caseId, i);
    if (!baseline || !existsSync(baseline.imgPath)) {
      const blPath = resolve(ARTIFACT_DIR, "baselines", `${caseId}-${i}.png`);
      writeFileSync(blPath, cur);
      upsertBaseline(caseId, i, blPath);
      out.push({ stepIdx: i, status: "new_baseline", mismatchPct: 0, baselineRef: `baselines/${caseId}-${i}.png`, currentRef });
      continue;
    }
    const d = diffPng(readFileSync(baseline.imgPath), cur);
    const diffRef = `diff/${runId}-${i}.png`;
    writeFileSync(resolve(ARTIFACT_DIR, diffRef), d.diffPng);
    out.push({
      stepIdx: i,
      status: d.mismatchPct > thresholdPct ? "diff" : "match",
      mismatchPct: d.mismatchPct,
      baselineRef: `baselines/${caseId}-${i}.png`,
      currentRef,
      diffRef,
    });
  }
  return out;
}
