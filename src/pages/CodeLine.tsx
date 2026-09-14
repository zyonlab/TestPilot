import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, FileCode2, GitCompare, X } from "lucide-react";
import { NeedProject } from "@/components/NeedProject";
import { useStore } from "@/lib/store";
import { useT } from "@/lib/prefs";
import { hasKey } from "@/lib/i18n";
import { TopBar } from "@/components/TopBar";
import { API_BASE } from "@/lib/base";
import { runFromHash } from "@/lib/wf";
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
  stoppedBecause?: string;
  /** 机器可读的停止原因。有它就本地化，没有才退回那句英文。 */
  stopReason?: { reason: string; n?: number };
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
  rounds: Array<{
    round: number;
    changes: string[];
    note?: string;
    codeBefore?: string;
    codeAfter?: string;
  }>;
  /** 修复为什么不再往下改——四种理由，最后一种是模型说「这是产品缺陷」。 */
  stoppedBecause?: string;
  /** 机器可读的停止原因。有它就本地化，没有才退回那句英文。 */
  stopReason?: { reason: string; n?: number };
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
function diffLines(a: string, b: string): Array<{ sign: "" | "-" | "+"; text: string }> {
  const x = a ? a.split("\n") : [];
  const y = b ? b.split("\n") : [];
  const n = x.length;
  const m = y.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);

  const out: Array<{ sign: "" | "-" | "+"; text: string }> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      out.push({ sign: "", text: x[i] });
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
        "rounded px-1.5 py-0.5 text-[0.6875rem] font-medium",
        tone === "good" && "bg-ok-soft text-ok",
        tone === "warn" && "bg-warn-soft text-warn",
        tone === "bad" && "bg-bad-soft text-bad",
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
      <div className="border-b border-border px-3 py-1.5 text-[0.6875rem] font-medium text-muted-foreground">
        {title}
      </div>
      <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap p-3 font-mono text-[0.75rem] leading-relaxed">
        {body || <span className="text-muted-foreground">{empty}</span>}
      </pre>
    </div>
  );
}

/** 四种停下来的理由里，只有这一种说的是「产品错了」。 */
function isProductDefect(reason: string): boolean {
  return reason.includes("product defect") || reason.includes("产品缺陷");
}

/**
 * 一轮修复：折叠时是一行标签，展开是那一轮的 diff。
 *
 * 说了「断言被改松」却不给改前改后，等于要求人凭一枚标签判断一次修复诚不诚实。
 * 被改松的那几行本来就是 diff 里的减号行，所以 assertionWeakened 那一档直接把
 * 减号行高亮出来——不需要另一套标注。
 */
