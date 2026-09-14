import { describe, it, expect, beforeAll } from "vitest";
import { createProject, createCase, logQuarantine, listQuarantineLog } from "../src/db.js";

describe("U-51 · 隔离要留痕", () => {
  let pid = "";
  let cid = "";
  beforeAll(() => {
    pid = createProject(`q-${Math.random().toString(36).slice(2, 7)}`, "https://x.example").id;
    cid = createCase({ projectId: pid, title: "一条会抖的用例" }).id;
  });

  it("没有理由就不许隔离——它会让这条用例的红不再拦门禁", () => {
    expect(() => logQuarantine({ caseId: cid, projectId: pid, on: true, reason: "  ", by: "me" })).toThrow(
      /理由/,
    );
  });

  it("记下谁、什么时候、为什么、当时门禁是什么判决", () => {
    const e = logQuarantine({
      caseId: cid,
      projectId: pid,
      on: true,
      reason: "登录接口在预发环境每天抖两次，已经报给后端",
      by: "joe",
      gateAtTime: "fail",
    });
    expect(e.at).toBeTruthy();
    const log = listQuarantineLog(pid);
    expect(log).toHaveLength(1);
    expect(log[0].by).toBe("joe");
    expect(log[0].gateAtTime).toBe("fail");
    expect(log[0].on).toBe(true);
  });

  it("解除也是一条记录，不是把上一条抹掉", () => {
    logQuarantine({ caseId: cid, projectId: pid, on: false, reason: "后端修好了", by: "joe" });
    const log = listQuarantineLog(pid);
    expect(log).toHaveLength(2);
    // 新的在前，而旧的还在——台账只增不删，否则「这条为什么被隔离过」查不出来。
    expect(log[0].on).toBe(false);
    expect(log[1].on).toBe(true);
  });

  it("同一毫秒里写进来的两条，新的仍然在前", () => {
    const at = new Date().toISOString();
    const realIso = Date.prototype.toISOString;
    // 把时间戳钉死，逼出并列——全量测试里偶发的那次失败就是这么来的。
    Date.prototype.toISOString = function () { return at; };
    try {
      logQuarantine({ caseId: "tie", projectId: pid, on: true, reason: "同一毫秒 A", by: "joe" });
      logQuarantine({ caseId: "tie", projectId: pid, on: false, reason: "同一毫秒 B", by: "joe" });
    } finally { Date.prototype.toISOString = realIso; }
    const log = listQuarantineLog(pid, "tie");
    expect(log.map((e) => e.reason)).toEqual(["同一毫秒 B", "同一毫秒 A"]);
  });
});
