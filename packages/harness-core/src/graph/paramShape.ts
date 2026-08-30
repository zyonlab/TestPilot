import { z } from "zod";

/**
 * 把一个节点的 zod 参数 schema 变成界面能画成表单的形状。
 *
 * 为什么需要它：每个节点类型**都有**完整的 `params: z.ZodType`，可 `NodeRegistry.list()`
 * 只把 type/title/description/inKind/outKind 发给前端，schema 被裁掉了。于是节点检查器
 * 只能给一个 `{}` 裸文本框——用户无从知道能填什么键、填什么类型、默认是多少。
 * 上游有、下游要、中间那层为了「只留画图要用的字段」删掉了，这是本仓库反复出现的一种形状。
 *
 * 不引 `zod-to-json-schema`：这里要的不是通用转换，是**给人看的字段清单**，
 * 而节点参数用到的形状就那么几种。认不出来的形状明说 `unknown`，让界面回落到 JSON——
 * 一个假装看懂了的表单会悄悄吃掉它不认识的键，那比没有表单糟得多。
 */

export type ParamKind = "string" | "number" | "boolean" | "enum" | "stringArray" | "unknown";

export interface ParamField {
  name: string;
  kind: ParamKind;
  optional: boolean;
  /** zod 的 `.default(x)`。界面显示成占位符，而不是预填——预填会让人以为自己设过它。 */
  defaultValue?: unknown;
  /** enum 的可选值。 */
  options?: string[];
  /** 数值的上下界，从 `.min()/.max()` 上读。 */
  min?: number;
  max?: number;
  /** schema 上写的 `.describe()`，没有就没有。注释读不出来，这是已知的边界。 */
  description?: string;
}

export interface ParamShape {
  fields: ParamField[];
  /** 整个 schema 不是一个对象（极少见）时为 true，界面直接回落到 JSON。 */
  opaque: boolean;
}

/** 剥掉 optional / default / nullable / effects 这些包装，露出里面的类型。 */
function unwrap(schema: z.ZodTypeAny): {
  inner: z.ZodTypeAny;
  optional: boolean;
  defaultValue?: unknown;
  description?: string;
} {
  let inner = schema;
  let optional = false;
  let defaultValue: unknown;
  let description: string | undefined = schema.description;
  // 有界循环：包装最多套几层，写成 while(true) 只会把一个 schema 的怪形状变成一次挂起。
  for (let i = 0; i < 8; i += 1) {
    const def = inner._def as { typeName?: string; innerType?: z.ZodTypeAny; defaultValue?: () => unknown; schema?: z.ZodTypeAny };
    description ??= inner.description;
    if (def.typeName === "ZodOptional" || def.typeName === "ZodNullable") {
      optional = true;
      inner = def.innerType!;
    } else if (def.typeName === "ZodDefault") {
      optional = true;
      defaultValue = def.defaultValue?.();
      inner = def.innerType!;
    } else if (def.typeName === "ZodEffects") {
      inner = def.schema!;
    } else break;
  }
  return { inner, optional, defaultValue, description };
}

function kindOf(schema: z.ZodTypeAny): { kind: ParamKind; options?: string[]; min?: number; max?: number } {
  const def = schema._def as {
    typeName?: string;
    values?: string[];
    checks?: Array<{ kind: string; value: number }>;
    type?: z.ZodTypeAny;
  };
  switch (def.typeName) {
    case "ZodString":
      return { kind: "string" };
    case "ZodBoolean":
      return { kind: "boolean" };
    case "ZodNumber": {
      const min = def.checks?.find((c) => c.kind === "min")?.value;
      const max = def.checks?.find((c) => c.kind === "max")?.value;
      return { kind: "number", min, max };
    }
    case "ZodEnum":
      return { kind: "enum", options: def.values };
    case "ZodArray": {
      const item = def.type ? unwrap(def.type).inner : undefined;
      const itemKind = item ? (item._def as { typeName?: string }).typeName : undefined;
      return itemKind === "ZodString" ? { kind: "stringArray" } : { kind: "unknown" };
    }
    default:
      return { kind: "unknown" };
  }
}

export function describeParams(schema: z.ZodTypeAny): ParamShape {
  const { inner } = unwrap(schema);
  const def = inner._def as { typeName?: string; shape?: () => Record<string, z.ZodTypeAny> };
  if (def.typeName !== "ZodObject" || !def.shape) return { fields: [], opaque: true };
  const shape = def.shape();
  const fields: ParamField[] = Object.entries(shape).map(([name, field]) => {
    const u = unwrap(field);
    const k = kindOf(u.inner);
    return {
      name,
      kind: k.kind,
      optional: u.optional,
      defaultValue: u.defaultValue,
      options: k.options,
      min: k.min,
      max: k.max,
      description: u.description,
    };
  });
  return { fields, opaque: false };
}
