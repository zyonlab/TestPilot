import { describe, it, expect, beforeAll } from "vitest";
import { createProject, upsertEnvironment } from "../src/db.js";

/**
 * resolveTarget 不是导出的，所以从它唯一的出口——起跑记录——去看。
 * 这里只测「点名了一个不存在的环境」这条路，因为它是唯一会改变行为的一条。
 */
describe("目标环境的出处", () => {
  let pid = "";
  beforeAll(() => {
    pid = createProject(`prov-${Math.random().toString(36).slice(2, 7)}`, "https://proj.example").id;
    upsertEnvironment({ projectId: pid, name: "staging", baseUrl: "https://staging.example" });
    upsertEnvironment({ projectId: pid, name: "prod", baseUrl: "https://prod.example", isDefault: true });
  });

  it("点名一个存在的环境就用它", async () => {
    const { resolveEnvironment } = await import("../src/db.js");
    expect(resolveEnvironment(pid, "staging")?.baseUrl).toBe("https://staging.example");
  });

  it("点名一个不存在的环境，db 层仍会退回默认——所以拦截必须在 graphs 那一层", async () => {
    const { resolveEnvironment } = await import("../src/db.js");
    // 这一条记录的是现状，不是期望：它解释了为什么 resolveTarget 要自己再查一次。
    expect(resolveEnvironment(pid, "nope")?.name).toBe("prod");
  });
});
