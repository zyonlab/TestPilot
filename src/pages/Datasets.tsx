import { useCallback, useEffect, useState } from "react";
import { Database, Trash2, Upload, AlertTriangle, KeyRound } from "lucide-react";
import { Button } from "@/components/ui";
import { useStore } from "@/lib/store";
import { useT } from "@/lib/prefs";
import { cn } from "@/lib/cn";
import { API_BASE } from "@/lib/base";

/**
 * 测试数据集。
 *
 * 在这之前数据只有两个去处：写死在步骤里（换个环境跑不了，跑第二遍撞唯一约束，
 * 而且进了版本库），或者塞进环境变量的数组（能跑，但没有名字、没有列、没有界面，
 * 只能手改 JSON）。
 *
 * 这一页的形状取自 E2E 测试数据的通行做法，三条：
 *
 * ① **先预览再落库。** 一份列名解析错的数据集，症状不是报错，是二十分钟后一批
 *    「断言没通过」——而错的是数据不是产品。所以预览是必经的一步，不是可选的便利。
 *
 * ② **像凭证的列当场警告。** 数据集会跟着导出的工程进版本库，凭证不能。
 *    只警告不拦：判断一列是不是凭证最终要人来看。
 *
 * ③ **「谁在用它」跟列表一起显示。** 一个不知道被谁用着的数据集，没人敢删。
 */

interface Dataset {
  id: string;
  name: string;
  columns: string[];
  rows: Array<Record<string, string>>;
  uniqueCols: string[];
  usedBy: Array<{ id: string; title: string }>;
}

interface Preview {
  format: "json" | "csv";
  columns: string[];
  rows: Array<Record<string, string>>;
  total: number;
  warnings: Array<{ kind: string; column?: string; message: string }>;
}

