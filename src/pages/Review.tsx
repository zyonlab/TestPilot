import { ProjectRevisionLinks } from "@/components/ProjectRevisionLinks";
import { useEffect, useRef, useState } from "react";
import { LAST_PLACE, safeGet, safeSet } from "@/lib/local";
import { Check, X, ChevronDown, ChevronRight, Wand2, Undo2, Replace, Save } from "lucide-react";
import { Button, EmptyState } from "@/components/ui";
import { Drawer } from "@/components/overlay";
import { useT } from "@/lib/prefs";
import { hasKey } from "@/lib/i18n";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/cn";
import { SurfaceTabsRow, TabsRow, useSurfaceTabs } from "@/lib/surfaceTabs";
import {
  AUDIT_TABS,
  auditMockOn,
  fetchCalibration,
  fetchDiff,
  fetchScan,
  isAuditTab,
  postLabels,
  type AuditTab,
  type CalibrationPayload,
  type DiffPayload,
  type HumanLabel,
  type ScanFinding,
  type ScanReport,
} from "@/lib/audit";
import { API_BASE } from "@/lib/base";
import { stopReason } from "@/lib/stopReason";
import { CaseMeta, CaseBody } from "@/lib/artifact/CaseCard";
import { StoryTitle } from "@/lib/artifact/StoryCard";
import { Findings } from "@/lib/artifact/Findings";
import { METHOD_KEY, TIER_KEY } from "@/lib/artifact/types";
import type { ArtifactCase, ArtifactFinding, ArtifactStory, CaseField } from "@/lib/artifact/types";
import {
  EMPTY_FILTERS,
  activityIndex,
  filtersFromParams,
  filtersToParams,
  isFiltering,
  matches,
  type ReviewFilters,
} from "./reviewFilter";

/**
 * The review queue.
 *
 * What a workflow produced, with what the gates thought of it, waiting for someone to say
 * whether it belongs in the suite. Approving creates the case; rejecting is remembered so
 * the queue stops offering it.
 */
/**
 * **v3：复核队列改成审计台，因为「全部逐条」这个前提是错的。**
 *
 * 实测的漏斗只有两个数：一次运行**生成 297 条、被人决定 0 条**。上面那段英文注释里
 * 「waiting for someone to say whether it belongs」写的是一件没有发生过的事——
 * 它把人放在评分员的位置上，而一天上百条评分没有人会做第二天。
 *
 * 三路调研里人的位置从来不是评分员（`docs/v3/00-架构.md` §5）：
 * OpenAI 那条线让人标**样本**（30 条）校准 judge；Inspect 那条线让人看 Scanner 的
 * **审计报告**；Cursor 那条线让人只处理**被标出来的**。三条共用一个形状：
 * **队列里装的从「全部」换成「机器判不了的」**。
 *
 * 所以这一屏保留了它做对的全部东西——J/K/X/A/1/3 的键盘动线、`act()` 的口径
 * （先选中，否则光标那一条）、决定完光标自动前进、底部批量条、右栏常驻背景、
 * `role="listbox"` 的位置播报——**只换队列里装的东西**，并按来源分成三个 tab：
 *
 *   校准     30 条分层抽样，人标「覆盖了 / 没覆盖」→ `HumanLabel[]`，κ 的锚
 *   审计报告 Scanner 标出的可疑项（五种 `kind`），`block` 级默认不可批准
 *   变化     相对上次批准集的 diff：新增 / 消失 / 断言变了的
 *
 * 三个 tab 共用同一套三栏布局与同一套键盘动线。**这一点是刻意的**：三种来源如果各长
 * 一套操作，人就要记三套；而它们要人做的事本来就是同一件——看一条，说一句话，走下一条。
 */

const API = API_BASE;

/**
 * 产物的形状来自 `src/lib/artifact/types`，不在这里另立一份。
 *
 * 此前这个文件自己声明了一遍 `Finding` / `ReviewItem` / `Story`，只写了它当时想画的键。
 * 结果是同一份接口数据，故事地图画得出角色与收益，故事抽屉画不出；用例的前置条件和
 * 机器判据明明在响应里，四个阅读器一个都没画。少写一个字段，下游就永远不知道它存在过。
 */
type Finding = ArtifactFinding;

interface ReviewEdit {
  by?: "human" | "model";
  priority?: string;
  note?: string;
}

interface ReviewItem extends ArtifactCase {
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

type Story = ArtifactStory;

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
  /** 分是怎么算出来的：分母、把分拖下来的那几条、算式。 */
  gateBasis?: { cases: number; flagged: string[]; formula: string };
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
    /** 读懂一个 0 需要的分母：基线就挂了几条、其中几条是 infra、真正上场的有几条。 */
    baselineFailed?: number;
    baselineInfra?: number;
    usableCases?: number;
    baselineRetried?: number;
  };
}

interface RunRow {
  wfRunId: string;
  graphId: string;
  pending: number;
  total: number;
  startedAt?: string;
}

/* ── 审计台：队列里那一条，以及它是从哪来的 ──────────────────────────────── */

/**
 * 队列里一条的**审计侧信息**。
 *
 * 为什么不把这些字段塞进 `ReviewItem`：`ReviewItem` 是产物（`artifact/types.ts` 的
 * 规矩是「与服务端 DTO 一一对应，字段全量」），而 `kind` / `heldOut` / `change`
 * 说的是**这一条为什么出现在队列里**，不是这条用例本身的属性。混进去之后，
 * 同一个类型会同时描述两件事，而下一个人分不清哪些字段是从后端来的。
 *
 * 所以是一张旁挂的表：`caseId → AuditRow`。队列仍然走 `ReviewItem[]`，
 * 于是 J/K、光标、`role="listbox"`、`ItemCard` 一行都不用改。
 */
interface AuditRow {
  caseId: string;
  tab: AuditTab;
  /** 校准：这条要对照的清单项。人判断的对象是它。 */
  gold?: { id: string; title: string; heldOut: boolean };
  /** 校准：已经标过的答案。没标过是 undefined——「还没标」和「标了未覆盖」是两回事。 */
  covered?: boolean;
  /** 审计：Scanner 在这条上标出的全部 finding。同一条可能被标出好几处。 */
  findings?: ScanFinding[];
  /** 变化：这条相对上次批准集是新增 / 消失 / 断言变了。 */
  change?: "added" | "removed" | "changed";
  before?: string;
  after?: string;
  /** 这一批里认领不到产物时用的标题（`removed` 的那些只有 diff 记得它们叫什么）。 */
  title?: string;
  /**
   * 只读：`removed` 的那些。它们**已经不在这一批里**——对一条不存在的用例按批准，
   * 后端无从写起，而界面若照样接受这一下，人会以为自己处理完了。
   */
  readOnly?: boolean;
}

/** 这一条最重的那一档。`block` 级默认不可批准，判据就是它。 */
const worstSeverity = (row?: AuditRow): "block" | "warn" | undefined =>
  row?.findings?.some((f) => f.severity === "block")
    ? "block"
    : row?.findings?.length
      ? "warn"
      : undefined;

/**
 * 一条没有产物可对照的队列条目。
 *
 * 三个 tab 的条目都按 `caseId` 去这一批的产物里认领标题、步骤、判据；认领不到时
 * （mock、或者这条已经从这一批里消失了）给一条**说得出自己是谁**的桩，
 * 而不是让队列少一行——少一行意味着人根本不知道有这么一条待处理。
 */
const stubItem = (caseId: string, title: string): ReviewItem => ({
  caseId,
  title,
  storyId: "",
  designMethod: "",
  tier: 0,
  precondition: [],
  steps: [],
  expected: "",
  findings: [],
});

/** 五种 `kind` 的词条 key。英文枚举不直接显示——它是 id，不是话。 */
const SCAN_KIND_KEY: Record<ScanFinding["kind"], string> = {
  "assert-trivial": "audit.kind.assertTrivial",
  unanchored: "audit.kind.unanchored",
  "touched-sut": "audit.kind.touchedSut",
  duplicate: "audit.kind.duplicate",
  "unfounded-step": "audit.kind.unfoundedStep",
};

/**
 * 队列那一行上的审计徽标：**这一条为什么在这儿**。
 *
 * 一行只放得下一句话，所以放的是「凭什么要人看它」而不是这条用例的属性——
 * 队列的作用是让人决定**下一条看哪个**，而这个决定只跟前者有关。
 */
function AuditBadges({ row }: { row?: AuditRow }) {
  const t = useT();
  if (!row) return null;
  return (
    <>
      {row.gold?.heldOut && (
        /* 留出集要标出来：它那一半**从不进任何调优**（P2）。人有权知道自己此刻标的这一条
           属于哪一半——不标出来，他会以为这 30 条是等价的。 */
        <span className="rounded-sm bg-chat-soft px-1 text-chat" title={t("audit.heldOutWhy")}>
          {t("audit.heldOut")}
        </span>
      )}
      {row.covered !== undefined && (
        <span className={row.covered ? "text-ok" : "text-warn"}>
          {t(row.covered ? "audit.covered" : "audit.notCovered")}
        </span>
      )}
      {row.findings?.map((f, i) => (
        <span
          key={i}
          title={f.evidence}
          className={cn(
            "rounded-sm px-1",
            f.severity === "block" ? "bg-bad-soft text-bad" : "bg-warn-soft text-warn",
          )}
        >
          {t(SCAN_KIND_KEY[f.kind])}
        </span>
      ))}
      {row.change && (
        <span
          className={cn(
            "rounded-sm px-1",
            row.change === "added"
              ? "bg-ok-soft text-ok"
              : row.change === "removed"
                ? "bg-muted text-muted-foreground"
                : "bg-warn-soft text-warn",
          )}
        >
          {t(`audit.change.${row.change}`)}
        </span>
      )}
    </>
  );
}

/**
 * 详情栏最上面那一段：**人要判断的到底是什么**。
 *
 * 三个 tab 问的是三个不同的问题，而这一段就是那个问题本身。它排在用例之前，
 * 因为顺序即语义：先说「要你判断这个」，再给用例；反过来人会先读完一整条用例，
 * 才发现自己该回答的是另一件事。
 */
