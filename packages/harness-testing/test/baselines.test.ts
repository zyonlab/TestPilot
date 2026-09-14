import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import { diffPng } from "../src/baselines/visual.js";
import { comparePerf } from "../src/baselines/perf.js";

// The two baseline mechanics that must not drift while the executor moves between
// processes: what counts as a visual change, and what counts as a perf regression.

function png(w: number, h: number, paint: (x: number, y: number) => [number, number, number]): Buffer {
  const img = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) << 2;
      const [r, g, b] = paint(x, y);
      img.data[i] = r;
      img.data[i + 1] = g;
      img.data[i + 2] = b;
      img.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(img);
}
const solid = (w: number, h: number, c: [number, number, number]) => png(w, h, () => c);

describe("visual baseline", () => {
  it("reports 0% for identical shots", () => {
    const a = solid(20, 20, [10, 20, 30]);
    expect(diffPng(a, solid(20, 20, [10, 20, 30])).mismatchPct).toBe(0);
  });

  it("scales with the changed area", () => {
    const base = solid(20, 20, [0, 0, 0]);
    // repaint one row of 20 px out of 400 → 5%
    const changed = png(20, 20, (_x, y) => (y === 0 ? [255, 255, 255] : [0, 0, 0]));
    const d = diffPng(base, changed);
    expect(d.mismatchPct).toBeCloseTo(5, 1);
    expect(d.diffPng.length).toBeGreaterThan(0);
  });

  it("treats a size change as a visual change instead of throwing", () => {
    const d = diffPng(solid(20, 20, [0, 0, 0]), solid(30, 20, [0, 0, 0]));
    expect(d.mismatchPct).toBeGreaterThan(0);
    expect(d.width).toBe(30);
  });
});

describe("perf baseline", () => {
  const metrics = { ttfbMs: 100, fcpMs: 400, loadMs: 900 };

  it("establishes a baseline on the first run", () => {
    const r = comparePerf(metrics, undefined, {});
    expect(r.status).toBe("new_baseline");
    expect(r.verdicts.every((v) => v.status === "new_baseline")).toBe(true);
  });

  it("passes when the run is within tolerance of the baseline", () => {
    const r = comparePerf(metrics, { ttfbMs: 95, fcpMs: 390, loadMs: 880 }, {});
    expect(r.status).toBe("ok");
  });

  it("flags a regression when a metric blows past its baseline", () => {
    const r = comparePerf({ ...metrics, loadMs: 4000 }, { ...metrics }, {});
    expect(r.status).toBe("regression");
    expect(r.verdicts.find((v) => v.metric === "loadMs")?.status).toBe("regression");
    expect(r.verdicts.find((v) => v.metric === "ttfbMs")?.status).toBe("ok");
  });

  it("reports no metrics as no verdicts, not as a pass", () => {
    const r = comparePerf({}, undefined, {});
    expect(r.verdicts).toHaveLength(0);
  });
});