function RoundRow({
  r,
  onRevert,
}: {
  r: Provenance["rounds"][number];
  onRevert?: (round: number, code: string) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const weakened = r.changes.includes("assertion-semantics") || r.changes.includes("case-removed");
  const canDiff = !!r.codeBefore || !!r.codeAfter;
  const diff = canDiff ? diffLines(r.codeBefore ?? "", r.codeAfter ?? "") : [];

  return (
    <div className="mb-1">
      <div className="flex items-center gap-2">
        <button
          className="cursor-pointer font-mono text-[0.6875rem] hover:text-foreground disabled:cursor-default disabled:opacity-60"
          onClick={() => setOpen((v) => !v)}
          disabled={!canDiff}
          title={canDiff ? undefined : t("code.roundNoCode")}
        >
          {canDiff ? (open ? "▾" : "▸") : "·"} #{r.round} · {r.changes.join(" · ")}
        </button>
        {weakened && <Pill tone="warn">{t("code.weakened")}</Pill>}
        {/* 退回到某一轮：把那一轮的代码放回用例，不重新生成。
            重生成会得到另一段代码，那就不是「退回」了。 */}
        {onRevert && r.codeBefore && (
          <button
            className="ml-auto cursor-pointer text-[0.6875rem] text-muted-foreground underline decoration-dotted hover:text-foreground"
            onClick={() => onRevert(r.round, r.codeBefore!)}
            title={t("code.revertWhy", { n: String(r.round) })}
          >
            {t("code.revertTo", { n: String(r.round) })}
          </button>
        )}
      </div>
      {r.note && <div className="pl-4 text-[0.6875rem] text-muted-foreground">{r.note}</div>}
      {open && (
        <pre className="mt-1 max-h-56 overflow-auto rounded bg-muted p-2 font-mono text-[0.6875rem] leading-relaxed">
          {diff.map((l, i) => (
            <div
              key={i}
              className={cn(
                l.sign === "+" && "text-ok",
                l.sign === "-" && "text-bad",
                // 断言被改松时，减号行就是被删掉的那几行断言——高亮它们。
                l.sign === "-" && weakened && "bg-bad-soft font-medium",
              )}
            >
              {l.sign}
              {l.text}
            </div>
          ))}
        </pre>
      )}
    </div>
  );
}

function Detail({
  p,
  onClose,
  onRevert,
}: {
  p: Provenance;
  onClose: () => void;
  onRevert?: (round: number, code: string) => void;
}) {
  const t = useT();
  const [tab, setTab] = useState<"current" | "generated" | "diff">(p.drifted ? "diff" : "current");
  const diff = diffLines(p.generated ?? "", p.current);

  return (
    <aside className="flex w-[32.5rem] flex-none flex-col border-l border-border">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="truncate text-sm font-medium">{p.title}</span>
        <button
          onClick={onClose}
          className="ml-auto cursor-pointer text-muted-foreground hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-3 py-2 text-[0.6875rem] text-muted-foreground">
        {p.gate2 !== undefined && (
          <Pill tone={p.gate2 >= 0.8 ? "good" : "warn"}>
            {t("code.gate2", { score: p.gate2.toFixed(2) })}
          </Pill>
        )}
        {p.degraded && <Pill tone="warn">{t("code.degraded")}</Pill>}
        {p.drifted && <Pill tone="warn">{t("code.drifted")}</Pill>}
        {p.outcome?.status && (
          <Pill tone={p.outcome.status === "passed" ? "good" : "bad"}>
            {p.outcome.status}
            {p.outcome.kind ? ` · ${p.outcome.kind}` : ""}
          </Pill>
        )}
        {p.uses.map((u) => (
          <Pill key={u} tone="mute">
            {u}
          </Pill>
        ))}
        {p.sourceRunId && <span className="font-mono text-[0.6875rem]">{p.sourceRunId}</span>}
      </div>

      {/* 修复为什么停下来。四种理由此前在前端一个渲染点都没有，
          而「模型判定这是产品缺陷、拒绝再改」是这条流水线上最有价值的一句输出。 */}
      {p.stoppedBecause && (
        <div
          className={cn(
            "border-b px-3 py-2 text-[0.75rem]",
            isProductDefect(p.stoppedBecause)
              ? "border-chat bg-chat-soft text-chat"
              : "border-border text-muted-foreground",
          )}
        >
          <span className="font-medium">{t("code.stoppedBecause")}</span>{" "}
          {/* 有码就翻，没有才退回服务端那句英文——旧的运行记录里没有这个码。 */}
          {p.stopReason && hasKey(`code.stop.${p.stopReason.reason}`)
            ? t(`code.stop.${p.stopReason.reason}`, { n: p.stopReason.n ?? 0 })
            : p.stoppedBecause}
          {isProductDefect(p.stoppedBecause) && (
            <div className="mt-1 text-[0.6875rem] opacity-80">{t("code.productDefectWhy")}</div>
          )}
        </div>
      )}

      {p.rounds.length > 0 && (
        <div className="max-h-72 overflow-auto border-b border-border px-3 py-2 text-[0.75rem]">
          <div className="mb-1 text-muted-foreground">{t("code.rounds")}</div>
          {p.rounds.map((r) => (
            <RoundRow key={r.round} r={r} onRevert={onRevert} />
          ))}
        </div>
      )}

      {p.findings.length > 0 && (
        <div className="max-h-32 overflow-auto border-b border-border px-3 py-2 text-[0.75rem]">
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
              "cursor-pointer rounded px-2 py-0.5 text-[0.75rem]",
              tab === k ? "bg-primary/10 font-medium text-primary" : "text-muted-foreground hover:bg-muted",
            )}
          >
            {t(`code.tab.${k}`)}
          </button>
        ))}
      </div>

      {tab === "current" && (
        <CodePane title={t("code.tab.current")} body={p.current} empty={t("code.noCurrent")} />
      )}
      {tab === "generated" && (
        <CodePane title={t("code.tab.generated")} body={p.generated ?? ""} empty={t("code.noGenerated")} />
      )}
      {tab === "diff" && (
        <div className="min-h-0 flex-1 overflow-auto p-3 font-mono text-[0.75rem] leading-relaxed">
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
                  l.sign === "-" && "bg-bad-soft text-bad",
                  l.sign === "+" && "bg-ok-soft text-ok",
                  l.sign === "" && "text-muted-foreground",
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

/** 这次运行生成的代码。属于运行，不属于看板——所以只读，也不进 KPI。 */
interface Candidate {
  caseId: string;
  title: string;
  code: string;
}

export function CodeLinePage() {
  const t = useT();
  const activeProjectId = useStore((s) => s.activeProjectId);
  const [rows, setRows] = useState<Row[]>([]);
  const [fragments, setFragments] = useState(0);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<Provenance | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const candidateRun = runFromHash();

  /**
   * 地址栏里那次运行的候选代码。
   *
   * 读它是为了让这一页能同时说出两件事。画布上的产物卡说「用例代码 38」，点进来说 0——
   * 两个数都对（一个数的是这次运行，一个数的是这个项目的看板），可是这一页此前只说后者，
   * 于是那两个数看起来就是在互相打脸，而没有任何一处解释它们数的不是同一样东西。
   */
  useEffect(() => {
    if (!candidateRun) return setCandidates([]);
    let alive = true;
    fetch(`${API_BASE}/api/wf/runs/${candidateRun}/nodes/repair`)
      .then((r) => r.json())
      .then((d: { output?: { code?: Candidate[] } }) => alive && setCandidates(d.output?.code ?? []))
      .catch(() => alive && setCandidates([]));
    return () => {
      alive = false;
    };
  }, [candidateRun]);

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

  /**
   * 把用例的代码退回到某一轮修复之前的样子。
   *
   * 写回的是**存下来的那一段**，不是重新生成的——重生成会得到另一段代码，
   * 那就不叫「退回」了。写完重新拉一次这一页：退回之后 drifted 会变，
   * 而这一页的规矩是数字全部从服务端读回来，不在前端自己算。
   */
  const revertTo = useCallback(
    async (caseId: string, round: number, code: string) => {
      await fetch(`${API_BASE}/api/cases/${caseId}/code`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, note: t("code.revertNote", { round }) }),
      }).catch(() => undefined);
      openCase(caseId);
      if (activeProjectId)
        fetch(`${API_BASE}/api/projects/${activeProjectId}/code-line`)
          .then((r) => r.json())
          .then((dd: { rows?: Row[] }) => setRows(dd.rows ?? []))
          .catch(() => undefined);
    },
    [activeProjectId, openCase],
  );

  /**
   * 没选项目也要能看这次运行的候选代码。
   *
   * 候选属于**运行**，不属于项目——一个 `#/?open=code&run=wf-xxx` 的链接发给别人，
   * 对方那边没有「当前项目」，此前看到的就是一句「先在顶栏选一个项目」，
   * 而他要看的那 38 段代码明明就在这次运行里。
   */
  if (!activeProjectId)
    return (
      <>
        <TopBar title={t("surface.code")} />
        <div className="flex-1 overflow-auto p-4">
          <div className="p-4"><NeedProject /></div>
          {!!candidates.length && (
            <div className="mt-3 rounded-lg border border-border bg-card">
              <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-[0.75rem]">
                <span className="font-medium">{t("code.candidatesTitle", { n: candidates.length })}</span>
                <span className="font-mono text-[0.6875rem] text-muted-foreground">{candidateRun}</span>
                <span className="text-[0.75rem] text-muted-foreground">{t("code.candidatesWhy")}</span>
              </div>
              <div className="max-h-[60vh] overflow-auto">
                {candidates.map((c) => (
                  <div key={c.caseId} className="border-b border-border/50 px-3 py-2 last:border-b-0">
                    <div className="text-[0.8125rem]">{c.title}</div>
                    <pre className="mt-1 overflow-x-auto whitespace-pre-wrap rounded bg-muted p-1.5 font-mono text-[0.6875rem] text-muted-foreground">
                      {c.code}
                    </pre>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </>
    );

  const withCode = rows.filter((r) => r.hasCode);
  const drifted = rows.filter((r) => r.drifted).length;
  const degraded = rows.filter((r) => r.degraded).length;
  const gates = withCode.map((r) => r.gate2).filter((x): x is number => x !== undefined);

  return (
    <>
      <TopBar title={t("surface.code")} />
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col overflow-auto">
          <div className="flex flex-wrap gap-5 border-b border-border px-4 py-3">
            {[
              {
                l: t("code.kpiRunnable"),
                v: `${withCode.length} / ${rows.length}`,
                tone: withCode.length ? undefined : "warn",
              },
              {
                l: t("code.kpiGate2"),
                v: gates.length ? (gates.reduce((a, b) => a + b, 0) / gates.length).toFixed(2) : "—",
              },
              { l: t("code.kpiFragments"), v: String(fragments) },
              { l: t("code.kpiDrifted"), v: String(drifted), tone: drifted ? "warn" : undefined },
              { l: t("code.kpiDegraded"), v: String(degraded), tone: degraded ? "warn" : undefined },
            ].map((k) => (
              <div key={k.l} className="min-w-[5.75rem]">
                <div className="font-mono text-[0.6875rem] uppercase tracking-wider text-muted-foreground/70">
                  {k.l}
                </div>
                <div
                  className={cn(
                    "mt-0.5 font-mono text-[1.0625rem] tabular-nums",
                    k.tone === "warn" && "text-warn",
                  )}
                >
                  {k.v}
                </div>
              </div>
            ))}
          </div>

          {error && <div className="px-4 py-2 text-[0.75rem] text-bad">{error}</div>}

          {/* The honest empty state: not"no data", but which half of the pipeline never ran. */}
          {withCode.length === 0 && (
            <div className="m-4 space-y-2">
              <div className="flex items-start gap-2 rounded-lg border border-dashed border-border bg-card/50 p-3 text-[0.8125rem] text-muted-foreground">
                <AlertTriangle className="mt-0.5 h-4 w-4 flex-none text-warn" />
                <span>{t("code.emptyWhy")}</span>
              </div>
              {/*
              画布上的产物卡说「用例代码 38」，点进来说 0——两个数都对，数的不是同一样东西，
              可这一页此前不把另一样摆出来，于是那两个数看起来就是在互相打脸。
              候选代码就地列出来：它属于那次运行，所以标签不同、只读、也不进上面那几个 KPI。
            */}
              {!!candidates.length && (
                <div className="rounded-lg border border-border bg-card">
                  <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-[0.75rem]">
                    <span className="font-medium">{t("code.candidatesTitle", { n: candidates.length })}</span>
                    <span className="font-mono text-[0.6875rem] text-muted-foreground">{candidateRun}</span>
                    <span className="text-[0.75rem] text-muted-foreground">{t("code.candidatesWhy")}</span>
                  </div>
                  <div className="max-h-80 overflow-auto">
                    {candidates.map((c) => (
                      <div key={c.caseId} className="border-b border-border/50 px-3 py-2 last:border-b-0">
                        <div className="text-[0.8125rem]">{c.title}</div>
                        <pre className="mt-1 overflow-x-auto whitespace-pre-wrap rounded bg-muted p-1.5 font-mono text-[0.6875rem] text-muted-foreground">
                          {c.code}
                        </pre>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          <table className="w-full text-[0.8125rem]">
            <thead className="sticky top-0 bg-muted/50 text-left text-[0.6875rem] uppercase tracking-wide text-muted-foreground">
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
                  <td className="px-2 py-1.5 font-mono text-[0.75rem]">{r.gate2?.toFixed(2) ?? "—"}</td>
                  <td className="px-2 py-1.5 font-mono text-[0.75rem]">
                    {r.rounds ? t("code.roundsN", { n: r.rounds }) : "—"}
                    {/* 模型说「这是产品缺陷」的那一条，在列表上就要看得见——
                      它是这条流水线上最有价值的一句输出，不该只躺在详情里。 */}
                    {r.stoppedBecause && isProductDefect(r.stoppedBecause) && (
                      <span className="ml-1.5 rounded bg-chat-soft px-1.5 py-0.5 text-[0.6875rem] font-medium text-chat">
                        {t("code.productDefect")}
                      </span>
                    )}
                  </td>
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

          {/* 守住行宽：这一段在宽屏上跑到 175 字符一行，而且右边顶到视口。
              一行超过八十来个字符，眼睛回到行首时会找错行。 */}
          <p className="max-w-[72ch] px-4 py-3 text-[0.75rem] leading-relaxed text-muted-foreground">
            <FileCode2 className="mr-1 inline h-3.5 w-3.5" />
            {t("code.layersTodo")}
          </p>
        </div>

        {open && (
          <Detail
            p={open}
            onClose={() => setOpen(null)}
            onRevert={(round, code) => void revertTo(open.caseId, round, code)}
          />
        )}
      </div>
    </>
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

  if (!activeProjectId)
    return (
      <>
        <TopBar title={t("surface.changes")} />
        <div className="p-4"><NeedProject /></div>
      </>
    );

  return (
    <>
      <TopBar title={t("surface.changes")} hint={t("changes.lede")} />
      <div className="flex-1 overflow-auto">
        {error && <div className="px-4 py-2 text-[0.75rem] text-bad">{error}</div>}
        {rows.length === 0 ? (
          <div className="p-4 text-[0.8125rem] text-muted-foreground">{t("changes.empty")}</div>
        ) : (
          <table className="w-full text-[0.8125rem]">
            <thead className="bg-muted/50 text-left text-[0.6875rem] uppercase tracking-wide text-muted-foreground">
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
                    {r.wfRunId && (
                      <div className="font-mono text-[0.6875rem] text-muted-foreground">{r.wfRunId}</div>
                    )}
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
                        <Pill key={f} tone="mute">
                          {f}
                        </Pill>
                      ))}
                    </span>
                    {r.note && <div className="text-[0.6875rem] text-muted-foreground">{r.note}</div>}
                  </td>
                  <td className="px-2 py-1.5">
                    <Pill tone={r.by === "model" ? "warn" : "good"}>
                      {r.by === "model" ? t("changes.byModel") : t("changes.byHuman")}
                    </Pill>
                  </td>
                  <td className="px-2 py-1.5 font-mono text-[0.6875rem] text-muted-foreground">
                    {r.at ? r.at.slice(0, 16).replace("T", " ") : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
