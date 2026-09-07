import { useT } from "@/lib/prefs";
import { cn } from "@/lib/cn";

/**
 * 节点参数的表单。
 *
 * 此前这里只有一个写着 `{}` 的裸文本框：每个节点类型都有完整的 zod 参数 schema，
 * 但 `NodeRegistry.list()` 把它裁掉了不往前端发，于是人无从知道能填什么键、
 * 什么类型、默认是多少——只能去读源码，或者干脆不改。
 *
 * 两条设计约束：
 *
 * **① 默认值显示成占位符，不预填。** 预填会让人以为自己设过它，于是保存出一份把所有
 * 默认值都固化下来的参数——下次改默认值时这个节点不会跟着变，而没人记得为什么。
 *
 * **② 认不出来的形状不画。** `describeParams` 遇到没见过的 zod 形状会标成 `unknown`，
 * 这里就把那几个键留给 JSON 文本框。一个假装看懂了的表单会悄悄吃掉它不认识的键，
 * 那比没有表单糟得多。
 */

export interface ParamField {
  name: string;
  kind: "string" | "number" | "boolean" | "enum" | "stringArray" | "unknown";
  optional: boolean;
  defaultValue?: unknown;
  options?: string[];
  min?: number;
  max?: number;
  description?: string;
}

export interface ParamShape {
  fields: ParamField[];
  opaque: boolean;
}

export function ParamForm({
  shape,
  value,
  onChange,
}: {
  shape: ParamShape;
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const t = useT();
  const editable = shape.fields.filter((f) => f.kind !== "unknown");
  if (shape.opaque || !editable.length) return null;

  const set = (name: string, v: unknown) => {
    const next = { ...value };
    // 清空一个字段就是删掉这个键，而不是写一个空串——写空串等于「我要求它是空的」，
    // 那和「我没设过它」在下游是两回事（后者才走默认值）。
    if (v === "" || v === undefined) delete next[name];
    else next[name] = v;
    onChange(next);
  };

  const input = "w-full rounded-md border border-border bg-card px-2 py-1 text-[0.75rem]";
  return (
    <div className="mb-2 space-y-1.5">
      {editable.map((f) => {
        const v = value[f.name];
        const ph =
          f.defaultValue !== undefined ? String(f.defaultValue) : f.optional ? t("wf.paramOptional") : "";
        return (
          <label key={f.name} className="flex items-start gap-2">
            <span
              className="w-24 shrink-0 pt-1 text-right font-mono text-[0.6875rem] leading-[1.5] text-muted-foreground"
              title={f.description}
            >
              {f.name}
              {!f.optional && <span className="text-bad"> *</span>}
            </span>
            <span className="min-w-0 flex-1">
              {f.kind === "boolean" ? (
                <select
                  className={input}
                  value={v === undefined ? "" : String(v)}
                  onChange={(e) => set(f.name, e.target.value === "" ? undefined : e.target.value === "true")}
                >
                  <option value="">{ph || t("wf.paramUnset")}</option>
                  <option value="true">true</option>
                  <option value="false">false</option>
                </select>
              ) : f.kind === "enum" ? (
                <select
                  className={input}
                  value={v === undefined ? "" : String(v)}
                  onChange={(e) => set(f.name, e.target.value || undefined)}
                >
                  <option value="">{ph || t("wf.paramUnset")}</option>
                  {(f.options ?? []).map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              ) : f.kind === "stringArray" ? (
                <input
                  className={cn(input, "font-mono")}
                  value={Array.isArray(v) ? (v as string[]).join(", ") : ""}
                  placeholder={t("wf.paramListHint")}
                  onChange={(e) => {
                    const items = e.target.value
                      .split(",")
                      .map((s) => s.trim())
                      .filter(Boolean);
                    set(f.name, items.length ? items : undefined);
                  }}
                />
              ) : (
                <input
                  className={cn(input, f.kind === "number" && "font-mono")}
                  type={f.kind === "number" ? "number" : "text"}
                  min={f.min}
                  max={f.max}
                  value={v === undefined ? "" : String(v)}
                  placeholder={ph}
                  onChange={(e) => {
                    if (f.kind === "number") {
                      const n = e.target.value === "" ? undefined : Number(e.target.value);
                      set(f.name, n !== undefined && Number.isFinite(n) ? n : undefined);
                    } else set(f.name, e.target.value);
                  }}
                />
              )}
              {(f.description || f.min !== undefined || f.max !== undefined) && (
                <span className="mt-0.5 block text-[0.6875rem] leading-[1.5] text-muted-foreground">
                  {f.description}
                  {f.min !== undefined && f.max !== undefined && ` ${f.min}–${f.max}`}
                </span>
              )}
            </span>
          </label>
        );
      })}
      {shape.fields.length > editable.length && (
        // 说出来：有几个键这个表单看不懂，它们只能在下面的 JSON 里改。
        <p className="pl-[6.5rem] text-[0.6875rem] text-muted-foreground">
          {t("wf.paramOnlyJson", { n: shape.fields.length - editable.length })}
        </p>
      )}
    </div>
  );
}
