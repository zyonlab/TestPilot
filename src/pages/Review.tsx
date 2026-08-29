import { useEffect, useRef, useState } from "react";
import { ClipboardCheck, Check, X, ChevronDown, ChevronRight, Wand2, Undo2, Replace, Save } from "lucide-react";
import { TopBar } from "@/components/TopBar";
import { Button } from "@/components/ui";
import { useT } from "@/lib/prefs";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/cn";
import { API_BASE } from "@/lib/base";
import { stopReason } from "@/lib/stopReason";

/**
 * The review queue.
 *
 * What a workflow produced, with what the gates thought of it, waiting for someone to say
 * whether it belongs in the suite. Approving creates the case; rejecting is remembered so
 * the queue stops offering it.
 */

const API = API_BASE;

interface Finding {
  rule: string;
  severity: string;
  message: string;
}

interface ReviewEdit {
  by?: "human" | "model";
  priority?: string;
  note?: string;
}

interface ReviewItem {
  caseId: string;
  title: string;
  storyId: string;
  designMethod: string;
  tier: number;
  precondition: string[];
  steps: string[];
  expected: string;
  findings: Finding[];
  code?: string;
  codeBlocked?: boolean;
  codeFindings?: Finding[];
  degraded?: boolean;
  decision?: "approved" | "rejected";
  createdCaseId?: string;
  /** What the harness produced, when an edit has been made on top of it. */
  original?: {
    title: string;
    steps: string[];
    expected: string;
    precondition: string[];
    tier: number;
    designMethod: string;
  };
  edit?: ReviewEdit;
  editedFindings?: Finding[];
}

interface Story {
  id: string;
  title: string;
  activity?: string;
  flowId?: string;
  role?: string;
  benefit?: string;
  acceptance: string[];
}

interface Gap {
  activity?: string;
  /**
   * 三类的分法是**人要怎么处置**，不是它从哪来：
   *   missed 补一条用例 · unseen 重跑探索 · blind **改断言**
   */
  reach: "missed" | "unseen" | "blind";
  kind: "transition" | "flow" | "module" | "link" | "blocked" | "unknown" | "mutant";
  what: string;
  detail?: string;
  /** 它落在产品地图的哪一处。没有落点的缺口（规格疑问、变异盲区）不给可点样式。 */
  anchor?: { kind: "edge"; from: string; to: string } | { kind: "state"; id: string };
}

interface Batch {
  wfRunId: string;
  projectId?: string;
  gateScore?: number;
  editedGateScore?: number;
  edited: number;
  stories?: Story[];
  items: ReviewItem[];
  pending: number;
  gaps?: Gap[];
  exploreStoppedBecause?: string;
  exploreStopped?: { kind: string; n?: number };
  /** 没跑过变异测试时是 undefined——和「0 分」是两回事，界面上必须分得开。 */
  mutation?: {
    score: number;
    killed: number;
    survived: number;
    inconclusive: number;
    notApplied: number;
    cases: number;
  };
}

interface RunRow {
  wfRunId: string;
  graphId: string;
  pending: number;
  total: number;
  startedAt?: string;
}

/**
 * 批次的标识是**时间**，不是那串哈希。
 *
 * 一排 `wf-mtd7gcdk · 40/40` 里，人认不出哪一批是自己要复核的那一批，
 * 也没法跟别人说「看第三个」。哈希留在 title 里，需要的人 hover 得到。
 */