function AuditQuestion({ row }: { row?: AuditRow }) {
  const t = useT();
  if (!row) return null;
  if (row.tab === "calibrate" && row.gold)
    return (
      <div className="mb-2 rounded-xl border border-primary/40 bg-primary-soft/40 p-3">
        <div className="eyebrow">{t("audit.goldItem")}</div>
        <p className="mt-1 text-[0.9375rem] leading-snug text-foreground">{row.gold.title}</p>
        <p className="mt-1.5 font-mono text-[0.6875rem] text-muted-foreground">
          {row.gold.id}
          {row.gold.heldOut ? ` · ${t("audit.heldOut")} — ${t("audit.heldOutWhy")}` : ""}
        </p>
        <p className="mt-2 text-[0.8125rem] text-ink2">{t("audit.calibrateAsk")}</p>
      </div>
    );
  if (row.tab === "scan" && row.findings?.length)
    return (
      <div className="mb-2 space-y-1.5">
        {row.findings.map((f, i) => (
          <div
            key={i}
            className={cn(
              "rounded-xl border p-3",
              f.severity === "block" ? "border-bad bg-bad-soft" : "border-warn bg-warn-soft",
            )}
          >
            <div className="flex items-baseline gap-2">
              <span className="eyebrow">{t(SCAN_KIND_KEY[f.kind])}</span>
              <span
                className={cn("font-mono text-[0.6875rem]", f.severity === "block" ? "text-bad" : "text-warn")}
              >
                {t(`audit.severity.${f.severity}`)}
              </span>
            </div>
            {/* `evidence` 是一句**可核对**的话。它是这一条存在的全部理由，所以给它正文的字号，
                而不是把它压成一行灰色的元信息。 */}
            <p className="mt-1 text-[0.8125rem] leading-relaxed text-ink2">{f.evidence}</p>
            {f.severity === "block" && (
              <p className="mt-1.5 text-[0.6875rem] text-bad">{t("audit.blockedWhy")}</p>
            )}
          </div>
        ))}
      </div>
    );
  if (row.tab === "diff" && row.change)
    return (
      <div className="mb-2 rounded-xl border border-border bg-muted/40 p-3">
        <div className="eyebrow">{t(`audit.change.${row.change}`)}</div>
        <p className="mt-1 text-[0.8125rem] leading-relaxed text-ink2">
          {t(`audit.changeWhy.${row.change}`)}
        </p>
        {row.change === "changed" && (
          /* 前后两句都摆出来，不只说"变了"。断言换成了什么，是这一屏唯一要人判断的东西，
             而「expected 变了」这句话本身不构成判断依据。 */
          <div className="mt-2 space-y-1 text-[0.8125rem]">
            <div className="rounded bg-bad-soft px-2 py-1 text-bad line-through">{row.before}</div>
            <div className="rounded bg-ok-soft px-2 py-1 text-ok">{row.after}</div>
          </div>
        )}
      </div>
    );
  return null;
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
  // Steps line by line:"the steps changed" is not an answer to"what did you change".
  const stepCount = Math.max(o.steps.length, item.steps.length);
  for (let i = 0; i < stepCount; i++)
    if (o.steps[i] !== item.steps[i])
      rows.push({ label: `step ${i + 1}`, from: o.steps[i] ?? "—", to: item.steps[i] ?? "—" });

  /**
   * 保留清单：这次改写**没有动**的那几样。
   *
   * 重写一条用例走的是 `reviseCase`，而它只回来六个字段（标题 / 步骤 / 期望 /
   * 前置 / 判定硬度 / 设计方法）。剩下的——它覆盖了产品模型上哪条转移、
   * 跑完要做的清理、去重用的那把键——是从原来那条**原样搬过去**的。
   *
   * 这件事必须看得见：一个人在按下保存前，要能确认「它没把我挂在那条边上的线弄丢」。
   * 而这恰恰是最容易悄悄丢掉、又最难在事后发现的一类东西——丢了之后，
   * 结构覆盖率上只是少了一条，没有任何地方会红。
   */
  const preserved = [
    ...(item.covers?.length ? [t("review.keepCovers", { n: item.covers.length })] : []),
    ...(item.postSteps?.length ? [t("review.keepPostSteps", { n: item.postSteps.length })] : []),
    ...(o.tier === item.tier ? [t("review.keepTier")] : []),
    ...(o.designMethod === item.designMethod ? [t("review.keepMethod")] : []),
  ];

  if (!rows.length) return null;
  return (
    <div className="rounded-lg border border-border bg-muted/40 p-2">
      <div className="mb-1 text-[0.6875rem] font-medium text-muted-foreground">
        {t("review.diff")}
        {item.edit?.by === "model" && <span className="ml-2 text-primary">{t("review.byModel")}</span>}
      </div>
      <table className="w-full table-fixed border-collapse text-[0.6875rem]">
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} className="align-top">
              <td className="w-20 py-0.5 pr-2 font-mono text-muted-foreground">{r.label}</td>
              <td className="w-1/2 py-0.5 pr-2 text-bad line-through decoration-bad">{r.from}</td>
              <td className="py-0.5 text-ok">{r.to}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {/* 没被动过的那几样。它们不在 diff 里，正因如此才需要一栏说出来。 */}
      {preserved.length > 0 && (
        <div className="mt-1 flex flex-wrap items-center gap-1.5 border-t border-border/60 pt-1 text-[0.6875rem] text-muted-foreground">
          <span>{t("review.preserved")}</span>
          {preserved.map((p) => (
            <span key={p} className="rounded bg-muted px-1.5 py-0.5">
              {p}
            </span>
          ))}
        </div>
      )}{" "}
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
  onApprove,
  onReject,
  approveWhy,
  approveLabel,
  rejectLabel,
}: {
  draft: Draft;
  onChange: (d: Draft) => void;
  onSave: () => void;
  onRevert: () => void;
  canRevert: boolean;
  busy: boolean;
  /** 就地决定这一条。`03 §6` 的原话是「详情内可…批准进入阶段二」。 */
  onApprove: () => void;
  onReject: () => void;
  /** 非空表示批准不可用，内容就是原因——写出来，而不是只把按钮灰掉。 */
  approveWhy: string;
  /**
   * 这两颗键在**当前 tab** 里叫什么。
   *
   * 校准 tab 上按 `1` 不是批准，是标「覆盖了」。键位没变（同一只手在三个 tab 之间切，
   * 改键位等于让人重学三遍），但按钮上必须写着它此刻在做的那件事——
   * 一颗写着「批准」的按钮做出标注，人只能靠事后看结果才发现。
   */
  approveLabel?: string;
  rejectLabel?: string;
}) {
  const t = useT();
  return (
    <div className="space-y-1.5">
      <input
        data-field="title"
        className="w-full rounded-md border border-border bg-card px-2 py-[0.1875rem] text-[0.75rem]"
        value={draft.title}
        onChange={(e) => onChange({ ...draft, title: e.target.value })}
      />
      <textarea
        data-field="steps"
        className="h-20 w-full resize-y rounded-md border border-border bg-card px-2 py-1 font-mono text-[0.6875rem]"
        value={draft.steps}
        spellCheck={false}
        onChange={(e) => onChange({ ...draft, steps: e.target.value })}
      />
      <textarea
        data-field="expected"
        className="h-14 w-full resize-y rounded-md border border-border bg-card px-2 py-1 text-[0.75rem]"
        value={draft.expected}
        spellCheck={false}
        onChange={(e) => onChange({ ...draft, expected: e.target.value })}
      />
      {/*
       * 一行里两件事，用一道分隔线分开：左边是「改这一条」，右边是「决定这一条」。
       * 决定靠右，因为它是这一屏的出口——读完、改完，往右走。
       */}
      <div className="flex flex-wrap items-center gap-2">
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
        <span className="text-[0.6875rem] text-muted-foreground">{t("review.editHint")}</span>
        <span className="ml-auto flex items-center gap-2">
          {approveWhy && <span className="text-[0.6875rem] text-warn">{approveWhy}</span>}
          <Button variant="success" disabled={busy || !!approveWhy} title={approveWhy} onClick={onApprove}>
            <Check className="h-3.5 w-3.5" />
            {approveLabel ?? t("review.approve")}
            <kbd className="kbd ml-0.5">1</kbd>
          </Button>
          <Button disabled={busy} onClick={onReject}>
            <X className="h-3.5 w-3.5" />
            {rejectLabel ?? t("review.reject")}
            <kbd className="kbd ml-0.5">3</kbd>
          </Button>
        </span>
      </div>
    </div>
  );
}

/**
 * 筛选条。
 *
 * 这一页此前唯一的输入框是批量查找替换——一个**会改数据**的框，长得像搜索框。
 * 于是 40 条时人靠滚动，2000 条时这一页就报废了；而报废的方式是安静的：
 * 界面不会说「找不到」，人只会慢慢放弃在这里找东西。
 *
 * 下拉里的选项全部来自这一批的实际取值，不是写死的枚举：一批里没有负例就不该出现
 * 「负例」这个选项，让人点进一个必然为空的结果，是在浪费他仅有的耐心。
 */
