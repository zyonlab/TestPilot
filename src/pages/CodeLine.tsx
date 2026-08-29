import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, FileCode2, GitCompare, X } from "lucide-react";
import { useStore } from "@/lib/store";
import { useT } from "@/lib/prefs";
import { API_BASE } from "@/lib/base";
import { cn } from "@/lib/cn";

/**
 * 资产 · 测试代码：**两份代码，不是一份**。
 *
 * 「生成的」属于那次运行——它是流水线的产物，被门禁②打过分，可能被修复环改写过几轮。
 * 「最终可用」属于这条用例——今晚要跑的就是它，批准之后可能已经被人改过。
 * 把两者并成一栏，会让「机器产出了这个」和「跑的是这个」看起来是同一件事，而这恰恰是
 * 出了问题时最需要分开的两件事。所以这一页永远同时给出两份，以及它们之间的差。
 *
 * 页面不重算任何数字：门禁②、修复轮次、退化标记都从产出它的那次运行里读回来，
 * 一个页面不该报出运行本身从未得到过的分数。
 */

interface Row {
  caseId: string;
  title: string;
  hasCode: boolean;
  drifted: boolean;
  degraded: boolean;
  gate2?: number;
  rounds: number;
  sourceRunId?: string;
  outcome?: { status?: string; kind?: string };
  uses: string[];
}

interface Provenance {
  caseId: string;
  title: string;
  current: string;
  generated?: string;
  drifted: boolean;
  sourceRunId?: string;
  sourceCaseId?: string;
  gate2?: number;
  findings: Array<{ rule: string; severity: string; message: string }>;
  rounds: Array<{ round: number; changes: string[] }>;
  degraded: boolean;
  outcome?: { status?: string; kind?: string; ms?: number };
  uses: string[];
}

/**
 * A line diff, kept deliberately small.
 *
 * Longest-common-subsequence over lines: enough to show which assertion was added or
 * weakened, which is the only question this diff is asked. Anything word-level would be
 * more precise about characters and less clear about what changed.
 */
function diffLines(a: string, b: string): Array<{ sign: " " | "-" | "+"; text: string }> {
  const x = a ? a.split("\n") : [];
  const y = b ? b.split("\n") : [];
  const n = x.length;
  const m = y.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);

  const out: Array<{ sign: " " | "-" | "+"; text: string }> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      out.push({ sign: " ", text: x[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ sign: "-", text: x[i++] });
    } else {
      out.push({ sign: "+", text: y[j++] });
    }
  }
  while (i < n) out.push({ sign: "-", text: x[i++] });
  while (j < m) out.push({ sign: "+", text: y[j++] });
  return out;
}

