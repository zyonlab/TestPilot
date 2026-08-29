import { describe, expect, it } from "vitest";
import { checkFrozen, countRecords } from "../src/baselines/frozen.js";

const page = (names: string[]) =>
  names.map((n, i) => `<a href="/owners/${i + 1}">${n}</a><a href="/owners/${i + 1}">edit</a>`).join("");
const stub = (html: string) => (async () => ({ text: async () => html })) as unknown as typeof fetch;

describe("冻结校验", () => {
  it("同一条记录的多个链接只算一条——否则每加一列都像是数据被改了", () => {
    expect(countRecords(page(["a", "b"]))).toBe(2);
  });

  it("干净时通过", async () => {
    const v = await checkFrozen({ url: "x", ownerCount: 2 }, stub(page(["a", "b"])));
    expect(v.ok).toBe(true);
    expect(v.drift).toEqual([]);
  });

  it("多出记录要说破是怎么多出来的——这是实际发生过的那种漂移", async () => {
    const v = await checkFrozen({ url: "x", ownerCount: 10 }, stub(page(Array(13).fill("n"))));
    expect(v.ok).toBe(false);
    expect(v.drift[0]).toContain("多出 3 条");
    expect(v.drift[0]).toContain("提交了表单");
  });

  it("少了记录也算漂移——不是只防写入，是防一切偏离", async () => {
    const v = await checkFrozen({ url: "x", ownerCount: 10 }, stub(page(Array(8).fill("n"))));
    expect(v.drift[0]).toContain("少了 2 条");
  });

  it("种子数据缺字面量也算漂移", async () => {
    const v = await checkFrozen(
      { url: "x", mustContain: ["Franklin", "Davis"] },
      stub(page(["George Franklin"])),
    );
    expect(v.observed.missing).toEqual(["Davis"]);
    expect(v.ok).toBe(false);
  });
});