function FilterBar({
  filters,
  onChange,
  stories,
  items,
  shown,
}: {
  filters: ReviewFilters;
  onChange: (f: ReviewFilters) => void;
  stories: Story[];
  items: ReviewItem[];
  shown: number;
}) {
  const t = useT();
  const set = (patch: Partial<ReviewFilters>) => onChange({ ...filters, ...patch });
  const uniq = (xs: Array<string | undefined>) => [...new Set(xs.filter(Boolean) as string[])].sort();
  const activities = uniq(stories.map((s) => s.activity?.trim()));
  const methods = uniq(items.map((i) => i.designMethod));
  const tiers = uniq(items.map((i) => String(i.tier)));
  const on = isFiltering(filters);
  // 规则的命中数，按命中数排——最该先看的是最常犯的那一条。
  const counts = new Map<string, number>();
  for (const it of items)
    for (const f of [...it.findings, ...(it.codeFindings ?? [])])
      counts.set(f.rule, (counts.get(f.rule) ?? 0) + 1);
  const ruleCounts = [...counts.entries()].sort((a, b) => b[1] - a[1]);

  // 和 `Button` 的 md 档同一组数——这一排下拉就长在按钮旁边。
  const sel = "rounded border border-input bg-card px-2 py-[0.1875rem] text-[0.6875rem]";
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card p-3">
      <input
        className="w-52 rounded border border-input bg-card px-2 py-[0.1875rem] text-[0.75rem]"
        placeholder={t("review.searchPlaceholder")}
        value={filters.q}
        onChange={(e) => set({ q: e.target.value })}
      />
      {activities.length > 1 && (
        <select className={sel} value={filters.activity} onChange={(e) => set({ activity: e.target.value })}>
          <option value="">{t("review.filterActivity")}</option>
          {activities.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      )}
      {methods.length > 1 && (
        <select className={sel} value={filters.method} onChange={(e) => set({ method: e.target.value })}>
          <option value="">{t("cases.filterMethod")}</option>
          {methods.map((m) => (
            <option key={m} value={m}>
              {t(METHOD_KEY[m] ?? "artifact.method.unknown")}
            </option>
          ))}
        </select>
      )}
      {tiers.length > 1 && (
        <select className={sel} value={filters.tier} onChange={(e) => set({ tier: e.target.value })}>
          <option value="">{t("cases.filterTier")}</option>
          {tiers.map((x) => (
            <option key={x} value={x}>
              {t(TIER_KEY[Number(x)] ?? "artifact.tier3")}
            </option>
          ))}
        </select>
      )}
      <select
        className={sel}
        value={filters.finding}
        onChange={(e) => set({ finding: e.target.value as ReviewFilters["finding"] })}
      >
        <option value="">{t("review.filterFinding")}</option>
        <option value="block">{t("review.filterBlock")}</option>
        <option value="warn">{t("review.filterWarn")}</option>
        <option value="none">{t("review.filterClean")}</option>
      </select>
      <select
        className={sel}
        value={filters.code}
        onChange={(e) => set({ code: e.target.value as ReviewFilters["code"] })}
      >
        <option value="">{t("review.filterCode")}</option>
        <option value="yes">{t("review.filterHasCode")}</option>
        <option value="no">{t("review.filterNoCode")}</option>
      </select>
      <select
        className={sel}
        value={filters.decision}
        onChange={(e) => set({ decision: e.target.value as ReviewFilters["decision"] })}
      >
        <option value="">{t("review.filterDecision")}</option>
        <option value="pending">{t("review.filterPending")}</option>
        <option value="approved">approved</option>
        <option value="rejected">rejected</option>
      </select>
      {on && (
        <>
          <span className="text-[0.6875rem] text-muted-foreground">
            {t("review.filterShown", { shown, total: items.length })}
          </span>
          <Button onClick={() => onChange(EMPTY_FILTERS)}>{t("cases.filterClear")}</Button>
        </>
      )}

      {/*
        门禁分是一个数，规则才是能拿去改的东西。
        「门禁① 100%」点不动的时候，人知道的只有「没问题」或者「有点问题」——
        而他真正要问的是「哪一类问题、有几条、是哪几条」。这一行把它摊开，
        每一条都是一个筛选器。
      */}
      {!!ruleCounts.length && (
        <div className="flex w-full flex-wrap items-center gap-1.5 border-t border-border pt-2">
          <span className="font-mono text-[0.6875rem] uppercase tracking-wider text-muted-foreground">
            {t("review.ruleBreakdown")}
          </span>
          {ruleCounts.map(([rule, n]) => (
            <button
              key={rule}
              onClick={() => set({ rule: filters.rule === rule ? "" : rule })}
              title={hasKey(`gate.${rule}.why`) ? t(`gate.${rule}.why`) : undefined}
              className={cn(
                // 小档：和 `Button size="sm"` 同高（21px），别再自成一档。
                "inline-flex min-h-[1.3125rem] items-center rounded px-[0.4375rem] py-[0.125rem] font-mono text-[0.6875rem]",
                filters.rule === rule
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:brightness-95",
              )}
            >
              {rule} · {n}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * 变异分背后的分母，折叠着。
 *
 * 默认只给一行「真正上场 N/M」，点开才展开四分类与基线损耗——把它一直摊在那里，
 * 会让人学会忽略；而它恰恰是**一个 0 分唯一能被正确读懂的方式**。
 */
function MutationDenominator({
  m,
}: {
  m: {
    killed: number;
    survived: number;
    inconclusive: number;
    notApplied: number;
    cases: number;
    baselineFailed?: number;
    baselineInfra?: number;
    usableCases?: number;
    baselineRetried?: number;
  };
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const usable = m.usableCases ?? 0;
  return (
    <>
      <button
        className="ml-1.5 cursor-pointer underline decoration-dotted hover:text-foreground"
        onClick={() => setOpen((v) => !v)}
        title={t("review.mutationDenomWhy")}
      >
        {t("review.mutationUsable", { usable, cases: m.cases })}
      </button>
      {open && (
        <span className="ml-1.5 inline-flex flex-wrap items-center gap-x-2 gap-y-0.5 align-top font-mono text-[0.6875rem]">
          <span className="text-ok">killed {m.killed}</span>
          <span className="text-bad">survived {m.survived}</span>
          <span className="text-warn">inconclusive {m.inconclusive}</span>
          <span className="text-muted-foreground">notApplied {m.notApplied}</span>
          {m.baselineFailed !== undefined && (
            <span className="text-muted-foreground">
              {t("review.mutationBaseline", {
                failed: m.baselineFailed,
                infra: m.baselineInfra ?? 0,
              })}
            </span>
          )}
          {!!m.baselineRetried && (
            <span className="text-muted-foreground">
              {t("review.mutationRetried", { n: m.baselineRetried })}
            </span>
          )}
        </span>
      )}
    </>
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
/**
 * 顶栏与底部批量条里那颗按钮。
 *
 * 批量条是一块深色浮层，`Button` 那套边框与 hover 是给浅色面设计的，
 * 直接放进去会看不见边、也看不出可按。所以这里给它一套只在深色面上成立的样式，
 * 而不是给 `Button` 再加一个 variant——那个 variant 除了这里没有第二处会用。
 */
function TrayButton({
  go,
  children,
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { go?: boolean }) {
  return (
    <button
      className={cn(
        "inline-flex min-h-[1.5625rem] cursor-pointer items-center gap-1.5 rounded border px-[0.625rem] py-[0.1875rem] text-[0.8125rem] leading-[1.35] transition-colors",
        go
          ? "border-ok bg-ok text-primary-foreground hover:brightness-110"
          : "border-background/25 text-background hover:bg-background/15",
        "disabled:cursor-not-allowed disabled:opacity-40",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

/**
 * 右栏：**进度 / 产物 / 这次它看得到什么**，固定三节、固定顺序。
 *
 * 三节的分工是「这一批走到哪了 / 它里面有些什么 / 它是在什么前提下产出的」。
 * 第三节看起来最不起眼，却是回头看这一批时唯一能回答
 * 「它当时读的什么、用的哪一版图、门禁怎么算的」的东西。
 *
 * 为什么常驻而不是抽屉：这三样是**读任何一条用例时都要对着看的**背景。
 * 装进抽屉，人每判断一条就要开关一次；而抽屉一开就盖住了它要解释的那个东西。
 * 屏幕窄到放不下三栏时它整节让位（`xl:` 才出现）——挤成一条 120px 的缝，
 * 比不显示更糟。
 */
/**
 * PROGRESS 那一节的分子分母，**由当前 tab 说了算**。
 *
 * 此前它写死成「已决定 / 这一批全部用例」，因为队列里装的就是全部。v3 之后三个 tab
 * 装的是三种筛过的集合（校准 30 条样本 / Scanner 标出的 / 相对上次批准集的变化），
 * 分母跟着换：拿「全部 297 条」当分母去量「30 条样本标了几条」，
 * 读出来永远是 10%，而人其实已经做完了。
 */
interface RailProgress {
  done: number;
  total: number;
  rows: Array<{ label: string; value: React.ReactNode }>;
}

function ReviewRail({
  batch,
  progress,
  keyLabels,
}: {
  batch: Batch;
  progress: RailProgress;
  /** 五组键帽的说明，按 [J K] [X] [A] [1] [3] 的顺序。校准 tab 下 1/3 是「覆盖 / 未覆盖」。 */
  keyLabels: string[];
}) {
  const t = useT();
  const items = batch.items;
  const findings = items.reduce((n, i) => n + i.findings.length + (i.codeFindings?.length ?? 0), 0);
  const gaps = batch.gaps ?? [];
  const missed = gaps.filter((g) => g.reach === "missed").length;
  const unseen = gaps.filter((g) => g.reach === "unseen").length;
  const blind = gaps.filter((g) => g.reach === "blind").length;

  const sec = (title: string, body: React.ReactNode, count?: React.ReactNode) => (
    <div className="border-b border-border">
      <div className="flex items-center gap-1.5 px-3 py-2">
        <span className="eyebrow">{title}</span>
        {count !== undefined && (
          <span className="ml-auto font-mono text-[0.6875rem] text-muted-foreground">{count}</span>
        )}
      </div>
      <div className="px-3 pb-2.5">{body}</div>
    </div>
  );

  /*
   * 一行「标签 · 值」。
   *
   * 数字右对齐是对的——它们要对着位数扫。但**长句子右对齐并折行是最难扫的排版**，
   * 而这一节正是复核每一条时都要反复对照的背景：变异分数那句
   * 「No mutation run — whether these cases actually catch faults is unknown」
   * 在 268px 宽里折成四行，右边参差、左边标签又是左对齐，两边都没有一条可循的边。
   *
   * 所以按内容分两种：短值（数字、id）右对齐，会折行的句子改成标签在上、
   * 正文在下、整段左对齐。判据是 `wrap`，由调用处说了算——它知道自己给的是数还是话。
   */
  const row = (label: string, value: React.ReactNode, wrap = false) =>
    wrap ? (
      <div className="py-0.5 text-[0.75rem]">
        <div className="text-muted-foreground">{label}</div>
        <div className="mt-0.5 break-words leading-relaxed text-ink2">{value}</div>
      </div>
    ) : (
      <div className="flex items-baseline gap-2 py-0.5 text-[0.75rem]">
        <span className="flex-none text-muted-foreground">{label}</span>
        <span className="min-w-0 flex-1 truncate text-right font-mono text-ink2">{value}</span>
      </div>
    );

  return (
    <div>
      {sec(
        t("review.railProgress"),
        <>
          <div className="mb-1.5 h-1 overflow-hidden rounded-sm bg-accent">
            <i
              className="block h-full bg-primary"
              style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }}
            />
          </div>
          {progress.rows.map((r) => (
            <div key={r.label}>{row(r.label, r.value)}</div>
          ))}
        </>,
        `${progress.done} / ${progress.total}`,
      )}

      {sec(
        t("review.railArtifacts"),
        <>
          {row(t("review.railStories"), batch.stories?.length ?? 0)}
          {row(t("review.railCases"), items.length)}
          {row(t("review.railFindings"), findings)}
          {/*
            缺口分三类，分法是**人要怎么处置**，不是它从哪来：
            missed 补一条用例 · unseen 重跑探索 · blind 改断言。
            一个合并后的总数说不出该干什么，所以三个数各占一格。
          */}
          {row(
            t("review.railGaps"),
            gaps.length ? (
              <>
                <span className="text-warn">{missed}</span>
                {" · "}
                <span>{unseen}</span>
                {!!blind && (
                  <>
                    {" · "}
                    <span className="text-bad">{blind}</span>
                  </>
                )}
              </>
            ) : (
              0
            ),
          )}
        </>,
      )}

      {sec(
        t("review.railContext"),
        <>
          {row(t("review.ctxBatch"), <span title={batch.wfRunId}>{batch.wfRunId}</span>)}
          {row(t("review.ctxProject"), batch.projectId || t("review.noProject"))}
          {batch.gateBasis &&
            row(
              t("review.ctxFormula"),
              <span title={batch.gateBasis.formula}>{batch.gateBasis.formula}</span>,
            )}
          {(batch.exploreStopped || batch.exploreStoppedBecause) &&
            row(
              t("review.exploreStopped"),
              <span className="text-warn">
                {stopReason(t, batch.exploreStopped, batch.exploreStoppedBecause)}
              </span>,
              true,
            )}
          {/*
            「没跑过」和「0 分」必须分得开：前者是「不知道这套用例验不验得住」，
            后者是「知道，而且它一个都拦不住」。把没跑过显示成 0 分，
            是把无知包装成结论。
          */}
          {batch.mutation ? (
            <>
              {row(
                t("review.mutationScore"),
                <>
                  {Math.round(batch.mutation.score * 100)}%
                  {batch.mutation.inconclusive > 0 && (
                    <span className="ml-1 text-warn">
                      {t("review.mutationInconclusive", { n: batch.mutation.inconclusive })}
                    </span>
                  )}
                </>,
              )}
              <div className="text-[0.6875rem] leading-relaxed text-muted-foreground">
                {t("review.mutationBreak", {
                  killed: batch.mutation.killed,
                  survived: batch.mutation.survived,
                  notApplied: batch.mutation.notApplied,
                  cases: batch.mutation.cases,
                })}
              </div>
              {/*
                一个 0 分说明不了任何事，除非它带着分母。
                「12 条里 6 条基线就挂、其中 4 条是 infra、真正上场的只有 6 条」——
                没有这一句，那个 0 读起来是「这套用例什么都抓不到」，
                而事实可能是「一半的用例集根本没上场」。
              */}
              {batch.mutation.usableCases !== undefined && <MutationDenominator m={batch.mutation} />}
            </>
          ) : (
            row(t("review.mutationScore"), t("review.mutationNotRun"), true)
          )}
        </>,
      )}

      {/*
        快捷键要说出来：一个没人知道存在的快捷键等于不存在。
        它此前是 `text-faint`——这一屏唯一教人用键盘的地方，用的是全站最淡的那一档字色。
        提到 `muted-foreground`，并把键位排成键帽：一串灰色的散文没人会去读，
        一排键帽人扫一眼就知道有这回事。
      */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-[0.6875rem] text-muted-foreground">
        {/*
          v3：`1` / `3` 的说明按 tab 换（校准 tab 下是「覆盖 / 未覆盖」）。
          键位一个字没改——同一只手在三个 tab 之间来回切，改键位等于让人重学三遍；
          换的只是这两颗键**此刻在标什么**，而那件事必须写在键帽旁边，
          否则人只能靠试一次来发现自己刚才做了什么。
        */}
        {[
          ["J", "K"],
          ["X"],
          ["A"],
          ["1"],
          ["3"],
        ].map((keys, i) => (
          <span key={i} className="inline-flex items-center gap-1">
            {keys.map((k) => (
              <kbd key={k} className="kbd">
                {k}
              </kbd>
            ))}
            <span>{keyLabels[i] ?? ""}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function GapList({ gaps, wfRunId }: { gaps: Gap[]; wfRunId?: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  /** 正在补的那一条，以及补出来的结果。 */
  const [filling, setFilling] = useState("");
  const [filled, setFilled] = useState<
    Record<
      string,
      {
        title?: string;
        expected?: string;
        findings?: Array<{ rule: string; message: string }>;
        error?: string;
      }
    >
  >({});

  /**
   * 把一条缺口补成一条用例。
   *
   * 补出来的东西**进复核队列，不进看板**——它和别的候选一样，等的是同一个决定。
   * 门禁①在服务端就跑过一遍了，所以这里能立刻说出「补出来的这条自己有没有毛病」：
   * 一条判据含糊的补丁用例，不该因为它是补出来的就免检。
   */
  const fill = async (g: Gap) => {
    if (!wfRunId) return;
    const key = g.what;
    setFilling(key);
    try {
      const res = await fetch(`${API}/api/review/${wfRunId}/gap-case`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gap: g }),
      });
      const body = (await res.json()) as {
        error?: string;
        kase?: { title?: string; expected?: string };
        findings?: Array<{ rule: string; message: string }>;
      };
      setFilled((f) => ({
        ...f,
        [key]: res.ok
          ? { title: body.kase?.title, expected: body.kase?.expected, findings: body.findings ?? [] }
          : { error: body.error ?? `HTTP ${res.status}` },
      }));
    } catch (e) {
      setFilled((f) => ({ ...f, [key]: { error: (e as Error).message } }));
    } finally {
      setFilling("");
    }
  };
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
        <div className="text-[0.6875rem] leading-snug">{g.what}</div>
        {g.detail && (
          <div className="mt-0.5 break-words font-mono text-[0.6875rem] leading-snug text-muted-foreground">
            {g.detail}
          </div>
        )}
      </>
    );
    /*
     * 「补一条用例」跟在每条缺口后面。
     *
     * 缺口分析此前停在显示上：算得出、画得出，然后没有下一步。而「这套 harness
     * 会把自己漏掉的东西补回来」这句话，缺的正是这个按钮。
     * `blind` 那一类不给按钮——对着没人见过的界面写用例，它的绿色说明不了任何事，
     * 而它会看起来像覆盖率涨了一格。
     */
    const patch =
      wfRunId && g.reach !== "blind" ? (
        <div className="mt-1">
          <button
            className="cursor-pointer text-[0.6875rem] text-primary underline decoration-dotted disabled:opacity-50"
            disabled={filling === g.what}
            onClick={(e) => {
              e.stopPropagation();
              void fill(g);
            }}
            title={t("review.gapFillWhy")}
          >
            {filling === g.what ? t("review.gapFilling") : t("review.gapFill")}
          </button>
          {filled[g.what] && (
            <div className="mt-0.5 rounded bg-muted/60 px-1.5 py-1 text-[0.6875rem] leading-snug">
              {filled[g.what].error ? (
                <span className="text-bad">{filled[g.what].error}</span>
              ) : (
                <>
                  <div className="text-foreground">{filled[g.what].title}</div>
                  <div className="text-muted-foreground">→ {filled[g.what].expected}</div>
                  {/* 补出来的也过门禁。免检的补丁用例只是另一种自欺。 */}
                  {filled[g.what].findings?.length ? (
                    <div className="mt-0.5 text-warn">
                      {filled[g.what].findings!.map((f) => f.rule).join(" · ")}
                    </div>
                  ) : (
                    <div className="mt-0.5 text-ok">{t("review.gapFillClean")}</div>
                  )}
                  <div className="mt-0.5 text-muted-foreground">{t("review.gapFillWhere")}</div>
                </>
              )}
            </div>
          )}
        </div>
      ) : null;

    if (!at)
      return (
        <div key={i} className="rounded border border-dashed border-border/70 px-1.5 py-1">
          {body}
          {patch}
        </div>
      );
    const jump = (
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
        <div className="mt-0.5 text-[0.6875rem] text-primary">{t("review.gapLocate")} →</div>
      </button>
    );
    // 「补一条」不能套在那个按钮里面——按钮里嵌按钮是无效的 HTML，点击会往上冒。
    return patch ? (
      <div key={i}>
        {jump}
        <div className="px-1.5">{patch}</div>
      </div>
    ) : (
      jump
    );
  };

  return (
    <div className="mt-2 rounded-lg border border-dashed border-warn bg-warn-soft p-2">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 text-left"
      >
        <span className="flex items-center gap-2 text-[0.6875rem]">
          {!!blind.length && (
            <span
              className="rounded bg-bad-soft px-1.5 py-0.5 font-medium text-bad"
              title={t("review.gapsBlindHint")}
            >
              {blind.length} {t("review.gapsBlind")}
            </span>
          )}
          {!!missed.length && (
            <span
              className="rounded bg-warn-soft px-1.5 py-0.5 font-medium text-warn"
              title={t("review.gapsMissedHint")}
            >
              {missed.length} {t("review.gapsMissed")}
            </span>
          )}
          {!!unseen.length && (
            <span
              className="rounded bg-accent px-1.5 py-0.5 font-medium text-ink2"
              title={t("review.gapsUnseenHint")}
            >
              {unseen.length} {t("review.gapsUnseen")}
            </span>
          )}
        </span>
        <span className="text-[0.6875rem] text-muted-foreground">
          {open ? t("review.gapsHide") : t("review.gapsShow")}
        </span>
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          {!!blind.length && (
            <div className="space-y-1">
              <div className="text-[0.6875rem] font-medium text-bad">
                {t("review.gapsBlind")} · {t("review.gapsBlindHint")}
              </div>
              {blind.map(row)}
            </div>
          )}
          {!!missed.length && (
            <div className="space-y-1">
              <div className="text-[0.6875rem] font-medium text-warn">
                {t("review.gapsMissed")} · {t("review.gapsMissedHint")}
              </div>
              {missed.map(row)}
            </div>
          )}
          {!!unseen.length && (
            <div className="space-y-1">
              <div className="text-[0.6875rem] font-medium text-ink2">
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
  const orphanIds = new Set(
    batch.items.filter((i) => !stories.some((s) => s.id === i.storyId)).map((i) => i.storyId),
  );
  if (orphanIds.size)
    columns.push({
      activity: t("review.noStory"),
      stories: [...orphanIds].map((id) => ({ id, title: id, acceptance: [] })),
    });

  const tierTone = (item: ReviewItem): string =>
    item.decision === "approved"
      ? "border-ok bg-ok-soft text-ok"
      : item.codeBlocked
        ? "border-bad bg-bad-soft text-bad"
        : item.findings.some((f) => f.severity === "warn")
          ? "border-warn bg-warn-soft text-warn"
          : "border-border bg-card";

  return (
    <div className="overflow-x-auto pb-2">
      <div className="flex min-w-max gap-3">
        {columns.map((col) => (
          <div key={col.activity} className="w-[17.5rem] flex-none">
            {/* 横轴的一格：一个用户活动。它是骨架，不是分类。 */}
            <div className="mb-2 rounded-lg border border-border bg-muted/40 px-3 py-2">
              <div className="text-[0.75rem] font-semibold leading-snug">{col.activity}</div>
              <div className="mt-0.5 text-[0.6875rem] text-muted-foreground">
                {col.stories.length} {t("review.storiesUnit")} ·{" "}
                {col.stories.reduce((n, st) => n + (byStory.get(st.id)?.length ?? 0), 0)}{" "}
                {t("review.casesUnit")}
              </div>
            </div>
            <GapList gaps={gapsOf.get(col.activity) ?? []} wfRunId={batch.wfRunId} />
            <div className="space-y-2">
              {!col.stories.length && (
                <div className="rounded-lg border border-dashed border-border px-2.5 py-3 text-[0.6875rem] text-muted-foreground">
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
                        <StoryTitle story={st} compact />
                        {!st.flowId && (
                          <div className="mt-1 text-[0.6875rem] text-warn">{t("review.noFlow")}</div>
                        )}
                      </div>
                    </div>
                    <div className="mt-2 space-y-1">
                      {cases.map((c) => (
                        <button
                          key={c.caseId}
                          onClick={() => onOpenCase(c.caseId)}
                          className={cn(
                            "flex w-full items-center gap-1.5 rounded border px-1.5 py-1 text-left text-[0.6875rem] hover:brightness-95",
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
                          <span className="flex-none font-mono text-[0.6875rem] opacity-70">t{c.tier}</span>
                          <span className="truncate">{c.title}</span>
                          {c.findings.length > 0 && (
                            <span className="ml-auto flex-none font-mono text-[0.6875rem] opacity-60">
                              {c.findings.length}
                            </span>
                          )}
                        </button>
                      ))}
                      {!cases.length && (
                        <div className="px-1.5 py-1 text-[0.6875rem] text-muted-foreground">
                          {t("review.noCases")}
                        </div>
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
  const [bulkOpen, setBulkOpen] = useState(false);
  const [find, setFind] = useState("");
  const [replaceWith, setReplaceWith] = useState("");
  const [pre, setPre] = useState("");
  const [note, setNote] = useState("");

  /**
   * 点一条 finding，光标落到它挑毛病的那个字段。
   *
   * finding 此前是一行不能点的灰字：读的人得自己把 `[oracle-vague] …"到达 /owners/find 页面"`
   * 和下面三个输入框中的哪一个对上。规则本来就知道自己在说哪个字段（`field`），
   * 把这件事交给人做，是白白让每一条 finding 多花几秒。
   */
  const focusField = (caseId: string, field: CaseField) => {
    setView("list");
    setOpen((prev) => new Set(prev).add(caseId));
    // 展开是下一帧的事，所以等一拍再找输入框。
    setTimeout(() => {
      const card = document.getElementById(`case-${caseId}`);
      card?.scrollIntoView({ block: "center" });
      const el = card?.querySelector<HTMLElement>(`[data-field="${field}"]`);
      if (el) {
        el.focus();
        // 前置/方法/覆盖目前没有对应的输入框——闪一下那一段，至少说明它指的是哪里。
      } else {
        const seg = card?.querySelector<HTMLElement>(`#field-${field}-${caseId}`);
        seg?.animate?.([{ opacity: 1 }, { opacity: 0.35 }, { opacity: 1 }], { duration: 700, iterations: 2 });
      }
    }, 0);
  };

  /** 点一条覆盖的转移，跳到产品地图上那条边。用的是缺口那套锚点，不另发明一份。 */
  const openTransition = (from: string, to: string) => {
    const [path] = window.location.hash.split("?");
    window.location.hash = `${path || "#/"}?open=map&at=${encodeURIComponent(`edge:${from}->${to}`)}`;
  };
  // Regeneration is a model call per case and takes tens of seconds on a local model, so
  // it says how many are in flight rather than freezing the page with no explanation.
  const [regenerating, setRegenerating] = useState(0);
  // Only for a run that was never bound to a project — the self-test is the usual case.
  // Asked for explicitly rather than defaulted: which board these land in is a decision,
  // and a silent default would put generated cases somewhere nobody chose.
  const [intoProject, setIntoProject] = useState("");
  /** 地图还是列表。默认地图——总览先于逐条，这是这一页存在的理由。 */
  /**
   * 三种看法：地图 / 队列+详情 / 平铺列表。
   *
   * `split` 是复核真正要的那一种——左边一条队列，右边一条详情，同屏。
   * 复核是这个产品每天要做上百次的动作：一屏里既看得见"还剩多少"，又看得见"这一条是什么"，
   * 而平铺列表两样都要靠滚动去换。
   */
  const [view, setView] = useState<"map" | "split" | "list">("split");
  /**
   * 筛选条件从地址里来，也回地址里去。
   *
   * 复核是一件会被打断、会被交接的事：「你看一下这批里所有负例里门禁拦下的那几条」
   * 这句话应该是一个可以发出去的链接，而不是一串口头的操作步骤。
   */
  const [filters, setFilters] = useState<ReviewFilters>(() =>
    filtersFromParams(new URLSearchParams(window.location.hash.split("?")[1] ?? "")),
  );

  /**
   * 审计台的三个 tab，以及它们各自的来源数据。
   *
   * tab 走地址（`?tab=scan`）而不是只走 state，理由和筛选条件走地址是同一条：
   * 复核是会被交接的事。「你看一下这次运行 Scanner 标出的那几条」应该是一个可以发出去的
   * 链接，而不是「打开复核，点第二个 tab」这样一串口头步骤。
   *
   * 默认落在**校准**：`00-架构.md` §5 最后一条——「第 0 步仍是人标 30 条」。
   * 一个还没校准过 judge 的运行，它的审计报告与 diff 都还没有可信的阈值。
   */
  const [auditTab, setAuditTab] = useState<AuditTab>(() => {
    const want = new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("tab");
    return isAuditTab(want) ? want : "calibrate";
  });
  const [calib, setCalib] = useState<CalibrationPayload | undefined>();
  const [scan, setScan] = useState<ScanReport | undefined>();
  const [diff, setDiff] = useState<DiffPayload | undefined>();
  /** 这一屏此刻读的是不是假数据。它要印在界面上，见 `lib/audit.ts` 的 `Fetched`。 */
  const [auditMock, setAuditMock] = useState(auditMockOn());
  /** 服务端已有的标注 + 这次刚标的。合起来才是「已标了几条」。 */
  const [labels, setLabels] = useState<HumanLabel[]>([]);

  const loadRuns = async () => {
    try {
      const { runs: list } = (await fetch(`${API}/api/review`).then((r) => r.json())) as { runs: RunRow[] };
      setRuns(list);
      // Opened from the run that produced this batch, open that one. Landing on a list of
      // twenty runs after clicking"去复核" on one of them is asking the same question twice.
      if (!batch) {
        /*
         * 落在哪一批，按这个顺序问三次：**地址里指的那一批 → 上次停下的那一批 → 最新的一批**。
         *
         * 「最新一次运行」此前是无条件的默认，与我昨天在看什么无关——一个每天要做上百次
         * 的动作，每次回来都从头开始。它现在退到最后一位：只有前两个都答不上来时才用。
         */
        let remembered = "";
        try {
          remembered = (JSON.parse(safeGet(LAST_PLACE) || "{}") as { run?: string }).run ?? "";
        } catch {
          /* 存坏了就当没有 */
        }
        const wanted =
          (focusRun && list.some((r) => r.wfRunId === focusRun) && focusRun) ||
          (remembered && list.some((r) => r.wfRunId === remembered) && remembered) ||
          list[0]?.wfRunId;
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

  /**
   * 当前 tab 的来源数据。
   *
   * **只拉当前那一个**，不三个一起拉：三个端点各自要读一批文件（30 条抽样要按故事分层、
   * scan 要跨运行汇总、diff 要读上次批准集），而人一次只看一个镜头。
   * 三个一起拉会让切一次批次等三次，其中两次的结果他这一分钟根本不会看。
   *
   * `alive` 那道闸是给「连点两个 tab」用的：先发的那个请求后到，就会把后发的结果盖掉，
   * 表现成「点了变化，出来的是审计报告」——一个自己会跳回去的界面，人只能怪自己点错了。
   */
  useEffect(() => {
    const runId = batch?.wfRunId;
    if (!runId) return;
    let alive = true;
    void (async () => {
      try {
        if (auditTab === "calibrate") {
          const { data, mock } = await fetchCalibration(runId);
          if (!alive) return;
          setCalib(data);
          setLabels(data.labels);
          setAuditMock(mock);
        } else if (auditTab === "scan") {
          const { data, mock } = await fetchScan(runId);
          if (!alive) return;
          setScan(data);
          setAuditMock(mock);
        } else {
          const { data, mock } = await fetchDiff(runId);
          if (!alive) return;
          setDiff(data);
          setAuditMock(mock);
        }
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    })();
    return () => {
      alive = false;
    };
  }, [batch?.wfRunId, auditTab]);

  /** tab 写回地址。和筛选条件一样用 `replaceState`：切镜头不该在后退键上堆一层。 */
  useEffect(() => {
    const [path, query] = window.location.hash.replace(/^#/, "").split("?");
    const params = new URLSearchParams(query ?? "");
    params.set("tab", auditTab);
    const next = `#${path || "/"}?${params}`;
    if (next !== window.location.hash) window.history.replaceState(null, "", next);
  }, [auditTab]);

  /**
   * 地址里的 `?tab=` 变了就跟过去。
   *
   * 这一条不是多余的：别人发来的链接粘进一个**已经开着**的标签页时，只有 hash 变，
   * 页面不重挂载，上面那个 `useState` 的初值也就不会再算一遍——链接在同事的浏览器里
   * 看起来是坏的（点了没反应），而在自己这里因为是新开的窗口，怎么试都是对的。
   * 实测过一次：`?tab=scan` 停在校准。
   */
  useEffect(() => {
    const onHash = () => {
      const want = new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("tab");
      if (!isAuditTab(want) || want === auditTab) return;
      setAuditTab(want);
      setCursor(0);
      setSelected(new Set());
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [auditTab]);

  /**
   * 键盘决策：J/K 走、X 选、1 批准、3 打回、A 全选待复核。
   *
   * 复核是这个产品**每天要做上百次**的动作，而它此前只能用鼠标：
   * 每判断一条要「移到复选框 → 点 → 移到按钮 → 点」，一百条就是四百次移动。
   * 这也是 GitHub / Linear / Label Studio 三个 review-heavy 的产品都做了同一件事的原因。
   *
   * 三条纪律：
   * ① 焦点在输入框里时一律不接管——这一页有查找替换框，吃掉 `1` 会让人以为键盘坏了；
   * ② 决策键只作用于**已选中**的那批，与鼠标点按钮走同一条路（`act`），
   *    不另开一条捷径：两条路会长出两种行为，而其中一种没人测；
   * ③ 光标移动要把那一条**滚进视野**，否则按 J 之后人不知道自己在哪。
   */
  const [cursor, setCursor] = useState(0);
  /* 低于 xl 时右栏是 `hidden`，那块背景就没有任何入口了——这个开关是它的门。 */
  const [railOpen, setRailOpen] = useState(false);
  /**
   * 键盘处理器只挂一次，而它要用的东西每次渲染都在变。
   * 用一个每次渲染更新的 ref 把当前值交给它——否则闭包会捕获第一次渲染时的空列表，
   * 表现成「按 J 没反应」，而且不报错。
   */
  const live = useRef({
    list: [] as ReviewItem[],
    cursor: 0,
    act: (_d: "approve" | "reject") => {},
    toggle: (_id: string) => {},
    selectAll: () => {},
  });

  /**
   * 批准或打回。
   *
   * **口径是「先选中的，否则光标那一条」**——不是「没选中就什么都不做」。
   *
   * 之前是后者，而键盘的 `1`/`3` 走的正是这条路：没勾选时按下去静默无事，
   * 没有报错、没有提示、什么都不动。人从这里只能得出一个结论——「快捷键是假的」，
   * 然后改回鼠标，于是每条 4 次操作（勾 → 点 → 找到底部浮条 → 点），75 条就是 300 次。
   * 而 `03 §6` 要的是单条、当场、一键。
   *
   * 上面那段注释说过「吃掉 `1` 会让人以为键盘坏了」，所以防了输入框里的按键；
   * 空选这一路是同一件事的另一半，之前没防。
   */
  /**
   * 校准 tab 上，`1` / `3` 标的是「覆盖了 / 没覆盖」。
   *
   * **同一对键，换的是宾语，不是动作。** 人在这三个 tab 之间来回切，
   * 手上的动作始终是「看一条 → 说一句 → 下一条」；给校准另配一对键，
   * 等于要求人记住自己此刻在哪个 tab 才敢按键。所以走 `act` 同一个入口
   * （见上面那条纪律②：决策键不另开捷径），在这里分岔。
   *
   * 口径也照抄 `act`：**先选中的，否则光标那一条**。区别只有一个——
   * 已经标过的仍然可以再标：校准是一份会被回头修正的样本，
   * 而「批准」是一次写进套件的动作，两者对「改主意」的容忍度本来就不同。
   */
  const labelAct = async (covered: boolean, ids?: string[]) => {
    if (!batch) return;
    const list = visibleRef.current;
    const fromSelection = !ids && selected.size > 0;
    const cursorId = list[cursor]?.caseId;
    const targets: string[] = ids ?? (fromSelection ? [...selected] : cursorId ? [cursorId] : []);
    if (!targets.length) return;
    const at = new Date().toISOString();
    const made: HumanLabel[] = [];
    for (const caseId of targets) {
      const gold = rowFor.get(caseId)?.gold;
      if (!gold) continue;
      /* `by` 这个产品还没有登录态，所以填 "human"——它要区分的是**人标的还是模型标的**
         （`calibrate_judge` 拿它当锚），不是哪一个人标的。 */
      made.push({ goldId: gold.id, caseId, runId: batch.wfRunId, covered, by: "human", at, heldOut: gold.heldOut });
    }
    if (!made.length) return;
    setLabels((prev) => [
      ...prev.filter((l) => !made.some((m) => m.caseId === l.caseId && m.goldId === l.goldId)),
      ...made,
    ]);
    if (fromSelection) setSelected(new Set());
    /* 标完往下走一条**还没标过的**——和 `act` 里那段光标前进是同一件事，同一个理由：
       一次要过 30 条的界面，每条之后还要人自己按一下 J，那 30 下就是白花的。 */
    const done = new Set(targets);
    const anchor = Math.max(cursor, ...targets.map((id) => list.findIndex((i) => i.caseId === id)));
    const nextIdx = list.findIndex(
      (i, idx) => idx > anchor && !done.has(i.caseId) && rowFor.get(i.caseId)?.covered === undefined,
    );
    if (nextIdx >= 0) {
      setCursor(nextIdx);
      requestAnimationFrame(() =>
        document.querySelector(`[data-case="${list[nextIdx]!.caseId}"]`)?.scrollIntoView({ block: "nearest" }),
      );
    }
    setBusy(true);
    setError("");
    try {
      await postLabels(batch.wfRunId, made);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const act = async (decision: "approve" | "reject", ids?: string[]) => {
    if (!batch) return;
    // 校准 tab 上这两颗键标的是「覆盖 / 未覆盖」，不是批准/打回。见 `labelAct`。
    if (auditTab === "calibrate") return labelAct(decision === "approve", ids);
    const fromSelection = !ids && selected.size > 0;
    const targets =
      ids ?? (fromSelection ? [...selected] : [visibleRef.current[cursor]].filter((i) => i && !i.decision).map((i) => i!.caseId));
    if (!targets.length) return;
    /*
     * 两道闸，都必须**说出原因**而不是静默不动。
     *
     * 上面那段注释已经写过一次同样的教训：空选时按 `1` 静默无事，人得出的结论是
     * 「快捷键是假的」，然后改回鼠标。这两道闸是同一类静默：
     *
     * ① `removed` 那些用例**已经不在这一批里**，批准它无处可写；
     * ② `block` 级的 Scanner 判定默认不可批准——断言恒真、断言查不到锚、
     *    步骤引用了不存在的控件，这三种放进套件之后会长期给出假绿。
     *    「默认」不是「永远」：打回随时可以，改完重扫也可以，
     *    但**顺手批准**这条路要关掉，因为它正是 reward hacking 得手的那条路
     *    （`00-架构.md` §5：reward hacking 是默认假设，2603.11337 ~50%）。
     */
    if (targets.some((id) => rowFor.get(id)?.readOnly)) {
      setError(t("audit.readOnlyWhy"));
      return;
    }
    if (decision === "approve" && targets.some((id) => worstSeverity(rowFor.get(id)) === "block")) {
      setError(t("audit.blockedWhy"));
      return;
    }
    // 批准要写进某个项目。没绑项目又没选，就地说明白为什么不能批准——
    // 让它撞后端返回一句 HTTP 4xx，等于把「这里缺一个选择」翻译成一句人读不懂的话。
    if (decision === "approve" && !batch.projectId && !intoProject) {
      setError(t("review.needProjectWhy"));
      return;
    }
    /*
     * 决定完，光标自己往前走。
     *
     * 之前它不动，于是第 75 条和第 1 条的终点体验完全一样：人每决定一次，
     * 还要手动按一下 J，或者回头找自己刚才停在哪儿。一次要过上百条的界面，
     * 这一下是省不得的。
     *
     * 目标在动作**之前**就算好——动作之后列表会重取，按 id 找回位置比按下标可靠：
     * 筛选条件可能把已决定的那几条直接从列表里拿掉，下标会整体前移。
     */
    const before = visibleRef.current;
    const done = new Set(targets);
    const anchor = Math.max(cursor, ...targets.map((id) => before.findIndex((i) => i.caseId === id)));
    const nextId = before.slice(anchor + 1).find((i) => !i.decision && !done.has(i.caseId))?.caseId;
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`${API}/api/review/${batch.wfRunId}/${decision}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          caseIds: targets,
          ...(decision === "approve" && !batch.projectId && intoProject ? { projectId: intoProject } : {}),
        }),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      await openRun(batch.wfRunId);
      await loadRuns();
      // Approving writes to the board, so the rest of the app has to hear about it.
      if (decision === "approve") await loadData();
      // 刚决定过的那几条已经不能再决定了。留着它们，底部那条浮条会继续说
      // 「已选 N」，而那 N 条一个也按不动。
      if (fromSelection) setSelected(new Set());
      if (nextId) {
        // 等这一帧的重渲染落地，再按 id 找回它现在的位置。
        requestAnimationFrame(() => {
          const idx = visibleRef.current.findIndex((i) => i.caseId === nextId);
          if (idx < 0) return;
          setCursor(idx);
          document.querySelector(`[data-case="${nextId}"]`)?.scrollIntoView({ block: "nearest" });
        });
      }
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
        steps: draft.steps
          .split("\n")
          .map((x) => x.trim())
          .filter(Boolean),
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

  /**
   * 一次批量改动之后能撤回。
   *
   * 批量操作是这一页唯一一处「一下改二十条」的动作，而它此前没有后路：
   * 替换词打错一个字，二十条一起错，只能一条条手改回去。
   *
   * 撤销走的是服务端已有的 `revert`——**回到 harness 产出的原样**。所以它不是
   * 「回到上一步」：这一条如果在这次批量之前就被人改过，那次修改也会一起没掉。
   * 这一点写在按钮上，不藏着：一个说不清自己会做什么的撤销比没有撤销更糟。
   */
  const [undoable, setUndoable] = useState<{ ids: string[]; what: string } | null>(null);

  const batchOp = async (op: Record<string, unknown>, ids?: string[]) => {
    const caseIds = ids ?? [...selected];
    if (!batch || !caseIds.length) return;
    setBusy(true);
    setError("");
    try {
      await post("/batch", { caseIds, op });
      setDrafts({});
      // revert 自己不留后路——撤销一次撤销没有意义，而且会让人以为它是"重做"。
      setUndoable(op.kind === "revert" ? null : { ids: caseIds, what: String(op.kind) });
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
      // waiting on it and would otherwise read"nothing changed" as"nothing to change".
      if (out.failed?.length) setError(out.failed.map((f) => `${f.caseId}: ${f.message}`).join(" | "));
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

  /**
   * 键盘决策：J/K 走、X 选、1 批准、3 打回、A 全选待复核。
   *
   * 复核是这个产品**每天要做上百次**的动作，而它此前只能用鼠标：每判断一条要
   * 「移到复选框 → 点 → 移到按钮 → 点」，一百条就是四百次移动。
   * GitHub / Linear / Label Studio 三个 review-heavy 的产品都做了同一件事。
   *
   * 三条纪律：
   * ① 焦点在输入框里时一律不接管——这一页有查找替换框，吃掉 `1` 会让人以为键盘坏了；
   * ② 决策键走的是**和按钮同一条路**（`act`），不另开捷径：两条路会长出两种行为，
   *    而其中一种没人测；
   * ③ 光标移动要把那一条滚进视野，否则按 J 之后人不知道自己在哪。
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      const { list } = live.current;
      if (k === "j" || k === "k") {
        e.preventDefault();
        setCursor((n) => {
          const next = Math.max(0, Math.min(list.length - 1, n + (k === "j" ? 1 : -1)));
          const id = list[next]?.caseId;
          if (id) document.querySelector(`[data-case="${id}"]`)?.scrollIntoView({ block: "nearest" });
          return next;
        });
      } else if (k === "x") {
        e.preventDefault();
        const id = live.current.list[live.current.cursor]?.caseId;
        if (id) live.current.toggle(id);
      } else if (k === "1") {
        e.preventDefault();
        live.current.act("approve");
      } else if (k === "3") {
        e.preventDefault();
        live.current.act("reject");
      } else if (k === "a") {
        e.preventDefault();
        live.current.selectAll();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 筛选条件写回地址。用 replaceState 而不是改 hash：每敲一个字都留一条历史，
  // 会让浏览器的后退键变成一个删字键。
  useEffect(() => {
    const [path, query] = window.location.hash.replace(/^#/, "").split("?");
    const params = filtersToParams(filters, new URLSearchParams(query ?? ""));
    const next = `#${path || "/"}${params.toString() ? `?${params}` : ""}`;
    if (next !== window.location.hash) window.history.replaceState(null, "", next);
  }, [filters]);

  const activityOf = activityIndex(batch?.stories);
  /**
   * 筛出来给人看的那一批。**只影响看到什么，不影响选中了什么**——
   * 人先筛一批、全选、再换条件去看别的，之前选中的不该被悄悄丢掉：
   * 批准的是他选的那批，不是他此刻看得见的那批。
   */
  /**
   * 这个 tab 要人处理的那些条目。
   *
   * **v3：队列的来源从「这一批全部用例」换成三份筛过的集合。**
   * 理由是那两个数——297 条生成、0 条被决定：一份要求人看全部的队列，人一条也不看。
   *
   * 产出仍然是 `ReviewItem[]`，这是刻意的：J/K 走位、`role="listbox"` 的
   * 「75 之 14」、光标自动前进、`ItemCard`、底部批量条——它们全都是围绕这个类型写的，
   * 换掉它就等于把这一屏做对的那部分一起重写一遍。
   * 「这一条为什么在队列里」挂在旁边那张 `rowFor` 表上（见 `AuditRow`）。
   */
  const auditRows: AuditRow[] = [];
  if (auditTab === "calibrate") {
    for (const s of calib?.sample ?? [])
      auditRows.push({
        caseId: s.caseId,
        tab: "calibrate",
        gold: { id: s.goldId, title: s.goldTitle, heldOut: s.heldOut },
        covered: labels.find((l) => l.caseId === s.caseId && l.goldId === s.goldId)?.covered,
      });
  } else if (auditTab === "scan") {
    /* 同一条用例可能被标出好几处（断言恒真**且**引用了不存在的控件）。
       一条用例一行、把它身上的 finding 全带上——拆成两行会让「标出了几条用例」
       和「标出了几处问题」变成同一个数，而人要处置的单位是用例。 */
    const byCase = new Map<string, ScanFinding[]>();
    for (const f of scan?.findings ?? []) byCase.set(f.caseId, [...(byCase.get(f.caseId) ?? []), f]);
    for (const [caseId, findings] of byCase) auditRows.push({ caseId, tab: "scan", findings });
  } else {
    /* 顺序是**新增 → 断言变了 → 消失**：前两类要人决定，最后一类只能看。
       把只读的那些排在最后，J 键一路走下来才不会中途撞上一段按什么都没反应的区间。 */
    for (const id of diff?.added ?? []) auditRows.push({ caseId: id, tab: "diff", change: "added" });
    for (const c of diff?.changed ?? [])
      auditRows.push({
        caseId: c.caseId,
        tab: "diff",
        change: "changed",
        before: c.before.expected,
        after: c.after.expected,
      });
    for (const r of diff?.removed ?? [])
      auditRows.push({ caseId: r.caseId, tab: "diff", change: "removed", title: r.title, readOnly: true });
  }
  const rowFor = new Map(auditRows.map((r) => [r.caseId, r]));
  const itemById = new Map((batch?.items ?? []).map((i) => [i.caseId, i]));
  const auditItems: ReviewItem[] = auditRows.map((r) => {
    const base =
      itemById.get(r.caseId) ??
      stubItem(r.caseId, r.title ?? r.gold?.title ?? r.findings?.[0]?.evidence ?? r.caseId);
    /* 校准 tab 的「已标」借用 `decision` 这个字段承载——不是偷懒：光标前进、
       条目变暗、复选框禁用这三件事都挂在它上面，另开一个字段就要把这三处各写一遍。
       它显示成什么由队列自己说（`decisionLabel`），不会印出 approved。 */
    if (r.tab === "calibrate" && r.covered !== undefined)
      return { ...base, decision: r.covered ? ("approved" as const) : ("rejected" as const) };
    return base;
  });
  const visible = auditItems.filter((i) => matches(i, filters, activityOf));
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  /**
   * 光标停在哪一条，写进地址（`?peek=`）也写进本地记忆。
   *
   * 两个用处，一个是给别人的，一个是给自己的：
   * - 给别人：任意一条的地址可以复制到另一台机器上打开同一个视图——复核是会被交接的事，
   *   「你看一下这批里第 14 条」应该是一个链接，不是一串口头步骤；
   * - 给自己：关掉浏览器再打开，落回同一条、同一筛选，而不是「这张图最新的那次运行」。
   */
  useEffect(() => {
    const item = visibleRef.current[cursor];
    if (!item) return;
    const [path, query] = window.location.hash.replace(/^#/, "").split("?");
    const params = new URLSearchParams(query ?? "");
    params.set("peek", item.caseId);
    const next = `#${path || "/"}?${params}`;
    if (next !== window.location.hash) window.history.replaceState(null, "", next);
    safeSet(LAST_PLACE, JSON.stringify({ run: batch?.wfRunId ?? "", peek: item.caseId }));
  }, [cursor, batch]);

  /**
   * 地址里带 `?peek=` 时，把光标落到那一条并滚进视野。
   *
   * 只在这一批刚打开时做一次：之后人自己按 J/K 移动，再去追地址会把光标抢回去。
   */
  const peeked = useRef("");
  useEffect(() => {
    if (!batch) return;
    const want = new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("peek");
    if (!want || peeked.current === want) return;
    const idx = visible.findIndex((i) => i.caseId === want);
    if (idx < 0) return;
    peeked.current = want;
    setCursor(idx);
    requestAnimationFrame(() => {
      document.getElementById(`case-${want}`)?.scrollIntoView({ block: "center" });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batch, visible.length]);

  /** 每次渲染把当前值交给键盘处理器——它只挂一次，闭包看不到后来的状态。 */
  live.current = {
    list: visible,
    cursor,
    act: (decision) => void act(decision),
    toggle,
    selectAll: () => setSelected(new Set(visible.filter((i) => !i.decision).map((i) => i.caseId))),
  };
  const pending = visible.filter((i) => !i.decision);
  const hasTabs = !!useSurfaceTabs();

  /**
   * 右栏 PROGRESS 的分子分母，按 tab 换。
   *
   * 分母是这一节唯一要紧的东西：拿「这一批全部 297 条」去量「30 条样本标了几条」，
   * 读出来永远是个位数百分比，而人其实已经做完了。三个 tab 的分母各自是
   * 30 / Scanner 标出数 / 变化数。
   */
  const decidedCount = visible.filter((i) => !!i.decision).length;
  const railProgress: RailProgress = (() => {
    if (auditTab === "calibrate") {
      const sample = calib?.sample ?? [];
      const labelled = sample.filter((s) =>
        labels.some((l) => l.caseId === s.caseId && l.goldId === s.goldId),
      );
      return {
        done: labelled.length,
        total: sample.length,
        rows: [
          { label: t("audit.covered"), value: labelled.filter((s) => rowFor.get(s.caseId)?.covered).length },
          {
            label: t("audit.notCovered"),
            value: labelled.filter((s) => rowFor.get(s.caseId)?.covered === false).length,
          },
          { label: t("audit.heldOut"), value: sample.filter((s) => s.heldOut).length },
        ],
      };
    }
    if (auditTab === "scan") {
      const block = auditRows.filter((r) => worstSeverity(r) === "block").length;
      return {
        done: decidedCount,
        total: auditRows.length,
        rows: [
          { label: t("audit.severity.block"), value: block },
          { label: t("audit.severity.warn"), value: auditRows.length - block },
          { label: t("review.pending"), value: auditRows.length - decidedCount },
        ],
      };
    }
    /* 消失的那些**不进分母**：它们只读，永远决定不了。一个到不了头的分母
       会一直说「你还没做完」，而那是一句假话。 */
    const decidable = auditRows.filter((r) => !r.readOnly);
    return {
      done: decidable.filter((r) => visible.find((i) => i.caseId === r.caseId)?.decision).length,
      total: decidable.length,
      rows: [
        { label: t("audit.change.added"), value: diff?.added.length ?? 0 },
        { label: t("audit.change.changed"), value: diff?.changed.length ?? 0 },
        { label: t("audit.change.removed"), value: diff?.removed.length ?? 0 },
      ],
    };
  })();

  /** 键帽文案：`1`/`3` 在校准 tab 下标的是「覆盖 / 未覆盖」，其余两 tab 仍是批准/打回。 */
  const keyLabels = [
    t("review.key.0"),
    t("review.key.1"),
    t("review.key.2"),
    auditTab === "calibrate" ? t("audit.covered") : t("review.key.3"),
    auditTab === "calibrate" ? t("audit.notCovered") : t("review.key.4"),
  ];

  return (
    /*
     * **这一屏是工作台，不是文档。**
     *
     * 它此前是一根 `max-w-4xl` 的居中阅读列，页内还自带一个 `<h1>` 加副标题段落——
     * 那是博客的排版。复核一次要过上百条，人需要的是「队列在左、这一条在右、
     * 背景常驻在更右」，三栏各自滚动、一起撑满视口；标题和门禁分数属于顶栏那一行，
     * 不该占掉正文的前两屏。
     *
     * 外层因此是 `min-h-0 flex-1 flex-col`：`min-h-0` 是关键，少了它，
     * flex 子项的默认 `min-height:auto` 会让内部的 `overflow-auto` 失效，
     * 三栏会一起把页面撑长，又变回一根长列。
     */
    <div className="relative flex min-h-0 flex-1 flex-col">
      <ProjectRevisionLinks />
      {/*
        顶栏。一行说清「这是哪一屏、看的是哪一批、门禁多少分、决定了几条」。
        副标题走等宽体不是装饰：批次号、百分比、分数都是拿来对齐着扫的。
      */}
      <div className="flex flex-none items-center gap-x-3 border-b border-border px-3 py-2">
        {!hasTabs && (
          <h2 className="flex-none text-[1.0625rem] font-semibold leading-tight text-foreground">
            {t("surface.review")}
          </h2>
        )}
        {/* 同一组的其它镜头：用例看板、需求追溯。它们不再各占一个导航项，
            而激活的那一个就是这一屏的标题。 */}
        <SurfaceTabsRow />
        {batch && (
          <span className="flex-none font-mono text-[0.75rem] text-muted-foreground" title={batch.wfRunId}>
            {batch.wfRunId}
            {batch.gateScore !== undefined && ` · ${t("review.gate")} ${Math.round(batch.gateScore * 100)}%`}
            {/* 两个数字，不是一个：第二个是同一把门禁重读改过之后的用例。 */}
            {batch.editedGateScore !== undefined && (
              <span className="text-foreground">
                {" → "}
                {Math.round(batch.editedGateScore * 100)}% ({t("review.afterEdits")} {batch.edited})
              </span>
            )}
            {!batch.projectId && ` · ${t("review.noProject")}`}
          </span>
        )}
        {/* 门禁的判决是这条流水线上最硬的一个结论，而它此前只给一个百分比。
            58% 差在哪？分母是什么？把分拖下来的是哪几条？——都在这个按钮里，
            而且那几条是可以点进去的。 */}
        {batch?.gateBasis && batch.gateBasis.flagged.length > 0 && (
          <button
            className="inline-flex min-h-[1.5625rem] flex-none items-center rounded border border-warn bg-warn-soft px-[0.625rem] py-[0.1875rem] text-[0.8125rem] leading-[1.35] text-warn hover:brightness-95"
            title={batch.gateBasis.formula}
            onClick={() =>
              setFilters({ ...EMPTY_FILTERS, finding: filters.finding === "warn" ? "" : "warn" })
            }
          >
            {t("review.gateDrag", { n: batch.gateBasis.flagged.length, total: batch.gateBasis.cases })}
          </button>
        )}

        {/*
          批次切换。它横向滚，不换行——顶栏一旦会长高，下面三栏的高度就跟着跳，
          而人正在里面用 J/K 走位。
        */}
        <div className="hscroll flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
          {runs.map((r) => (
            <button
              key={r.wfRunId}
              title={r.wfRunId}
              onClick={() => void openRun(r.wfRunId)}
              className={cn(
                "inline-flex min-h-[1.5625rem] flex-none items-center rounded border px-[0.625rem] py-[0.1875rem] font-mono text-[0.6875rem] leading-[1.35]",
                batch?.wfRunId === r.wfRunId
                  ? "border-primary bg-primary-soft text-primary"
                  : "border-border text-muted-foreground hover:bg-accent",
              )}
            >
              {batchStamp(r.startedAt) || r.wfRunId} · {r.pending}/{r.total}
            </button>
          ))}
          {runs.length === 0 && (
            <span className="text-[0.75rem] text-muted-foreground">{t("review.noRuns")}</span>
          )}
        </div>

        {batch && (
          <span className="flex-none font-mono text-[0.75rem] text-muted-foreground">
            {batch.items.length - batch.pending} / {batch.items.length} {t("review.decided")}
          </span>
        )}
        {/*
          「这次它看得到什么」在 xl 以下是 `hidden`——三栏挤不下，这一步是对的。
          但此前它就到此为止：**那块背景在窄屏上直接消失，没有任何入口**，
          而它正是复核每一条时都要对着看的东西（这次运行绑的是哪个目标、读了哪些物料、
          消融了什么、变异分数是多少）。现在它折进一个抽屉，按钮只在放不下三栏时出现。
        */}
        {batch && (
          <Button className="flex-none xl:hidden" onClick={() => setRailOpen(true)}>
            {t("review.railOpen")}
          </Button>
        )}
        {/* 没绑项目时才需要问「批准进哪个项目」。绑了的时候它是噪声。
            没选之前把原因写在旁边——`03 §6` 的断言点要的不只是禁用，是**写出原因**。 */}
        {batch && !batch.projectId && !intoProject && (
          <span className="flex-none text-[0.6875rem] text-warn">{t("review.needProjectWhy")}</span>
        )}
        {batch && !batch.projectId && (
          <select
            className="min-h-[1.5625rem] flex-none rounded border border-input bg-card px-[0.5rem] py-[0.1875rem] text-[0.8125rem] leading-[1.35]"
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
        {/* 地图 / 队列+详情 / 列表。默认是**队列+详情**：这一屏每天要过上百条，
            默认视图该是干活的那个；地图是回答「还缺什么」时才切过去的那一眼。 */}
        <div className="flex flex-none overflow-hidden rounded border border-input">
          {(["map", "split", "list"] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={cn(
                "inline-flex min-h-[1.5625rem] items-center px-[0.625rem] py-[0.1875rem] text-[0.8125rem] leading-[1.35]",
                view === v ? "bg-primary text-primary-foreground" : "bg-card hover:bg-accent",
              )}
            >
              {v === "map"
                ? t("review.viewMap")
                : v === "split"
                  ? t("review.viewSplit")
                  : t("review.viewList")}
            </button>
          ))}
        </div>
      </div>

      {/*
        审计台的三个镜头。

        它是**第二排**而不是并进页头那一排：页头那三个（审计台 · 用例看板 · 需求追溯）
        换的是「看哪个对象」，这三个换的是「这一屏里装谁」。两组混在一行，
        人分不出按下去会发生哪一种事。
        `TabsRow` 和页头那排是同一个组件——同一个界面里两排 tab，
        方向键必须一样能走（见 `surfaceTabs.tsx`）。
      */}
      <div className="flex flex-none items-center gap-2 border-b border-border px-3 py-1.5">
        <TabsRow
          label={t("surface.review")}
          tabs={AUDIT_TABS.map((id) => ({ id, label: t(`audit.tab.${id}`) }))}
          current={auditTab}
          onSwitch={(id) => {
            if (!isAuditTab(id)) return;
            setAuditTab(id);
            // 换镜头就换了一队人：光标留在第 14 条会指到另一件东西上。
            setCursor(0);
            setSelected(new Set());
          }}
        />
        <span className="min-w-0 flex-1 truncate text-[0.75rem] text-muted-foreground">
          {t(`audit.tabWhy.${auditTab}`)}
        </span>
        {auditTab === "calibrate" && calib?.kappa !== undefined && (
          <span className="flex-none font-mono text-[0.75rem] text-muted-foreground" title={t("audit.kappaWhy")}>
            κ {calib.kappa.toFixed(2)}
          </span>
        )}
        {auditTab === "scan" && scan && (
          <span className="flex-none font-mono text-[0.75rem] text-muted-foreground">
            {t("audit.scanner")} {scan.scanner}
          </span>
        )}
      </div>

      {/*
        假数据要说出来。

        三个端点 Phase 1C 才建，在那之前这一屏读的是内置样例——而一屏画得和真的一样的
        假数字，比一屏空白危险得多：人会拿它去做决定。所以它印在最上面，
        用空态卡而不是一行小字：小字会被当成脚注滑过去。
      */}
      {auditMock && (
        <EmptyState
          className="m-3 flex-none"
          title={t("audit.mockTitle")}
          body={t("audit.mockWhy")}
        />
      )}

      {error && (
        <div className="flex-none border-b border-border bg-bad-soft px-3 py-1 text-[0.75rem] text-bad">
          {error}
        </div>
      )}

      {batch && (
        <>
          <FilterBar
            filters={filters}
            onChange={setFilters}
            stories={batch.stories ?? []}
            items={batch.items}
            shown={visible.length}
          />

          {/*
            主体。三栏各自滚动，一起撑满剩下的高度。
            `min-h-0` 同样是让内部滚动条真的出现的那一行。
          */}
          <div className="min-h-0 flex-1 overflow-hidden">
            {view === "map" ? (
              <div className="h-full overflow-auto p-3">
                <StoryMap
                  batch={{ ...batch, items: visible }}
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
                      for (const id of ids) on ? n.add(id) : n.delete(id);
                      return n;
                    })
                  }
                  onOpenCase={(id) => {
                    setView("split");
                    const idx = visible.findIndex((i) => i.caseId === id);
                    if (idx >= 0) setCursor(idx);
                    setOpen((o) => new Set(o).add(id));
                  }}
                />
              </div>
            ) : view === "split" ? (
              /*
               * 队列 | 详情 | 背景，三栏。
               *
               * 左边只给「认得出是哪一条」所需的最少东西：标题、决策、门禁点了几处。
               * 中间是光标那一条的全部，永远展开——详情栏里再放一个折叠箭头，
               * 等于让人在已经点开的东西上再点一次。
               * 右边是读**任何一条**时都要对着看的背景，所以**放得下的时候它常驻**而不是抽屉：
               * 装进抽屉，人每判断一条就要开关一次，而抽屉一开就盖住了它要解释的那个东西。
               * 但 xl 以下三栏挤不下，它是 `hidden`——那时才退回抽屉，由页头那颗按钮开。
               * 之前只有 `hidden` 那一半：窄屏上这块背景直接消失，没有任何入口。
               * J/K 移动光标，中间跟着走；键盘那条路一个字都没变。
               */
              <>
              <div className="grid h-full grid-cols-1 md:grid-cols-[18.75rem_minmax(0,1fr)] xl:grid-cols-[18.75rem_minmax(0,1fr)_16.75rem]">
                <div
                  role="listbox"
                  aria-label={t("review.queue")}
                  tabIndex={0}
                  className="min-w-0 overflow-auto border-r border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  {/* 队列表头常驻：走到第 60 条时，人还得知道自己在 75 条里的哪儿。 */}
                  <div className="sticky top-0 z-[2] flex items-center gap-2 border-b border-border bg-card px-3 py-1.5">
                    <span className="eyebrow">{t("review.queue")}</span>
                    <span className="mx-1 h-1 flex-1 overflow-hidden rounded-sm bg-accent">
                      <i
                        className="block h-full bg-primary"
                        style={{
                          width: `${visible.length ? ((visible.length - pending.length) / visible.length) * 100 : 0}%`,
                        }}
                      />
                    </span>
                    <span className="font-mono text-[0.6875rem] text-muted-foreground">
                      {visible.length - pending.length}/{visible.length}
                    </span>
                  </div>
                  {/*
                   * `role="option"` 挂在**已经有 `aria-selected` 的那个元素**上。
                   *
                   * 之前只有 `aria-selected`，外层没有 `role="listbox"`——一个孤零零的
                   * `aria-selected` 在无障碍树里是无效属性，屏幕阅读器读不出
                   * 「75 项中的第 1 项」。而这一屏的全部意义就是走完那 75 项：
                   * 不知道自己在第几条，等于不知道还剩多少。
                   */}
                  {visible.map((item, idx) => (
                    <div
                      key={item.caseId}
                      data-case={item.caseId}
                      role="option"
                      aria-selected={idx === cursor}
                      aria-posinset={idx + 1}
                      aria-setsize={visible.length}
                      onClick={() => setCursor(idx)}
                      className={cn(
                        "flex cursor-pointer items-start gap-2 border-b border-border px-3 py-2",
                        idx === cursor
                          ? "bg-primary-soft shadow-[inset_2px_0_0_hsl(var(--primary))]"
                          : "hover:bg-muted",
                        item.decision && "opacity-50",
                      )}
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5 flex-none"
                        disabled={!!item.decision && auditTab !== "calibrate"}
                        checked={selected.has(item.caseId)}
                        onChange={() => toggle(item.caseId)}
                        onClick={(e) => e.stopPropagation()}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-start gap-1.5">
                          <span className="flex-none pt-0.5 font-mono text-[0.6875rem] text-faint">
                            {item.caseId.slice(0, 6)}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-[0.8125rem] leading-snug text-foreground">
                            {item.title}
                          </span>
                        </span>
                        <span className="mt-0.5 flex flex-wrap items-center gap-1.5 font-mono text-[0.6875rem] text-muted-foreground">
                          {/* 校准 tab 下 `decision` 承载的是「标过没有」，它由徽标说得更准，
                              这里不再印一遍 approved/rejected。 */}
                          {item.decision && auditTab !== "calibrate" && <span>{item.decision}</span>}
                          <AuditBadges row={rowFor.get(item.caseId)} />
                          {(item.findings.length > 0 || (item.codeFindings?.length ?? 0) > 0) && (
                            <span className="rounded-sm bg-warn-soft px-1 text-warn">
                              {item.findings.length + (item.codeFindings?.length ?? 0)}
                            </span>
                          )}
                          {item.edit && <span className="text-primary">{t("review.edited")}</span>}
                        </span>
                      </span>
                    </div>
                  ))}
                  {visible.length === 0 && (
                    <div className="p-4 text-center text-[0.75rem] text-muted-foreground">
                      {t("review.noneShown")}
                    </div>
                  )}
                </div>

                <div className="min-w-0 overflow-auto p-3">
                  {visible[cursor] ? (
                    <>
                      {/* 先说要判断什么，再给这条用例。见 `AuditQuestion`。 */}
                      <AuditQuestion row={rowFor.get(visible[cursor]!.caseId)} />
                      <ItemCard item={visible[cursor]} idx={cursor} forceOpen />
                    </>
                  ) : (
                    <div className="p-4 text-[0.75rem] text-muted-foreground">{t("review.noneShown")}</div>
                  )}
                </div>

                <div className="hidden min-w-0 overflow-auto border-l border-border bg-muted xl:block">
                  <ReviewRail batch={batch} progress={railProgress} keyLabels={keyLabels} />
                </div>
              </div>
                <Drawer
                  open={railOpen}
                  onClose={() => setRailOpen(false)}
                  title={t("review.railOpen")}
                  widthClass="w-[19rem] max-w-[92vw]"
                >
                  <ReviewRail batch={batch} progress={railProgress} keyLabels={keyLabels} />
                </Drawer>
              </>
            ) : (
              /* 逐条列表。它是拿来读的，所以在**栏内**守着阅读列宽，
                 而不是把整屏都关进那根窄列里。 */
              <div className="h-full overflow-auto p-3">
                <div className="mx-auto max-w-4xl space-y-2">
                  {visible.map((item, idx) => (
                    <ItemCard key={item.caseId} item={item} idx={idx} />
                  ))}
                </div>
              </div>
            )}
          </div>
        </>
      )}

      {/*
        底部批量条。它**只在有选中时出现**——一条常驻的批量条，在没选任何东西的时候
        只是一排灰按钮，占着这一屏最值钱的下沿。
        原型里它是浮在内容上的一颗深色药丸，这里照做：浮起来意味着「这是对选中项的操作」，
        而不是这一屏的第四条工具栏。
      */}
      {batch && (selected.size > 0 || undoable) && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center pb-4">
          <div className="pointer-events-auto max-w-[min(1100px,calc(100%-2rem))] rounded-lg bg-foreground text-background shadow-panel">
            {bulkOpen && selected.size > 0 && (
              <div className="flex flex-wrap items-center gap-2 border-b border-background/20 px-3 py-2 text-[0.6875rem]">
                {/* 一次改动，作用在选中的那些上。查找替换排第一，因为这里反复出现的缺陷
                    就是生成的用例自己编了一个凭证，而修法是在每条里做同一个替换。 */}
                <input
                  className="w-32 rounded border border-background/25 bg-transparent px-2 py-[0.1875rem] font-mono text-[0.6875rem] placeholder:text-background/50"
                  placeholder={t("review.find")}
                  value={find}
                  onChange={(e) => setFind(e.target.value)}
                />
                <span className="text-background/60">→</span>
                <input
                  className="w-40 rounded border border-background/25 bg-transparent px-2 py-[0.1875rem] font-mono text-[0.6875rem] placeholder:text-background/50"
                  placeholder="${env.LOGIN_USER}"
                  value={replaceWith}
                  onChange={(e) => setReplaceWith(e.target.value)}
                />
                <TrayButton
                  disabled={!find || busy}
                  onClick={() => void batchOp({ kind: "replace", find, with: replaceWith })}
                >
                  <Replace className="h-3.5 w-3.5" />
                  {t("review.replace")}
                </TrayButton>
                <select
                  className="rounded border border-background/25 bg-transparent px-2 py-1 text-[0.6875rem]"
                  value=""
                  disabled={busy}
                  onChange={(e) =>
                    e.target.value && void batchOp({ kind: "priority", priority: e.target.value })
                  }
                >
                  <option value="">{t("review.priority")}</option>
                  {["P0", "P1", "P2"].map((p) => (
                    <option key={p} value={p} className="text-foreground">
                      {p}
                    </option>
                  ))}
                </select>
                <input
                  className="w-40 rounded border border-background/25 bg-transparent px-2 py-[0.1875rem] text-[0.6875rem] placeholder:text-background/50"
                  placeholder={t("review.addPrecondition")}
                  value={pre}
                  onChange={(e) => setPre(e.target.value)}
                />
                <TrayButton
                  disabled={!pre.trim() || busy}
                  onClick={() => void batchOp({ kind: "precondition", text: pre.trim() })}
                >
                  {t("review.apply")}
                </TrayButton>
                <TrayButton disabled={busy} onClick={() => void batchOp({ kind: "revert" })}>
                  <Undo2 className="h-3.5 w-3.5" />
                  {t("review.revert")}
                </TrayButton>
                <input
                  className="w-44 rounded border border-background/25 bg-transparent px-2 py-[0.1875rem] text-[0.6875rem] placeholder:text-background/50"
                  placeholder={t("review.notePlaceholder")}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
                <TrayButton
                  disabled={busy || regenerating > 0}
                  title={t("review.regenHint")}
                  onClick={() => void regenerate()}
                >
                  <Wand2 className="h-3.5 w-3.5" />
                  {regenerating > 0 ? `${t("review.regenerating")} ${regenerating}` : t("review.regenerate")}
                </TrayButton>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-[0.8125rem]">
              {selected.size > 0 ? (
                <>
                  <span>
                    {t("review.trayPicked")} <b className="font-mono">{selected.size}</b>
                  </span>
                  {/* 校准 tab 上这两颗做的是标注，不是批准/打回——名字必须跟着换，
                      且不再被「先选一个项目」拦住（标注不写进任何项目的看板）。 */}
                  <TrayButton
                    go
                    disabled={busy || (auditTab !== "calibrate" && !batch.projectId && !intoProject)}
                    title={
                      auditTab !== "calibrate" && !batch.projectId && !intoProject
                        ? t("review.needProjectWhy")
                        : undefined
                    }
                    onClick={() => void act("approve")}
                  >
                    <Check className="h-3.5 w-3.5" />
                    {auditTab === "calibrate" ? t("audit.covered") : t("review.approve")}
                  </TrayButton>
                  <TrayButton disabled={busy} onClick={() => void act("reject")}>
                    <X className="h-3.5 w-3.5" />
                    {auditTab === "calibrate" ? t("audit.notCovered") : t("review.reject")}
                  </TrayButton>
                  <TrayButton onClick={() => setBulkOpen((v) => !v)}>
                    {t("review.trayMore")} {bulkOpen ? "▾" : "▸"}
                  </TrayButton>
                  <TrayButton onClick={() => setSelected(new Set())}>{t("review.trayClear")}</TrayButton>
                </>
              ) : null}
              {/* 刚才那一下改了 N 条——一个能直接按的后路。
                  它说清自己会做什么：回到 harness 产出的原样，不是「回到上一步」。 */}
              {undoable && (
                <TrayButton
                  disabled={busy}
                  title={t("review.undoWhy")}
                  onClick={async () => {
                    const ids = undoable.ids;
                    setUndoable(null);
                    await batchOp({ kind: "revert" }, ids);
                  }}
                >
                  <Undo2 className="h-3.5 w-3.5" />
                  {t("review.undoLast", { what: undoable.what, n: undoable.ids.length })}
                </TrayButton>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );

  /**
   * 挂在**这一条**上的 composer：问 / 改。
   *
   * 不是一条常驻的聊天列。作用域是它存在的全部意义——一条常驻列必须先解释
   * 「你现在问的是哪一条」，而一个挂在条目上的输入框，那句解释就是它所在的位置。
   *
   * 两个模式**去处不同**，所以要在界面上说得出来：
   * - 问：只读。答的是这一条，手里有它的步骤、判据和它身上那几条 finding。
   * - 改：写。走的是复核那条既有的重写路径（`/regenerate`），改出来的东西
   *   会作为一份**编辑草稿**摆在 diff 里等人保存，不会直接落地。
   */
  function Composer({ item }: { item: ReviewItem }) {
    const [mode, setMode] = useState<"ask" | "edit">("ask");
    const [text, setText] = useState("");
    const [answer, setAnswer] = useState("");
    const [working, setWorking] = useState(false);

    const send = async () => {
      const q = text.trim();
      if (!q || !batch) return;
      setWorking(true);
      setAnswer("");
      try {
        if (mode === "edit") {
          // 改：走复核那条既有的重写路径，只作用于这一条。
          await post("/regenerate", { caseIds: [item.caseId], note: q });
          setAnswer(t("review.composerEdited"));
          setText("");
        } else {
          const res = await fetch(`${API}/api/chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              messages: [{ role: "user", text: q }],
              intent: "ask",
              // 作用域跟着条目走：服务端据此把这一条的步骤、判据和 finding 装进去。
              context: { kind: "case", caseId: item.caseId, wfRunId: batch.wfRunId },
            }),
          });
          const body = (await res.json()) as { reply?: string; error?: string };
          setAnswer(body.error ?? body.reply ?? "");
        }
      } catch (e) {
        setAnswer((e as Error).message);
      } finally {
        setWorking(false);
      }
    };

    return (
      <div className="rounded-lg bg-muted/40 p-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {(["ask", "edit"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={cn(
                "inline-flex min-h-[1.3125rem] items-center rounded px-[0.4375rem] py-[0.125rem] text-[0.6875rem]",
                mode === m ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
              )}
            >
              {t(m === "ask" ? "review.composerAsk" : "review.composerEdit")}
            </button>
          ))}
          {/* 作用域写出来。「问的是这一条 / 改的是这一条」不该靠人从界面位置猜。 */}
          <span className="text-[0.6875rem] text-muted-foreground">
            {t(mode === "ask" ? "review.composerAskScope" : "review.composerEditScope", {
              title: item.title,
            })}
          </span>
        </div>
        <div className="mt-1.5 flex items-center gap-1.5">
          <input
            className="min-w-0 flex-1 rounded border border-border bg-card px-2 py-[0.1875rem] text-[0.75rem]"
            placeholder={t(mode === "ask" ? "review.composerAskHint" : "review.composerEditHint")}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              // 这一页 J/K/1/3 都是快捷键，输入框里得把它们挡住。
              e.stopPropagation();
              if (e.key === "Enter") void send();
            }}
          />
          <Button disabled={working || !text.trim()} onClick={() => void send()}>
            {working ? t("review.composerWorking") : t("review.composerSend")}
          </Button>
        </div>
        {answer && (
          <p className="mt-1.5 whitespace-pre-wrap text-[0.75rem] leading-relaxed text-foreground">{answer}</p>
        )}
      </div>
    );
  }

  /**
   * 一条用例的卡片。列表与「队列+详情」共用同一个——两处各写一遍，
   * 迟早只在一处修 bug，而复核正是最不该出现两种行为的地方。
   *
   * `forceOpen`：详情栏里它永远是展开的。在一个已经点开的东西上再放一个折叠箭头，
   * 是让人多点一次。
   */
  function ItemCard({ item, idx, forceOpen }: { item: ReviewItem; idx: number; forceOpen?: boolean }) {
    const expanded = forceOpen || open.has(item.caseId);
    const blocked = item.codeBlocked;
    // 键盘光标落在哪一条。看不见的光标等于没有光标。
    const atCursor = idx === cursor;
    return (
      <div
        key={item.caseId}
        id={`case-${item.caseId}`}
        data-case={item.caseId}
        className={cn(
          "rounded-xl border bg-card p-3",
          atCursor && "ring-2 ring-primary/45",
          item.decision === "approved"
            ? "border-ok opacity-70"
            : item.decision === "rejected"
              ? "border-border opacity-50"
              : blocked
                ? "border-bad"
                : "border-border",
        )}
      >
        <div className="flex items-start gap-2">
          <input
            type="checkbox"
            className="mt-1"
            disabled={!!item.decision && auditTab !== "calibrate"}
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
              {/*
                **这一屏最大的字，是人正在判断的那条用例。**
                此前整屏字号只有 11–14px 四档（检测器测出比例 1.3:1），
                没有一个大字——于是「我在读哪一条」和「这一行是什么标签」
                在视觉上是同一个重量级。它现在比正文大一档，也就够了：
                再大会挤掉密度，而密度是这一屏的前提。
              */}
              <span className="font-display text-[1.0625rem] font-medium leading-snug text-foreground">
                {item.title}
              </span>
            </div>
            <div className="ml-5 mt-1">
              <CaseMeta kase={{ ...item, priority: item.edit?.priority }} />
            </div>
            {(item.edit || item.decision) && (
              <div className="ml-5 mt-1 flex flex-wrap gap-x-3 text-[0.6875rem]">
                {item.edit && (
                  <span className="text-primary">
                    {item.edit.by === "model" ? t("review.byModel") : t("review.edited")}
                  </span>
                )}
                {item.decision && <span className="text-muted-foreground">{item.decision}</span>}
              </div>
            )}
            {!expanded && (
              <div className="ml-5 mt-1 line-clamp-2 text-[0.75rem] text-muted-foreground">
                → {item.expected}
              </div>
            )}
          </button>
        </div>

        {(item.findings.length > 0 || (item.codeFindings?.length ?? 0) > 0) && (
          <div className="ml-7 mt-2">
            <Findings
              findings={[...item.findings, ...(item.codeFindings ?? [])]}
              onFocusField={(f) => focusField(item.caseId, f)}
            />
          </div>
        )}

        {expanded && (
          <div className="ml-7 mt-2 space-y-2">
            {/*
                            四要素先摆出来，再给编辑框。
                            此前这里直接是编辑框——于是复核者能改的三格就是他能看到的全部，
                            前置条件和机器判据（判决真正的依据）在界面上根本不存在。
                          */}
            <div className="rounded-lg bg-muted/40 p-2.5">
              <CaseBody kase={item} onOpenTransition={openTransition} />
            </div>
            <EditDiff item={item} />
            {/* composer 挂在这一条上。不是一条常驻列——作用域是它存在的全部意义。 */}
            {!item.decision && <Composer item={item} />}
            {item.editedFindings &&
              (item.editedFindings.length === 0 ? (
                <div className="text-[0.6875rem] text-ok">{t("review.noFindingsNow")}</div>
              ) : (
                <Findings
                  findings={item.editedFindings}
                  prefix={t("review.stillFlagged")}
                  onFocusField={(f) => focusField(item.caseId, f)}
                />
              ))}
            {/* 校准 tab 上「标过了」不等于「定案了」——一份样本本来就会被回头修正，
                所以标过的那几条仍然给编辑与再标一次的入口。 */}
            {item.decision && auditTab !== "calibrate" ? (
              <ol className="list-decimal space-y-0.5 pl-4 text-[0.75rem] text-foreground">
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
                onApprove={() => void act("approve", [item.caseId])}
                onReject={() => void act("reject", [item.caseId])}
                approveLabel={auditTab === "calibrate" ? t("audit.covered") : undefined}
                rejectLabel={auditTab === "calibrate" ? t("audit.notCovered") : undefined}
                /*
                 * 「批准要先选项目」在校准 tab 上不成立——标注不写进任何项目的看板，
                 * 它写进 `human-labels.json`。让它继续拦着，等于用一个不相干的前提
                 * 挡住这一屏唯一能做的事。
                 * `block` 级的 Scanner 判定同理要写出原因，而不是只把按钮灰掉。
                 */
                approveWhy={
                  auditTab === "calibrate"
                    ? ""
                    : worstSeverity(rowFor.get(item.caseId)) === "block"
                      ? t("audit.blockedWhy")
                      : batch && !batch.projectId && !intoProject
                        ? t("review.needProjectWhy")
                        : ""
                }
              />
            )}
            {item.code && (
              <pre className="overflow-auto rounded-lg bg-muted p-2 font-mono text-[0.6875rem] text-muted-foreground">
                {item.code}
              </pre>
            )}
          </div>
        )}
      </div>
    );
  }
}