function batchStamp(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(5, 16).replace("T", " ");
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const TIER_LABEL: Record<number, string> = { 1: "t1 assert", 2: "t2 invariant", 3: "t3 judge" };

/**
 * What changed, field by field.
 *
 * Shown rather than merged away because the two versions answer different questions: the
 * product is what the gate scored and what the next version of the harness gets compared
 * against, while the edited one is what would land on the board.
 */
function EditDiff({ item }: { item: ReviewItem }) {
  const t = useT();
  const o = item.original;
  if (!o) return null;

  const rows: Array<{ label: string; from: string; to: string }> = [];
  if (o.title !== item.title) rows.push({ label: "title", from: o.title, to: item.title });
  if (o.expected !== item.expected) rows.push({ label: "expected", from: o.expected, to: item.expected });
  if (o.tier !== item.tier) rows.push({ label: "tier", from: `t${o.tier}`, to: `t${item.tier}` });
  if (o.designMethod !== item.designMethod)
    rows.push({ label: "method", from: o.designMethod, to: item.designMethod });
  if (o.precondition.join(" · ") !== item.precondition.join(" · "))
    rows.push({ label: "precondition", from: o.precondition.join(" · "), to: item.precondition.join(" · ") });
  // Steps line by line: "the steps changed" is not an answer to "what did you change".
  const stepCount = Math.max(o.steps.length, item.steps.length);
  for (let i = 0; i < stepCount; i++)
    if (o.steps[i] !== item.steps[i])
      rows.push({ label: `step ${i + 1}`, from: o.steps[i] ?? "—", to: item.steps[i] ?? "—" });

  if (!rows.length) return null;
  return (
    <div className="rounded-lg border border-border bg-muted/40 p-2">
      <div className="mb-1 text-[11px] font-medium text-muted-foreground">
        {t("review.diff")}
        {item.edit?.by === "model" && <span className="ml-2 text-sky-600">{t("review.byModel")}</span>}
      </div>
      <table className="w-full table-fixed border-collapse text-[11px]">
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} className="align-top">
              <td className="w-20 py-0.5 pr-2 font-mono text-muted-foreground">{r.label}</td>
              <td className="w-1/2 py-0.5 pr-2 text-rose-600 line-through decoration-rose-400/60">{r.from}</td>
              <td className="py-0.5 text-emerald-700 dark:text-emerald-400">{r.to}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface Draft {
  title: string;
  steps: string;
  expected: string;
}

/** The case, editable. One step per line — the shape people actually paste in and out of. */
function EditForm({
  draft,
  onChange,
  onSave,
  onRevert,
  canRevert,
  busy,
}: {
  draft: Draft;
  onChange: (d: Draft) => void;
  onSave: () => void;
  onRevert: () => void;
  canRevert: boolean;
  busy: boolean;
}) {
  const t = useT();
  return (
    <div className="space-y-1.5">
      <input
        className="w-full rounded-md border border-border bg-card px-2 py-1 text-[12px]"
        value={draft.title}
        onChange={(e) => onChange({ ...draft, title: e.target.value })}
      />
      <textarea
        className="h-20 w-full resize-y rounded-md border border-border bg-card px-2 py-1 font-mono text-[11px]"
        value={draft.steps}
        spellCheck={false}
        onChange={(e) => onChange({ ...draft, steps: e.target.value })}
      />
      <textarea
        className="h-14 w-full resize-y rounded-md border border-border bg-card px-2 py-1 text-[12px]"
        value={draft.expected}
        spellCheck={false}
        onChange={(e) => onChange({ ...draft, expected: e.target.value })}
      />
      <div className="flex items-center gap-2">
        <Button variant="primary" disabled={busy} onClick={onSave}>
          <Save className="h-3.5 w-3.5" />
          {t("review.saveEdit")}
        </Button>
        {canRevert && (
          <Button disabled={busy} onClick={onRevert}>
            <Undo2 className="h-3.5 w-3.5" />
            {t("review.revert")}
          </Button>
        )}
        <span className="text-[10px] text-muted-foreground">{t("review.editHint")}</span>
      </div>
    </div>
  );
}

/**
 * 故事地图。
 *
 * 复核 80 条扁平条目，人只能一条条看——那是**粒度**问题，不只是界面问题。
 * 地图把复核单位从「一条断言」变成「一条流程」：横轴是用户活动（骨架），
 * 纵轴是活动下的故事，故事下面挂着它的用例。
 *
 * 横轴来自数据，不是界面硬凑的分类：`activity` 由 `plan.stories` 填，
 * 而它的值来自规格里**算出来**的流程。没有那一步，这张图只能是假的。
 */
/**
 * 一列里的缺口。
 *
 * 两条设计约束，都是为了压住理解成本：
 *
 * **① 默认收起，只留一行计数。** 复核的人扫一遍地图时不该被缺口淹掉——他先要看见
 * 「这一列有 3 处没测到、2 处没看到」，想追下去再展开。把十几条明细一次铺开，
 * 等于把「有没有问题」和「问题是什么」两个层次压成一层。
 *
 * **② 两类分开，因为下一步不同。** 「没测到」是能立刻补一条用例的；「没看到」补用例
 * 没用，得让探索再走一次。混在一个数字里，人只能得到一个焦虑的总数，得不到任何行动。
 */
function GapList({ gaps }: { gaps: Gap[] }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  if (!gaps.length) return null;
  const missed = gaps.filter((g) => g.reach === "missed");
  const unseen = gaps.filter((g) => g.reach === "unseen");
  // 「验不住」单独一类，而且要排在最前：它是三类里唯一一个「做了但没用」的
  // ——一条全绿的用例守着一个它根本守不住的地方，比没写用例更值得先看。
  const blind = gaps.filter((g) => g.reach === "blind");

  /**
   * 一条缺口。**带落点的可以点进地图**。
   *
   * 「这条路走过，没有用例验它：/owners 走到 … → /owners/find」——这句话原来是死的，
   * 读它的人没有任何地图可以把它放上去。现在它跳到产品地图并高亮那条边。
   *
   * 没有落点的（规格疑问、缺故事的流程、活下来的变异体）**不做成可点的样子**：
   * 一个点下去什么也不发生的东西，比一个明摆着不能点的东西更伤人。
   */
  const row = (g: Gap, i: number) => {
    const at = g.anchor
      ? g.anchor.kind === "edge"
        ? `edge:${g.anchor.from}->${g.anchor.to}`
        : `state:${g.anchor.id}`
      : "";
    const body = (
      <>
        <div className="text-[11px] leading-snug">{g.what}</div>
        {g.detail && (
          <div className="mt-0.5 break-words font-mono text-[10px] leading-snug text-muted-foreground">{g.detail}</div>
        )}
      </>
    );
    if (!at)
      return (
        <div key={i} className="rounded border border-dashed border-border/70 px-1.5 py-1">
          {body}
        </div>
      );
    return (
      <button
        key={i}
        onClick={() => {
          const [path] = window.location.hash.split("?");
          window.location.hash = `${path || "#/"}?open=map&at=${encodeURIComponent(at)}`;
        }}
        title={t("review.gapLocate")}
        className="w-full rounded border border-dashed border-border/70 px-1.5 py-1 text-left transition-colors hover:border-primary/60 hover:bg-primary/5"
      >
        {body}
        <div className="mt-0.5 text-[10px] text-primary">{t("review.gapLocate")} →</div>
      </button>
    );
  };

  return (
    <div className="mt-2 rounded-lg border border-dashed border-amber-300/70 bg-amber-50/40 p-2">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 text-left"
      >
        <span className="flex items-center gap-2 text-[11px]">
          {!!blind.length && (
            <span className="rounded bg-rose-200/80 px-1.5 py-0.5 font-medium text-rose-900" title={t("review.gapsBlindHint")}>
              {blind.length} {t("review.gapsBlind")}
            </span>
          )}
          {!!missed.length && (
            <span className="rounded bg-amber-200/70 px-1.5 py-0.5 font-medium text-amber-900" title={t("review.gapsMissedHint")}>
              {missed.length} {t("review.gapsMissed")}
            </span>
          )}
          {!!unseen.length && (
            <span className="rounded bg-slate-200/80 px-1.5 py-0.5 font-medium text-slate-700" title={t("review.gapsUnseenHint")}>
              {unseen.length} {t("review.gapsUnseen")}
            </span>
          )}
        </span>
        <span className="text-[10.5px] text-muted-foreground">{open ? t("review.gapsHide") : t("review.gapsShow")}</span>
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          {!!blind.length && (
            <div className="space-y-1">
              <div className="text-[10.5px] font-medium text-rose-900">
                {t("review.gapsBlind")} · {t("review.gapsBlindHint")}
              </div>
              {blind.map(row)}
            </div>
          )}
          {!!missed.length && (
            <div className="space-y-1">
              <div className="text-[10.5px] font-medium text-amber-900">
                {t("review.gapsMissed")} · {t("review.gapsMissedHint")}
              </div>
              {missed.map(row)}
            </div>
          )}
          {!!unseen.length && (
            <div className="space-y-1">
              <div className="text-[10.5px] font-medium text-slate-700">
                {t("review.gapsUnseen")} · {t("review.gapsUnseenHint")}
              </div>
              {unseen.map(row)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StoryMap({
  batch,
  selected,
  onToggleCase,
  onSelectStory,
  onOpenCase,
}: {
  batch: Batch;
  selected: Set<string>;
  onToggleCase: (caseId: string) => void;
  onSelectStory: (caseIds: string[], on: boolean) => void;
  onOpenCase: (caseId: string) => void;
}) {
  const t = useT();
  const stories = batch.stories ?? [];
  const byStory = new Map<string, ReviewItem[]>();
  for (const it of batch.items) byStory.set(it.storyId, [...(byStory.get(it.storyId) ?? []), it]);

  // 活动按它第一条故事出现的顺序排——那个顺序来自流程，也就是叙事顺序。
  const columns: Array<{ activity: string; stories: Story[] }> = [];
  for (const st of stories) {
    const key = st.activity?.trim() || t("review.noActivity");
    const col = columns.find((c) => c.activity === key);
    if (col) col.stories.push(st);
    else columns.push({ activity: key, stories: [st] });
  }

  /**
   * 缺口按活动归位；**一条故事都没有的模块也要占一列。**
   *
   * 这是整块改动里最要紧的一条：一整块功能没人管，比任何单条缺口都严重，
   * 而它恰恰是「什么都不显示」时最容易被忽略的——地图上不出现，人就不会想起它。
   */
  const gaps = batch.gaps ?? [];
  const gapsOf = new Map<string, Gap[]>();
  for (const g of gaps) {
    const key = g.activity?.trim() || t("review.gapsUnscoped");
    gapsOf.set(key, [...(gapsOf.get(key) ?? []), g]);
  }
  for (const key of gapsOf.keys())
    if (!columns.some((c) => c.activity === key)) columns.push({ activity: key, stories: [] });
  // 用例挂不到任何已知故事上的，单独一列——不藏起来。
  const orphanIds = new Set(batch.items.filter((i) => !stories.some((s) => s.id === i.storyId)).map((i) => i.storyId));
  if (orphanIds.size)
    columns.push({
      activity: t("review.noStory"),
      stories: [...orphanIds].map((id) => ({ id, title: id, acceptance: [] })),
    });

  const tierTone = (item: ReviewItem): string =>
    item.decision === "approved"
      ? "border-emerald-300 bg-emerald-50 text-emerald-800"
      : item.codeBlocked
        ? "border-rose-300 bg-rose-50 text-rose-800"
        : item.findings.some((f) => f.severity === "warn")
          ? "border-amber-300 bg-amber-50 text-amber-900"
          : "border-border bg-card";

  return (
    <div className="overflow-x-auto pb-2">
      <div className="flex min-w-max gap-3">
        {columns.map((col) => (
          <div key={col.activity} className="w-[280px] flex-none">
            {/* 横轴的一格：一个用户活动。它是骨架，不是分类。 */}
            <div className="mb-2 rounded-lg border border-border bg-muted/40 px-3 py-2">
              <div className="text-[12px] font-semibold leading-snug">{col.activity}</div>
              <div className="mt-0.5 text-[11px] text-muted-foreground">
                {col.stories.length} {t("review.storiesUnit")} ·{" "}
                {col.stories.reduce((n, st) => n + (byStory.get(st.id)?.length ?? 0), 0)} {t("review.casesUnit")}
              </div>
            </div>
            <GapList gaps={gapsOf.get(col.activity) ?? []} />
            <div className="space-y-2">
              {!col.stories.length && (
                <div className="rounded-lg border border-dashed border-border px-2.5 py-3 text-[11px] text-muted-foreground">
                  {t("review.emptyModule")}
                </div>
              )}
              {col.stories.map((st) => {
                const cases = byStory.get(st.id) ?? [];
                const ids = cases.filter((c) => !c.decision).map((c) => c.caseId);
                const allOn = ids.length > 0 && ids.every((id) => selected.has(id));
                return (
                  <div key={st.id} className="rounded-lg border border-border bg-card p-2.5">
                    <div className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={allOn}
                        disabled={!ids.length}
                        onChange={(e) => onSelectStory(ids, e.target.checked)}
                        title={t("review.selectStory")}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="font-mono text-[10px] text-muted-foreground">{st.id}</div>
                        <div className="text-[12.5px] font-medium leading-snug">{st.title}</div>
                        {/* 谁想要、能得到什么。说不出这两样的条目不是用户故事，是界面事实。 */}
                        {(st.role || st.benefit) && (
                          <div className="mt-1 text-[11px] text-muted-foreground">
                            {st.role || "—"} · {st.benefit || "—"}
                          </div>
                        )}
                        {!st.flowId && (
                          <div className="mt-1 text-[10.5px] text-amber-700">{t("review.noFlow")}</div>
                        )}
                      </div>
                    </div>
                    <div className="mt-2 space-y-1">
                      {cases.map((c) => (
                        <button
                          key={c.caseId}
                          onClick={() => onOpenCase(c.caseId)}
                          className={cn(
                            "flex w-full items-center gap-1.5 rounded border px-1.5 py-1 text-left text-[11px] hover:brightness-95",
                            tierTone(c),
                            selected.has(c.caseId) && "ring-1 ring-primary",
                          )}
                        >
                          <input
                            type="checkbox"
                            className="flex-none"
                            checked={selected.has(c.caseId)}
                            disabled={!!c.decision}
                            onChange={() => onToggleCase(c.caseId)}
                            onClick={(e) => e.stopPropagation()}
                          />
                          {/* tier 与它兑不兑现得了，一眼可见：声称不能印得像属性。 */}
                          <span className="flex-none font-mono text-[10px] opacity-70">t{c.tier}</span>
                          <span className="truncate">{c.title}</span>
                          {c.findings.length > 0 && (
                            <span className="ml-auto flex-none font-mono text-[10px] opacity-60">
                              {c.findings.length}
                            </span>
                          )}
                        </button>
                      ))}
                      {!cases.length && (
                        <div className="px-1.5 py-1 text-[11px] text-muted-foreground">{t("review.noCases")}</div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ReviewPage({ focusRun }: { focusRun?: string } = {}) {
  const t = useT();
  const loadData = useStore((s) => s.loadData);
  const projects = useStore((s) => s.projects);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [batch, setBatch] = useState<Batch | undefined>();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [find, setFind] = useState("");
  const [replaceWith, setReplaceWith] = useState("");
  const [pre, setPre] = useState("");
  const [note, setNote] = useState("");
  // Regeneration is a model call per case and takes tens of seconds on a local model, so
  // it says how many are in flight rather than freezing the page with no explanation.
  const [regenerating, setRegenerating] = useState(0);
  // Only for a run that was never bound to a project — the self-test is the usual case.
  // Asked for explicitly rather than defaulted: which board these land in is a decision,
  // and a silent default would put generated cases somewhere nobody chose.
  const [intoProject, setIntoProject] = useState("");
  /** 地图还是列表。默认地图——总览先于逐条，这是这一页存在的理由。 */
  const [view, setView] = useState<"map" | "list">("map");

  const loadRuns = async () => {
    try {
      const { runs: list } = (await fetch(`${API}/api/review`).then((r) => r.json())) as { runs: RunRow[] };
      setRuns(list);
      // Opened from the run that produced this batch, open that one. Landing on a list of
      // twenty runs after clicking "去复核" on one of them is asking the same question twice.
      if (!batch) {
        const wanted = focusRun && list.some((r) => r.wfRunId === focusRun) ? focusRun : list[0]?.wfRunId;
        if (wanted) await openRun(wanted);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const openRun = async (wfRunId: string) => {
    const { batch: b, error: err } = (await fetch(`${API}/api/review/${wfRunId}`).then((r) => r.json())) as {
      batch?: Batch;
      error?: string;
    };
    if (err) return setError(err);
    setBatch(b);
    setSelected(new Set());
    setDrafts({});
  };

  useEffect(() => {
    void loadRuns();
  }, []);

  /**
   * 跟住外面选的那次运行。
   *
   * `loadRuns()` 只在挂载时跑一次，而 `focusRun` 是后到的——它要等地址栏里的
   * `run=` 被解析、运行被选中才有值。于是从别人发来的链接进来时，
   * 这一页停在**最新那一批**，而不是链接指的那一批：链接看起来是坏的。
   *
   * 只在 `focusRun` **真的变了**时跟。否则人手动点开另一批之后，
   * 下一次重渲染就会把他拽回去——那种「我点的东西自己弹回来」比不跟随更糟。
   */
  const followed = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!focusRun || followed.current === focusRun) return;
    if (!runs.some((r) => r.wfRunId === focusRun)) return;
    followed.current = focusRun;
    void openRun(focusRun);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRun, runs]);

  const act = async (decision: "approve" | "reject") => {
    if (!batch || !selected.size) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`${API}/api/review/${batch.wfRunId}/${decision}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          caseIds: [...selected],
          ...(decision === "approve" && !batch.projectId && intoProject ? { projectId: intoProject } : {}),
        }),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      await openRun(batch.wfRunId);
      await loadRuns();
      // Approving writes to the board, so the rest of the app has to hear about it.
      if (decision === "approve") await loadData();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const post = async (path: string, body: unknown) => {
    const res = await fetch(`${API}/api/review/${batch!.wfRunId}${path}`, {
      method: path.startsWith("/cases/") ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const parsed = (await res.json()) as { batch?: Batch; error?: string };
    if (!res.ok) throw new Error(parsed.error ?? `HTTP ${res.status}`);
    if (parsed.batch) setBatch(parsed.batch);
    return parsed;
  };

  const saveEdit = async (item: ReviewItem) => {
    const draft = drafts[item.caseId];
    if (!batch || !draft) return;
    setBusy(true);
    setError("");
    try {
      await post(`/cases/${item.caseId}`, {
        title: draft.title,
        // Blank lines are how a step gets deleted; they are not steps.
        steps: draft.steps.split("\n").map((x) => x.trim()).filter(Boolean),
        expected: draft.expected,
      });
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[item.caseId];
        return next;
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const batchOp = async (op: Record<string, unknown>, ids?: string[]) => {
    const caseIds = ids ?? [...selected];
    if (!batch || !caseIds.length) return;
    setBusy(true);
    setError("");
    try {
      await post("/batch", { caseIds, op });
      setDrafts({});
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const regenerate = async () => {
    if (!batch || !selected.size) return;
    setRegenerating(selected.size);
    setError("");
    try {
      const out = (await post("/regenerate", {
        caseIds: [...selected],
        note: note.trim() || undefined,
      })) as unknown as { failed?: Array<{ caseId: string; message: string }> };
      setDrafts({});
      // A case the model could not rewrite is reported, not swallowed: the reviewer is
      // waiting on it and would otherwise read "nothing changed" as "nothing to change".
      if (out.failed?.length)
        setError(out.failed.map((f) => `${f.caseId}: ${f.message}`).join(" | "));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRegenerating(0);
    }
  };

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const pending = batch?.items.filter((i) => !i.decision) ?? [];

  return (
    <>
      <TopBar />
      <div className="flex-1 overflow-auto p-4">
        <div className="mx-auto max-w-4xl space-y-4">
          <div>
            <h1 className="flex items-center gap-2 font-display text-lg font-medium text-foreground">
              <ClipboardCheck className="h-5 w-5 text-primary" />
              {t("nav.review")}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">{t("review.subtitle")}</p>
            {error && <p className="mt-1 text-[12px] text-rose-500">{error}</p>}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {runs.map((r) => (
              <button
                key={r.wfRunId}
                title={r.wfRunId}
                onClick={() => void openRun(r.wfRunId)}
                className={cn(
                  "rounded-md border px-2 py-1 font-mono text-[11px]",
                  batch?.wfRunId === r.wfRunId
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border text-muted-foreground hover:bg-muted",
                )}
              >
                {batchStamp(r.startedAt) || r.wfRunId} · {r.pending}/{r.total}
              </button>
            ))}
            {runs.length === 0 && <span className="text-[12px] text-muted-foreground">{t("review.noRuns")}</span>}
          </div>

          {batch && (
            <>
              {/*
                「缺了什么」的一句话答案，放在最前面。
                复核这件事有两个问题：**这些用例对不对**，和**还缺什么**。第二个问题此前在
                界面上根本不存在——地图只画得出「有什么」。所以它要有自己的一条，
                而不是藏在某一列里等人去展开。
              */}
              {!!batch.gaps?.length && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-dashed border-amber-300 bg-amber-50/50 px-3 py-2 text-[12px]">
                  <span className="font-medium text-amber-900">{t("review.gapsTitle")}</span>
                  <span className="rounded bg-amber-200/70 px-1.5 py-0.5 text-amber-900">
                    {batch.gaps.filter((g) => g.reach === "missed").length} {t("review.gapsMissed")}
                  </span>
                  <span className="rounded bg-slate-200/80 px-1.5 py-0.5 text-slate-700">
                    {batch.gaps.filter((g) => g.reach === "unseen").length} {t("review.gapsUnseen")}
                  </span>
                  {!!batch.gaps.filter((g) => g.reach === "blind").length && (
                    <span className="rounded bg-rose-200/80 px-1.5 py-0.5 text-rose-900">
                      {batch.gaps.filter((g) => g.reach === "blind").length} {t("review.gapsBlind")}
                    </span>
                  )}
                  {(batch.exploreStopped || batch.exploreStoppedBecause) && (
                    <span className="text-muted-foreground">
                      {t("review.exploreStopped")}：
                      {stopReason(t, batch.exploreStopped, batch.exploreStoppedBecause)}
                    </span>
                  )}
                  {/*
                    「没跑过」和「0 分」必须分得开：前者是「不知道这套用例验不验得住」，
                    后者是「知道，而且它一个都拦不住」。把没跑过显示成 0 分，
                    是把无知包装成结论。
                  */}
                  {batch.mutation ? (
                    <span className="text-muted-foreground">
                      {t("review.mutationScore")} {Math.round(batch.mutation.score * 100)}%{" "}
                      {t("review.mutationBreak", {
                        killed: batch.mutation.killed,
                        survived: batch.mutation.survived,
                        notApplied: batch.mutation.notApplied,
                        cases: batch.mutation.cases,
                      })}
                      {/*
                        「不知道」只在真的有的时候才占一行。平时不显示，是因为
                        一个恒为 0 的字段会被读者学会忽略，等它真的不为 0 那天也照样忽略。
                      */}
                      {batch.mutation.inconclusive > 0 && (
                        <span className="ml-1 text-amber-600 dark:text-amber-500">
                          {t("review.mutationInconclusive", { n: batch.mutation.inconclusive })}
                        </span>
                      )}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">{t("review.mutationNotRun")}</span>
                  )}
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card p-3">
                <span className="text-[12px] text-muted-foreground">
                  {t("review.pending")}: {batch.pending} / {batch.items.length}
                  {batch.gateScore !== undefined && ` · gate ${Math.round(batch.gateScore * 100)}%`}
                  {/* Two numbers, not one: the second is the same gate reading the edits. */}
                  {batch.editedGateScore !== undefined && (
                    <span className="ml-1 text-foreground">
                      → {Math.round(batch.editedGateScore * 100)}% ({t("review.afterEdits")} {batch.edited})
                    </span>
                  )}
                  {!batch.projectId && ` · ${t("review.noProject")}`}
                </span>
                {!batch.projectId && (
                  <select
                    className="rounded-md border border-border bg-card px-2 py-1 text-[12px]"
                    value={intoProject}
                    onChange={(e) => setIntoProject(e.target.value)}
                  >
                    <option value="">{t("review.pickProject")}</option>
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                )}
                {/* 地图与列表。默认地图——**总览先于逐条**，那是这一页存在的理由：
                    80 条扁平条目人只能一条条看，而那是粒度问题，不只是界面问题。 */}
                <div className="flex overflow-hidden rounded-md border border-border">
                  {(["map", "list"] as const).map((v) => (
                    <button
                      key={v}
                      onClick={() => setView(v)}
                      className={cn(
                        "px-2 py-1 text-[12px]",
                        view === v ? "bg-primary text-primary-foreground" : "bg-card hover:bg-muted",
                      )}
                    >
                      {v === "map" ? t("review.viewMap") : t("review.viewList")}
                    </button>
                  ))}
                </div>
                <span className="ml-auto" />
                <Button onClick={() => setSelected(new Set(pending.map((i) => i.caseId)))}>
                  {t("review.selectAll")}
                </Button>
                <Button
                  variant="success"
                  disabled={!selected.size || busy || (!batch.projectId && !intoProject)}
                  onClick={() => void act("approve")}
                >
                  <Check className="h-3.5 w-3.5" />
                  {t("review.approve")} ({selected.size})
                </Button>
                <Button disabled={!selected.size || busy} onClick={() => void act("reject")}>
                  <X className="h-3.5 w-3.5" />
                  {t("review.reject")}
                </Button>
              </div>

              {/* One change, applied to the selection. Find-and-replace first because the
                  recurring defect here is a generated case inventing a credential, and the
                  fix is the same substitution in every case that did it. */}
              <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card p-3">
                <span className="text-[11px] font-medium text-muted-foreground">
                  {t("review.batch")} ({selected.size})
                </span>
                <input
                  className="w-32 rounded-md border border-border bg-card px-2 py-1 font-mono text-[11px]"
                  placeholder={t("review.find")}
                  value={find}
                  onChange={(e) => setFind(e.target.value)}
                />
                <span className="text-[11px] text-muted-foreground">→</span>
                <input
                  className="w-40 rounded-md border border-border bg-card px-2 py-1 font-mono text-[11px]"
                  placeholder="${env.LOGIN_USER}"
                  value={replaceWith}
                  onChange={(e) => setReplaceWith(e.target.value)}
                />
                <Button
                  disabled={!selected.size || !find || busy}
                  onClick={() => void batchOp({ kind: "replace", find, with: replaceWith })}
                >
                  <Replace className="h-3.5 w-3.5" />
                  {t("review.replace")}
                </Button>

                <select
                  className="rounded-md border border-border bg-card px-2 py-1 text-[11px]"
                  value=""
                  disabled={!selected.size || busy}
                  onChange={(e) => e.target.value && void batchOp({ kind: "priority", priority: e.target.value })}
                >
                  <option value="">{t("review.priority")}</option>
                  {["P0", "P1", "P2"].map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>

                <input
                  className="w-40 rounded-md border border-border bg-card px-2 py-1 text-[11px]"
                  placeholder={t("review.addPrecondition")}
                  value={pre}
                  onChange={(e) => setPre(e.target.value)}
                />
                <Button
                  disabled={!selected.size || !pre.trim() || busy}
                  onClick={() => void batchOp({ kind: "precondition", text: pre.trim() })}
                >
                  {t("review.apply")}
                </Button>

                <Button disabled={!selected.size || busy} onClick={() => void batchOp({ kind: "revert" })}>
                  <Undo2 className="h-3.5 w-3.5" />
                  {t("review.revert")}
                </Button>

                <span className="ml-auto" />
                <input
                  className="w-48 rounded-md border border-border bg-card px-2 py-1 text-[11px]"
                  placeholder={t("review.notePlaceholder")}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
                <Button
                  disabled={!selected.size || busy || regenerating > 0}
                  onClick={() => void regenerate()}
                  title={t("review.regenHint")}
                >
                  <Wand2 className="h-3.5 w-3.5" />
                  {regenerating > 0 ? `${t("review.regenerating")} ${regenerating}` : t("review.regenerate")}
                </Button>
              </div>

              {view === "map" ? (
                <StoryMap
                  batch={batch}
                  selected={selected}
                  onToggleCase={(id) =>
                    setSelected((s) => {
                      const n = new Set(s);
                      n.has(id) ? n.delete(id) : n.add(id);
                      return n;
                    })
                  }
                  onSelectStory={(ids, on) =>
                    setSelected((s) => {
                      const n = new Set(s);
                      for (const id of ids) (on ? n.add(id) : n.delete(id));
                      return n;
                    })
                  }
                  onOpenCase={(id) => {
                    setView("list");
                    setOpen((o) => new Set(o).add(id));
                    // 切回列表之后要看得见它——地图上点一条用例，是想看它的细节。
                    setTimeout(() => document.getElementById(`case-${id}`)?.scrollIntoView({ block: "center" }), 0);
                  }}
                />
              ) : (
              <div className="space-y-2">
                {batch.items.map((item) => {
                  const expanded = open.has(item.caseId);
                  const blocked = item.codeBlocked;
                  return (
                    <div
                      key={item.caseId}
                      id={`case-${item.caseId}`}
                      className={cn(
                        "rounded-xl border bg-card p-3",
                        item.decision === "approved"
                          ? "border-emerald-300 opacity-70"
                          : item.decision === "rejected"
                            ? "border-border opacity-50"
                            : blocked
                              ? "border-rose-300"
                              : "border-border",
                      )}
                    >
                      <div className="flex items-start gap-2">
                        <input
                          type="checkbox"
                          className="mt-1"
                          disabled={!!item.decision}
                          checked={selected.has(item.caseId)}
                          onChange={() => toggle(item.caseId)}
                        />
                        <button
                          className="min-w-0 flex-1 text-left"
                          onClick={() =>
                            setOpen((prev) => {
                              const next = new Set(prev);
                              next.has(item.caseId) ? next.delete(item.caseId) : next.add(item.caseId);
                              return next;
                            })
                          }
                        >
                          <div className="flex items-center gap-2">
                            {expanded ? (
                              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                            ) : (
                              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                            )}
                            <span className="font-display text-[14px] text-foreground">{item.title}</span>
                          </div>
                          <div className="ml-5 mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-muted-foreground">
                            <span>{item.storyId}</span>
                            <span>{item.designMethod}</span>
                            <span>{TIER_LABEL[item.tier] ?? `t${item.tier}`}</span>
                            {item.code && <span className="text-emerald-600">{t("review.hasCode")}</span>}
                            {item.degraded && <span className="text-amber-600">{t("review.degraded")}</span>}
                            {item.edit && (
                              <span className="text-sky-600">
                                {item.edit.by === "model" ? t("review.byModel") : t("review.edited")}
                              </span>
                            )}
                            {item.edit?.priority && <span className="text-foreground">{item.edit.priority}</span>}
                            {item.decision && <span className="text-foreground">{item.decision}</span>}
                          </div>
                          <div className="ml-5 mt-1 text-[12px] text-muted-foreground">→ {item.expected}</div>
                        </button>
                      </div>

                      {(item.findings.length > 0 || (item.codeFindings?.length ?? 0) > 0) && (
                        <ul className="ml-7 mt-2 space-y-0.5">
                          {[...item.findings, ...(item.codeFindings ?? [])].map((f, i) => (
                            <li
                              key={i}
                              className={cn(
                                "text-[11px]",
                                f.severity === "block"
                                  ? "text-rose-600"
                                  : f.severity === "warn"
                                    ? "text-amber-600"
                                    : "text-muted-foreground",
                              )}
                            >
                              [{f.rule}] {f.message}
                            </li>
                          ))}
                        </ul>
                      )}

                      {expanded && (
                        <div className="ml-7 mt-2 space-y-2">
                          <EditDiff item={item} />
                          {item.editedFindings && (
                            <ul className="space-y-0.5">
                              {item.editedFindings.length === 0 ? (
                                <li className="text-[11px] text-emerald-600">{t("review.noFindingsNow")}</li>
                              ) : (
                                item.editedFindings.map((f, i) => (
                                  <li key={i} className="text-[11px] text-muted-foreground">
                                    {t("review.stillFlagged")} [{f.rule}] {f.message}
                                  </li>
                                ))
                              )}
                            </ul>
                          )}
                          {item.decision ? (
                            <ol className="list-decimal space-y-0.5 pl-4 text-[12px] text-foreground">
                              {item.steps.map((s, i) => (
                                <li key={i}>{s}</li>
                              ))}
                            </ol>
                          ) : (
                            <EditForm
                              draft={
                                drafts[item.caseId] ?? {
                                  title: item.title,
                                  steps: item.steps.join("\n"),
                                  expected: item.expected,
                                }
                              }
                              onChange={(d) => setDrafts((prev) => ({ ...prev, [item.caseId]: d }))}
                              onSave={() => void saveEdit(item)}
                              onRevert={() => void batchOp({ kind: "revert" }, [item.caseId])}
                              canRevert={!!item.edit}
                              busy={busy}
                            />
                          )}
                          {item.code && (
                            <pre className="overflow-auto rounded-lg bg-muted p-2 font-mono text-[11px] text-muted-foreground">
                              {item.code}
                            </pre>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
