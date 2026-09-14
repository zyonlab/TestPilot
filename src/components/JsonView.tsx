import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Search } from "lucide-react";
import { useT } from "@/lib/prefs";
import { cn } from "@/lib/cn";

/**
 * 一份 JSON 产物，可折叠、可搜。
 *
 * 此前节点的输出是 `JSON.stringify(x, null, 2)` 直接倒进一个 `<pre>`，再截断到两万字符。
 * 40 条用例的产物在里面是两千多行——想看第 17 条用例的判据，只能滚。而截断是最糟的一环：
 * 被切掉的部分没有任何提示，读的人以为自己看到了全部。
 *
 * 三条设计约束：
 * **① 数组默认折叠成一行计数。** 「40 条用例」这个事实比第一条用例的内容更该先被看见。
 * **② 搜索过滤的是路径与值，不是文本。** 搜 `oracle` 要能列出所有带判据的条目，
 *    而不是把一整页高亮成黄色。
 * **③ 不截断。** 大就说它大，让人自己决定要不要展开；悄悄切掉是这一版最该改掉的行为。
 */
export function JsonView({ value, defaultOpen = 1 }: { value: unknown; defaultOpen?: number }) {
  const t = useT();
  const [q, setQ] = useState("");
  return (
    <div className="space-y-1.5">
      <label className="flex items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1">
        <Search className="h-3 w-3 shrink-0 text-muted-foreground" />
        <input
          className="min-w-0 flex-1 rounded-sm bg-transparent text-[0.75rem] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          placeholder={t("wf.outputSearch")}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </label>
      <Node name="" value={value} depth={0} defaultOpen={defaultOpen} query={q.trim().toLowerCase()} />
    </div>
  );
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** 一行摘要：不展开时也要说出「里面是什么」，而不是只说「是个对象」。 */
function summarise(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return `[${v.length}]`;
  if (isObj(v)) {
    const keys = Object.keys(v);
    return `{${keys.slice(0, 4).join(", ")}${keys.length > 4 ? ", …" : ""}}`;
  }
  if (typeof v === "string") return v.length > 60 ? `"${v.slice(0, 60)}…"` : `"${v}"`;
  return String(v);
}

/** 这棵子树里有没有命中搜索的东西。命中的路径要自动展开，否则搜了等于没搜。 */
function hits(name: string, v: unknown, q: string, depth = 0): boolean {
  if (!q) return false;
  if (name.toLowerCase().includes(q)) return true;
  if (depth > 6) return false;
  if (typeof v === "string") return v.toLowerCase().includes(q);
  if (typeof v === "number" || typeof v === "boolean") return String(v).includes(q);
  if (Array.isArray(v)) return v.some((x) => hits("", x, q, depth + 1));
  if (isObj(v)) return Object.entries(v).some(([k, x]) => hits(k, x, q, depth + 1));
  return false;
}

function Node({
  name,
  value,
  depth,
  defaultOpen,
  query,
}: {
  name: string;
  value: unknown;
  depth: number;
  defaultOpen: number;
  query: string;
}) {
  const branch = Array.isArray(value) || isObj(value);
  const matched = useMemo(() => (query ? hits(name, value, query) : false), [name, value, query]);
  const [open, setOpen] = useState(depth < defaultOpen);
  const show = query ? matched : true;
  if (!show) return null;
  const expanded = query ? true : open;

  if (!branch)
    return (
      <div className="flex gap-1.5 font-mono text-[0.6875rem] leading-[1.6]" style={{ paddingLeft: depth * 12 }}>
        {name && <span className="shrink-0 text-primary">{name}:</span>}
        <span
          className={cn("min-w-0 break-all", typeof value === "string" ? "text-foreground" : "text-warn")}
        >
          {summarise(value)}
        </span>
      </div>
    );

  const entries: Array<[string, unknown]> = Array.isArray(value)
    ? value.map((v, i) => [String(i), v])
    : Object.entries(value as Record<string, unknown>);

  return (
    <div style={{ paddingLeft: depth * 12 }}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1 text-left font-mono text-[0.6875rem] leading-[1.6] hover:bg-muted/60"
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
        )}
        {name && <span className="text-primary">{name}:</span>}
        <span className="text-muted-foreground">{summarise(value)}</span>
      </button>
      {expanded &&
        entries.map(([k, v]) => (
          <Node key={k} name={k} value={v} depth={depth + 1} defaultOpen={defaultOpen} query={query} />
        ))}
    </div>
  );
}
