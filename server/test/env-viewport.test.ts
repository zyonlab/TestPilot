import { describe, it, expect, beforeAll } from "vitest";
import { createProject, upsertEnvironment, listEnvironments } from "../src/db.js";

describe("U-69 · 视口跟着被测对象走", () => {
  let pid = "";
  beforeAll(() => {
    pid = createProject(`vp-${Math.random().toString(36).slice(2, 7)}`, "https://x.example").id;
  });

  it("不配就是不配——存下来读回来仍然没有 viewport，而不是一个 {}", () => {
    upsertEnvironment({ projectId: pid, name: "plain", baseUrl: "https://a.example" });
    const e = listEnvironments(pid).find((x) => x.name === "plain")!;
    expect(e.viewport).toBeUndefined();
  });

  it("配了就跟着环境存下来", () => {
    upsertEnvironment({
      projectId: pid,
      name: "wide",
      baseUrl: "https://b.example",
      viewport: { width: 1600, height: 1000 },
    });
    const e = listEnvironments(pid).find((x) => x.name === "wide")!;
    expect(e.viewport).toEqual({ width: 1600, height: 1000 });
  });

  it("改别的字段不会把视口顺手丢掉", () => {
    upsertEnvironment({ projectId: pid, name: "wide", baseUrl: "https://b2.example" });
    const e = listEnvironments(pid).find((x) => x.name === "wide")!;
    expect(e.baseUrl).toBe("https://b2.example");
    expect(e.viewport).toEqual({ width: 1600, height: 1000 });
  });

  it("两个环境各配各的——这正是它不该是全局环境变量的原因", () => {
    const wide = listEnvironments(pid).find((x) => x.name === "wide")!;
    const plain = listEnvironments(pid).find((x) => x.name === "plain")!;
    expect(wide.viewport?.width).toBe(1600);
    expect(plain.viewport).toBeUndefined();
  });
});
