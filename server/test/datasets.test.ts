import { describe, expect, it } from "vitest";
import {
  checkBinding,
  inspectRows,
  parseCsv,
  parseRows,
  referencedColumns,
  uniquify,
  type Dataset,
} from "../src/datasets.js";

/**
 * 测试数据集的四条判据，每一条对着一个这个仓库真吃过的亏。
 */

describe("导入", () => {
  it("带引号的字段要认——按逗号硬切会把「北京市, 朝阳区」切成两列，而且不报错", () => {
    const rows = parseCsv('name,addr\n张三,"北京市, 朝阳区"\n李四,上海');
    expect(rows).toEqual([
      { name: "张三", addr: "北京市, 朝阳区" },
      { name: "李四", addr: "上海" },
    ]);
  });

  it("双引号转义", () => {
    expect(parseCsv('a\n"他说""好"""')).toEqual([{ a: '他说"好"' }]);
  });

  it("CSV 和 JSON 自己认，不问用户——多问一个问题就多一个答错的机会", () => {
    expect(parseRows('[{"a":"1"}]').format).toBe("json");
    expect(parseRows("a,b\n1,2").format).toBe("csv");
  });

  it("JSON 里的数字与 null 统一成字符串——步骤里插值出来的永远是文本", () => {
    expect(parseRows('[{"n":1,"x":null}]').rows).toEqual([{ n: "1", x: "" }]);
  });

  it("只有表头没有数据要报错，别落一个空数据集进去", () => {
    expect(() => parseCsv("a,b")).toThrow(/表头和一行数据/);
  });

  it("重名的列要报错——后一列会静默盖掉前一列", () => {
    expect(() => parseCsv("a,a\n1,2")).toThrow(/重名/);
  });
});

describe("导入前的体检", () => {
  it("像凭证的列要警告——数据集会进版本库，凭证不能", () => {
    const w = inspectRows([{ user: "u", password: "p" }]);
    expect(w.find((x) => x.kind === "secretish")?.column).toBe("password");
  });

  it("只警告不拦——判断一列是不是凭证最终要人看，硬拦会把 password_hint 挡死", () => {
    // inspectRows 从不抛，它只返回警告
    expect(() => inspectRows([{ password: "x" }])).not.toThrow();
  });

  it("整列全空、完全重复的行都要说出来", () => {
    const w = inspectRows([{ a: "1", b: "" }, { a: "1", b: "" }]);
    expect(w.map((x) => x.kind).sort()).toEqual(["duplicate", "empty"]);
  });
});

describe("引用校验", () => {
  const ds = { columns: ["first", "last"] } as Dataset;

  it("认出步骤引了哪几列", () => {
    expect(referencedColumns(["在 ${row.first} 和 ${row.last}"]).columns.sort()).toEqual([
      "first",
      "last",
    ]);
  });

  it("引了数据集没有的列要报出来——它现在会原样留在步骤里被当成字面量输进表单", () => {
    const r = checkBinding(["填入 ${row.emial}"], ds);
    expect(r.missing).toEqual(["emial"]);
    expect(r.ok).toBe(false);
  });

  it("数据集里没被引用的列也说一声——多半是列名写错了另一半", () => {
    expect(checkBinding(["填入 ${row.first}"], ds).unused).toEqual(["last"]);
  });

  it("没绑数据集却引了 ${row.x}，同样是缺", () => {
    expect(checkBinding(["填入 ${row.first}"], undefined).ok).toBe(false);
  });
});

describe("唯一后缀", () => {
  it("只动标了唯一的列——给密码加后缀会让每一行都登不上去", () => {
    expect(uniquify({ user: "u", pass: "p" }, ["user"], "r7k2")).toEqual({
      user: "u-r7k2",
      pass: "p",
    });
  });

  it("邮箱插在 @ 前面——加在后面会破坏域名，产品会当成格式错误拒收", () => {
    expect(uniquify({ email: "a@b.com" }, ["email"], "r7k2").email).toBe("a-r7k2@b.com");
  });

  it("空值不动——给空字符串加后缀，等于凭空造了一个值", () => {
    expect(uniquify({ x: "" }, ["x"], "r7k2").x).toBe("");
  });
});