function Pill({ tone, children }: { tone: "good" | "warn" | "bad" | "mute"; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "rounded px-1.5 py-0.5 text-[10.5px] font-medium",
        tone === "good" && "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
        tone === "warn" && "bg-amber-500/15 text-amber-700 dark:text-amber-400",
        tone === "bad" && "bg-rose-500/15 text-rose-700 dark:text-rose-400",
        tone === "mute" && "bg-muted text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

function CodePane({ title, body, empty }: { title: string; body: string; empty: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-border px-3 py-1.5 text-[11px] font-medium text-muted-foreground">{title}</div>
      <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap p-3 font-mono text-[11.5px] leading-relaxed">
        {body || <span className="text-muted-foreground">{empty}</span>}
      </pre>
    </div>
  );
}

function Detail({ p, onClose }: { p: Provenance; onClose: () => void }) {
  const t = useT();
  const [tab, setTab] = useState<"current" | "generated" | "diff">(p.drifted ? "diff" : "current");
  const diff = diffLines(p.generated ?? "", p.current);

  return (
    <aside className="flex w-[520px] flex-none flex-col border-l border-border">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="truncate text-sm font-medium">{p.title}</span>
        <button onClick={onClose} className="ml-auto cursor-pointer text-muted-foreground hover:text-foreground">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-3 py-2 text-[11px] text-muted-foreground">
        {p.gate2 !== undefined && <Pill tone={p.gate2 >= 0.8 ? "good" : "warn"}>{t("code.gate2", { score: p.gate2.toFixed(2) })}</Pill>}
        {p.degraded && <Pill tone="warn">{t("code.degraded")}</Pill>}
        {p.drifted && <Pill tone="warn">{t("code.drifted")}</Pill>}
        {p.outcome?.status && (
          <Pill tone={p.outcome.status === "passed" ? "good" : "bad"}>
            {p.outcome.status}
            {p.outcome.kind ? ` · ${p.outcome.kind}` : ""}
          </Pill>
        )}
        {p.uses.map((u) => (
          <Pill key={u} tone="mute">{u}</Pill>
        ))}
        {p.sourceRunId && <span className="font-mono text-[10.5px]">{p.sourceRunId}</span>}
      </div>

      {p.rounds.length > 0 && (
        <div className="border-b border-border px-3 py-2 text-[11.5px]">
          <div className="mb-1 text-muted-foreground">{t("code.rounds")}</div>
          {p.rounds.map((r) => (
            <div key={r.round} className="font-mono text-[11px]">
              #{r.round} · {r.changes.join(" · ")}
            </div>
          ))}
        </div>
      )}

      {p.findings.length > 0 && (
        <div className="max-h-32 overflow-auto border-b border-border px-3 py-2 text-[11.5px]">
          {p.findings.map((f, i) => (
            <div key={i} className="mb-1 flex gap-1.5">
              <Pill tone={f.severity === "block" ? "bad" : "warn"}>{f.rule}</Pill>
              <span className="text-muted-foreground">{f.message}</span>
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-1 border-b border-border px-2 py-1.5">
        {(["current", "generated", "diff"] as const).map((k) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={cn(
              "cursor-pointer rounded px-2 py-0.5 text-[12px]",
              tab === k ? "bg-primary/10 font-medium text-primary" : "text-muted-foreground hover:bg-muted",
            )}
          >
            {t(`code.tab.${k}`)}
          </button>
        ))}
      </div>

      {tab === "current" && <CodePane title={t("code.tab.current")} body={p.current} empty={t("code.noCurrent")} />}
      {tab === "generated" && (
        <CodePane title={t("code.tab.generated")} body={p.generated ?? ""} empty={t("code.noGenerated")} />
      )}
      {tab === "diff" && (
        <div className="min-h-0 flex-1 overflow-auto p-3 font-mono text-[11.5px] leading-relaxed">
          {!p.generated ? (
            <span className="text-muted-foreground">{t("code.noGenerated")}</span>
          ) : !p.drifted ? (
            <span className="text-muted-foreground">{t("code.sameAsGenerated")}</span>
          ) : (
            diff.map((l, i) => (
              <div
                key={i}
                className={cn(
                  "whitespace-pre-wrap",
                  l.sign === "-" && "bg-rose-500/10 text-rose-700 dark:text-rose-400",
                  l.sign === "+" && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
                  l.sign === " " && "text-muted-foreground",
                )}
              >
                {l.sign} {l.text}
              </div>
            ))
          )}
        </div>
      )}
    </aside>
  );
}

export function CodeLinePage() {
  const t = useT();
  const activeProjectId = useStore((s) => s.activeProjectId);
  const [rows, setRows] = useState<Row[]>([]);
  const [fragments, setFragments] = useState(0);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<Provenance | null>(null);

  useEffect(() => {
    if (!activeProjectId) return;
    setError("");
    setOpen(null);
    fetch(`${API_BASE}/api/projects/${activeProjectId}/code-line`)
      .then((r) => r.json())
      .then((d: { rows?: Row[]; fragments?: number; error?: string }) => {
        if (d.error) return setError(d.error);
        setRows(d.rows ?? []);
        setFragments(d.fragments ?? 0);
      })
      .catch((e) => setError((e as Error).message));
  }, [activeProjectId]);

  const openCase = useCallback((caseId: string) => {
    fetch(`${API_BASE}/api/cases/${caseId}/code`)
      .then((r) => r.json())
      .then((d: { provenance?: Provenance }) => d.provenance && setOpen(d.provenance))
      .catch(() => undefined);
  }, []);

  if (!activeProjectId) return <div className="p-4 text-sm text-muted-foreground">{t("assets.pickProject")}</div>;

  const withCode = rows.filter((r) => r.hasCode);
  const drifted = rows.filter((r) => r.drifted).length;
  const degraded = rows.filter((r) => r.degraded).length;
  const gates = withCode.map((r) => r.gate2).filter((x): x is number => x !== undefined);

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col overflow-auto">
        <div className="flex flex-wrap gap-5 border-b border-border px-4 py-3">
          {[
            { l: t("code.kpiRunnable"), v: `${withCode.length} / ${rows.length}`, tone: withCode.length ? undefined : "warn" },
            { l: t("code.kpiGate2"), v: gates.length ? (gates.reduce((a, b) => a + b, 0) / gates.length).toFixed(2) : "—" },
            { l: t("code.kpiFragments"), v: String(fragments) },
            { l: t("code.kpiDrifted"), v: String(drifted), tone: drifted ? "warn" : undefined },
            { l: t("code.kpiDegraded"), v: String(degraded), tone: degraded ? "warn" : undefined },
          ].map((k) => (
            <div key={k.l} className="min-w-[92px]">
              <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">{k.l}</div>
              <div
                className={cn(
                  "mt-0.5 font-mono text-[15px] tabular-nums",
                  k.tone === "warn" && "text-amber-600 dark:text-amber-400",
                )}
              >
                {k.v}
              </div>
            </div>
          ))}
        </div>

        {error && <div className="px-4 py-2 text-[12px] text-rose-500">{error}</div>}

        {/* The honest empty state: not "no data", but which half of the pipeline never ran. */}
        {withCode.length === 0 && (
          <div className="m-4 flex items-start gap-2 rounded-lg border border-dashed border-border bg-card/50 p-3 text-[12.5px] text-muted-foreground">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-none text-amber-500" />
            <span>{t("code.emptyWhy")}</span>
          </div>
        )}

        <table className="w-full text-[12.5px]">
          <thead className="sticky top-0 bg-muted/50 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-1.5 font-medium">{t("code.colCase")}</th>
              <th className="px-2 py-1.5 font-medium">{t("code.colState")}</th>
              <th className="px-2 py-1.5 font-medium">{t("code.colGate2")}</th>
              <th className="px-2 py-1.5 font-medium">{t("code.colRepair")}</th>
              <th className="px-2 py-1.5 font-medium">{t("code.colLastRun")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.caseId}
                onClick={() => r.hasCode && openCase(r.caseId)}
                className={cn(
                  "border-b border-border/50",
                  r.hasCode ? "cursor-pointer hover:bg-muted/50" : "opacity-60",
                  open?.caseId === r.caseId && "bg-primary/5",
                )}
              >
                <td className="px-4 py-1.5">
                  <span className="line-clamp-1">{r.title}</span>
                </td>
                <td className="px-2 py-1.5">
                  {r.hasCode ? (
                    <span className="flex flex-wrap items-center gap-1">
                      <Pill tone="good">{t("code.runnable")}</Pill>
                      {r.drifted && <Pill tone="warn">{t("code.drifted")}</Pill>}
                      {r.degraded && <Pill tone="warn">{t("code.degraded")}</Pill>}
                    </span>
                  ) : (
                    <Pill tone="mute">{t("code.noCode")}</Pill>
                  )}
                </td>
                <td className="px-2 py-1.5 font-mono text-[11.5px]">{r.gate2?.toFixed(2) ?? "—"}</td>
                <td className="px-2 py-1.5 font-mono text-[11.5px]">{r.rounds ? t("code.roundsN", { n: r.rounds }) : "—"}</td>
                <td className="px-2 py-1.5">
                  {r.outcome?.status ? (
                    <Pill tone={r.outcome.status === "passed" ? "good" : "bad"}>
                      {r.outcome.kind === "infra" ? "infra" : r.outcome.status}
                    </Pill>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <p className="px-4 py-3 text-[12px] leading-relaxed text-muted-foreground">
          <FileCode2 className="mr-1 inline h-3.5 w-3.5" />
          {t("code.layersTodo")}
        </p>
      </div>

      {open && <Detail p={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

/* ------------------------------------------------------------------ */

interface Change {
  kind: "review-edit" | "code-drift";
  at?: string;
  caseId: string;
  title: string;
  fields: string[];
  by: "human" | "model";
  wfRunId?: string;
  note?: string;
}

/**
 * 资产 · 变更：重生成不是覆盖。
 *
 * 两类改动分开列，因为它们的含义不同。**复核期的改写**发生在批准之前——生成的那一批不对，
 * 人（或一次重生成）把它改了，门禁在改后的文本上重新算过分。**批准后的代码偏离**发生在之后：
 * 看板上的代码已经不等于当初那次运行的产物，这是允许的，但必须看得见——从那一刻起，
 * 那次运行的门禁②分数就不再是对「今晚要跑的代码」的陈述了。
 */
export function ChangesPage() {
  const t = useT();
  const activeProjectId = useStore((s) => s.activeProjectId);
  const [rows, setRows] = useState<Change[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!activeProjectId) return;
    setError("");
    fetch(`${API_BASE}/api/projects/${activeProjectId}/changes`)
      .then((r) => r.json())
      .then((d: { changes?: Change[]; error?: string }) => {
        if (d.error) return setError(d.error);
        setRows(d.changes ?? []);
      })
      .catch((e) => setError((e as Error).message));
  }, [activeProjectId]);

  if (!activeProjectId) return <div className="p-4 text-sm text-muted-foreground">{t("assets.pickProject")}</div>;

  return (
    <div className="flex-1 overflow-auto">
      <p className="border-b border-border px-4 py-2 text-[12.5px] text-muted-foreground">{t("changes.lede")}</p>
      {error && <div className="px-4 py-2 text-[12px] text-rose-500">{error}</div>}
      {rows.length === 0 ? (
        <div className="p-4 text-[12.5px] text-muted-foreground">{t("changes.empty")}</div>
      ) : (
        <table className="w-full text-[12.5px]">
          <thead className="bg-muted/50 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-1.5 font-medium">{t("changes.colCase")}</th>
              <th className="px-2 py-1.5 font-medium">{t("changes.colWhat")}</th>
              <th className="px-2 py-1.5 font-medium">{t("changes.colWho")}</th>
              <th className="px-2 py-1.5 font-medium">{t("changes.colWhen")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.caseId}-${i}`} className="border-b border-border/50">
                <td className="px-4 py-1.5">
                  <span className="line-clamp-1">{r.title}</span>
                  {r.wfRunId && <div className="font-mono text-[10.5px] text-muted-foreground">{r.wfRunId}</div>}
                </td>
                <td className="px-2 py-1.5">
                  <span className="flex flex-wrap items-center gap-1">
                    {r.kind === "code-drift" && (
                      <Pill tone="warn">
                        <GitCompare className="mr-0.5 inline h-3 w-3" />
                        {t("changes.codeDrift")}
                      </Pill>
                    )}
                    {r.fields.map((f) => (
                      <Pill key={f} tone="mute">{f}</Pill>
                    ))}
                  </span>
                  {r.note && <div className="text-[11px] text-muted-foreground">{r.note}</div>}
                </td>
                <td className="px-2 py-1.5">
                  <Pill tone={r.by === "model" ? "warn" : "good"}>
                    {r.by === "model" ? t("changes.byModel") : t("changes.byHuman")}
                  </Pill>
                </td>
                <td className="px-2 py-1.5 font-mono text-[11px] text-muted-foreground">
                  {r.at ? r.at.slice(0, 16).replace("T", " ") : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
