import { describe, expect, it } from "vitest";
import { classifyFailure } from "../src/failure.js";

// Why this matters: the biggest single failure bucket in the published study of this kind
// of system was environment timeouts (40%). Counting those as product defects poisons the
// flake rate, the gate and the repair loop's idea of what it is fixing.
describe("classifyFailure", () => {
  const cases: Array<[string, string, string, boolean]> = [
    ["failed to call AI model service: Connection error", "MODEL_UNAVAILABLE", "infra", true],
    ["HTTP 502: terminated", "MODEL_UNAVAILABLE", "infra", true],
    ["Navigation timeout of 45000 ms exceeded", "EXEC_TIMEOUT", "infra", true],
    ["net::ERR_CONNECTION_REFUSED at http://localhost:3000", "EXEC_ENV", "infra", true],
    ["net::ERR_UNSAFE_PORT at http://127.0.0.1:9/", "EXEC_ENV", "infra", true],
    ["Protocol error: Target closed", "EXEC_ENV", "infra", true],
    ["cannot find the element: the login button", "EXEC_LOCATE", "locate", true],
    ["Unable to locate element matching 'submit'", "EXEC_LOCATE", "locate", true],
    ["Assertion failed: the error message about a locked-out user is displayed", "EXEC_ASSERT", "assert", false],
  ];

  for (const [message, code, attribution, retryable] of cases) {
    it(`classifies "${message.slice(0, 40)}…" as ${attribution}`, () => {
      const f = classifyFailure(message);
      expect(f.code).toBe(code);
      expect(f.attribution).toBe(attribution);
      expect(f.retryable).toBe(retryable);
    });
  }

  it("separates a model outage from a broken target — they send you to different places", () => {
    expect(classifyFailure("failed to call AI model service").code).toBe("MODEL_UNAVAILABLE");
    expect(classifyFailure("net::ERR_CONNECTION_REFUSED").code).toBe("EXEC_ENV");
    expect(classifyFailure("Navigation timeout of 45000 ms exceeded").code).toBe("EXEC_TIMEOUT");
  });

  it("defaults to a verdict, not to infra — an unknown error must not be excused as flakiness", () => {
    const f = classifyFailure("something nobody has a regex for yet");
    expect(f.attribution).toBe("assert");
    expect(f.retryable).toBe(false);
  });
});

/**
 * 规划失败不是断言失败。
 *
 * 实测：`Navigate to the product list page` —— 一个目标，不是一个动作 —— 让驱动模型
 * replan 十次后放弃，而这条消息掉进兜底档变成 `EXEC_ASSERT`。于是一次**由用例措辞造成**
 * 的失败，被记成「产品没通过断言」。分档机制存在的全部理由就是不让这种事发生。
 */
describe("a driver that could not plan the instruction", () => {
  const msg = "Replanning 10 times, which is more than the limit, please split the task into multiple steps";

  it("is not filed as a failed assertion", () => {
    const f = classifyFailure(msg);
    expect(f.attribution).not.toBe("assert");
    expect(f.code).toBe("EXEC_PLAN");
  });

  it("is retryable, because rewording the step can fix it", () => {
    expect(classifyFailure(msg).retryable).toBe(true);
    // 和「找不到元素」同一档：修复循环该去改用例的措辞，而不是走「这是产品缺陷」的出口。
    expect(classifyFailure(msg).attribution).toBe("locate");
  });

  it("still calls a real assertion failure an assertion failure", () => {
    expect(classifyFailure('expected the page to show "$7.99" but it showed "$8.99"').attribution).toBe("assert");
  });
});