export function DatasetsPage() {
  const t = useT();
  const projectId = useStore((s) => s.activeProjectId);
  const [sets, setSets] = useState<Dataset[]>([]);
  const [error, setError] = useState("");

  const [text, setText] = useState("");
  const [name, setName] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [uniqueCols, setUniqueCols] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!projectId) return;
    try {
      const d = (await fetch(`${API_BASE}/api/projects/${projectId}/datasets`).then((r) => r.json())) as {
        datasets?: Dataset[];
        error?: string;
      };
      if (d.error) return setError(d.error);
      setSets(d.datasets ?? []);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  /** 解析但不落库。解析失败要说清楚哪一行错了，而不是「导入失败」。 */
  const doPreview = async (src: string) => {
    setError("");
    setPreview(null);
    if (!src.trim()) return;
    const d = (await fetch(`${API_BASE}/api/datasets/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: src }),
    }).then((r) => r.json())) as Preview & { error?: string };
    if (d.error) return setError(d.error);
    setPreview(d);
    setUniqueCols([]);
  };

  const commit = async () => {
    if (!preview || !name.trim() || !projectId) return;
    setBusy(true);
    setError("");
    const d = (await fetch(`${API_BASE}/api/projects/${projectId}/datasets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim(), text, uniqueCols }),
    }).then((r) => r.json())) as { error?: string };
    setBusy(false);
    if (d.error) return setError(d.error);
    setText("");
    setName("");
    setPreview(null);
    setUniqueCols([]);
    void load();
  };

  const remove = async (d: Dataset) => {
    if (d.usedBy.length && !window.confirm(t("data.deleteUsed", { n: d.usedBy.length }))) return;
    await fetch(`${API_BASE}/api/datasets/${d.id}`, { method: "DELETE" });
    void load();
  };

  if (!projectId)
    return <div className="p-4 text-sm text-muted-foreground">{t("assets.pickProject")}</div>;

  return (
    <div className="flex-1 overflow-auto p-4">
      <div className="max-w-4xl space-y-4">
        <div>
          <h2 className="flex items-center gap-2 font-display text-sm font-semibold">
            <Database className="h-4 w-4 text-primary" />
            {t("data.title")}
          </h2>
          <p className="mt-1 max-w-2xl text-[13px] text-muted-foreground">{t("data.lede")}</p>
        </div>

        {/* ---- 导入 ---- */}
        <div className="rounded-xl border border-border bg-card p-3">
          <div className="mb-2 flex items-center gap-2">
            <Upload className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-[12.5px] font-medium">{t("data.importTitle")}</span>
            <span className="text-[11.5px] text-muted-foreground">{t("data.importHint")}</span>
          </div>
          <textarea
            className="h-28 w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 font-mono text-[11.5px]"
            placeholder={"first,last,city\nJohn,Doe,Springfield\nJane,Roe,Madison"}
            value={text}
            spellCheck={false}
            onChange={(e) => setText(e.target.value)}
            onBlur={(e) => void doPreview(e.target.value)}
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button onClick={() => void doPreview(text)} disabled={!text.trim()}>
              {t("data.parse")}
            </Button>
            {preview && (
              <>
                <input
                  className="w-44 rounded-md border border-border bg-background px-2 py-1 text-[12px]"
                  placeholder={t("data.namePlaceholder")}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
                <Button variant="primary" onClick={() => void commit()} disabled={!name.trim() || busy}>
                  {t("data.save")}
                </Button>
              </>
            )}
          </div>

          {error && <p className="mt-2 text-[12px] text-rose-500">{error}</p>}

          {preview && (
            <div className="mt-3 space-y-2">
              <div className="text-[11.5px] text-muted-foreground">
                {t("data.parsed", { format: preview.format.toUpperCase(), n: preview.total, cols: preview.columns.length })}
              </div>

              {preview.warnings.map((w, i) => (
                <div
                  key={i}
                  className={cn(
                    "flex items-start gap-1.5 rounded-md border px-2 py-1.5 text-[11.5px]",
                    w.kind === "secretish"
                      ? "border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300"
                      : "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300",
                  )}
                >
                  {w.kind === "secretish" ? (
                    <KeyRound className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  ) : (
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  )}
                  <span>{w.message}</span>
                </div>
              ))}

              <Table columns={preview.columns} rows={preview.rows} total={preview.total} t={t} />

              {/*
                标唯一：会落进被测产品的列（用户名、邮箱、单号）该标上。
                「跑第二遍撞已存在」是 E2E 最常复发的一种失败，而它每次看起来都像产品坏了。
                不默认全开——给密码加后缀会让每一行都登不上去。
              */}
              <div className="rounded-md border border-dashed border-border p-2">
                <div className="mb-1 text-[11.5px] text-muted-foreground">{t("data.uniqueHint")}</div>
                <div className="flex flex-wrap gap-1.5">
                  {preview.columns.map((c) => (
                    <button
                      key={c}
                      onClick={() =>
                        setUniqueCols((u) => (u.includes(c) ? u.filter((x) => x !== c) : [...u, c]))
                      }
                      className={cn(
                        "rounded px-1.5 py-0.5 font-mono text-[11px]",
                        uniqueCols.includes(c)
                          ? "bg-primary text-primary-foreground"
                          : "bg-muted text-muted-foreground hover:brightness-95",
                      )}
                    >
                      {c}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ---- 已有的 ---- */}
        {sets.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border p-6 text-center text-[13px] text-muted-foreground">
            {t("data.empty")}
          </p>
        ) : (
          sets.map((d) => (
            <div key={d.id} className="rounded-xl border border-border bg-card p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-[12.5px] font-medium">{d.name}</span>
                <span className="text-[11.5px] text-muted-foreground">
                  {t("data.shape", { rows: d.rows.length, cols: d.columns.length })}
                </span>
                {d.uniqueCols.map((c) => (
                  <span
                    key={c}
                    title={t("data.uniqueWhy")}
                    className="rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[10.5px] text-primary"
                  >
                    {t("data.uniqueTag", { col: c })}
                  </span>
                ))}
                <span className="ml-auto text-[11.5px] text-muted-foreground">
                  {d.usedBy.length
                    ? t("data.usedBy", { n: d.usedBy.length })
                    : t("data.usedByNone")}
                </span>
                <button
                  onClick={() => void remove(d)}
                  title={t("common.delete")}
                  className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-rose-500"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
              {/* 用例名字要列出来：知道被谁用着，才敢改它。 */}
              {!!d.usedBy.length && (
                <div className="mt-1 truncate text-[11px] text-muted-foreground">
                  {d.usedBy.map((c) => c.title).join(" · ")}
                </div>
              )}
              <div className="mt-2">
                <Table columns={d.columns} rows={d.rows.slice(0, 5)} total={d.rows.length} t={t} />
              </div>
              <p className="mt-1.5 font-mono text-[10.5px] text-muted-foreground">
                {t("data.useIt", { name: d.name, ref: "${row." + (d.columns[0] ?? "col") + "}" })}
              </p>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function Table({
  columns,
  rows,
  total,
  t,
}: {
  columns: string[];
  rows: Array<Record<string, string>>;
  total: number;
  t: (k: string, v?: Record<string, string | number>) => string;
}) {
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full text-[11.5px]">
        <thead className="bg-muted/60 text-left text-muted-foreground">
          <tr>
            {columns.map((c) => (
              <th key={c} className="px-2 py-1 font-mono font-medium">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 8).map((r, i) => (
            <tr key={i} className="border-t border-border/60">
              {columns.map((c) => (
                <td key={c} className="max-w-[220px] truncate px-2 py-1" title={r[c]}>
                  {r[c] || <span className="text-muted-foreground/60">—</span>}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {total > 8 && (
        <div className="border-t border-border/60 px-2 py-1 text-[11px] text-muted-foreground">
          {t("data.more", { n: total - 8 })}
        </div>
      )}
    </div>
  );
}
