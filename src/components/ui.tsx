import { useState } from "react";
import { CircleCheck, CircleX, Loader2, Minus, Code2, CodeXml } from "lucide-react";
import type { CaseType, FlakeVerdict, Priority, RunStatus } from "@/lib/types";
import { useT } from "@/lib/prefs";
import { cn } from "@/lib/cn";

const STABILITY_BADGE: Record<FlakeVerdict, string> = {
  stable: "bg-ok-soft text-ok",
  flaky: "bg-warn-soft text-warn",
  broken: "bg-bad-soft text-bad",
  unknown: "bg-muted text-muted-foreground",
};

export function StabilityChip({
  verdict,
  failRate,
  className,
}: {
  verdict: FlakeVerdict;
  failRate: number;
  className?: string;
}) {
  const passPct = Math.round((1 - failRate) * 100);
  return (
    <span className={cn("rounded-md px-2 py-0.5 text-xs font-medium", STABILITY_BADGE[verdict], className)}>
      {verdict} · {passPct}%
    </span>
  );
}

export const PRIORITY_BADGE: Record<Priority, string> = {
  P0: "bg-bad-soft text-bad",
  P1: "bg-warn-soft text-warn",
  P2: "bg-muted text-muted-foreground",
};

export const TYPE_BADGE: Record<CaseType, string> = {
  functional: "bg-accent text-ink2",
  negative: "bg-warn-soft text-warn",
  boundary: "bg-chat-soft text-chat",
  e2e: "bg-primary-soft text-primary",
};

export function TypeBadge({ type, className }: { type: CaseType; className?: string }) {
  return (
    <span className={cn("rounded-md px-2 py-0.5 text-xs font-medium", TYPE_BADGE[type], className)}>
      {type}
    </span>
  );
}

export function PriorityBadge({ priority, className }: { priority: Priority; className?: string }) {
  return (
    <span className={cn("rounded-md px-2 py-0.5 text-xs font-medium", PRIORITY_BADGE[priority], className)}>
      {priority}
    </span>
  );
}

export function RunStatusPill({ status }: { status: RunStatus }) {
  const t = useT();
  if (status === "running")
    return (
      <span className="flex items-center gap-1 text-xs text-primary">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t("status.running")}
      </span>
    );
  if (status === "passed")
    return (
      <span className="flex items-center gap-1 text-xs text-ok">
        <CircleCheck className="h-3.5 w-3.5" /> {t("status.passed")}
      </span>
    );
  if (status === "failed")
    return (
      <span className="flex items-center gap-1 text-xs text-bad">
        <CircleX className="h-3.5 w-3.5" /> {t("status.failed")}
      </span>
    );
  return (
    <span className="flex items-center gap-1 text-xs text-muted-foreground">
      <Minus className="h-3.5 w-3.5" /> {t("status.notRun")}
    </span>
  );
}

export function CodeIndicator({ hasCode }: { hasCode: boolean }) {
  const t = useT();
  return hasCode ? (
    <span className="flex items-center gap-1 text-xs text-muted-foreground">
      <Code2 className="h-3.5 w-3.5 text-ok" /> {t("status.code")}
    </span>
  ) : (
    <span className="flex items-center gap-1 text-xs text-muted-foreground">
      <CodeXml className="h-3.5 w-3.5 opacity-50" /> {t("status.noCode")}
    </span>
  );
}

/**
 * 一颗按钮。尺寸照原型 v3 的 `.btn`：**0.8125rem 字、0.1875/0.625rem 内边距**，
 * 默认根字号下算上边框约 25px 高——和原型一模一样。
 *
 * 尺寸曾经全部写成 px，为的是别和那近七百处写死 px 的字号劈叉。那批 px 现在
 * 已经全部换成 rem，`index.css` 里钉死根字号的那一行也拆了，所以这里跟着回到 rem：
 * **按钮的高度应该跟着它里面的字长**，而字应该跟着人在浏览器里设的字号长。
 *
 * `sm` 是原型的 `.btn.sm`，给挤在行内、和正文并排的那些动作用。
 */
export function Button({
  children,
  variant = "outline",
  size = "md",
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "outline" | "primary" | "success";
  size?: "md" | "sm";
}) {
  // A disabled button drops its fill rather than merely fading: a half-transparent blue
  // still reads as"the thing to press", both to a person glancing at it and — as the
  // self-test demonstrated — to a model looking at a screenshot of it.
  /*
   * `focus-visible` 是这一行里唯一后加的东西，而它以前**一个都没有**。
   *
   * 后果不是「不好看」：Tab 走到主按钮上时，人看不出自己停在哪儿。而全仓
   * `focus-visible` 只出现在三个文件里，其中一个还是没被 import 的死代码，
   * 另有 39 处 `outline-none` 压根没配替代样式——同一个产品三种焦点表现，
   * 其中一种是「没有」。`03 §9.6` 把「键盘可达、focus 可见」列为全局约定。
   *
   * 用 `focus-visible` 而不是 `focus`：鼠标点一下不该留下一圈光环，
   * 那会让每一次点击都像是出了什么事。
   */
  const base =
    "inline-flex cursor-pointer items-center justify-center gap-1.5 rounded leading-[1.35] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:border disabled:border-border disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100 disabled:hover:bg-muted";
  /* `min-h` 而不是 `h`：单行标签正好落在 25 / 21，多行的仍然长得开而不是被裁掉。
     同一行里的下拉、输入框、tab 用的是同一组数，所以它们高度对得齐。 */
  const sizes = {
    md: "min-h-[1.5625rem] px-[0.625rem] py-[0.1875rem] text-[0.8125rem]",
    sm: "min-h-[1.3125rem] px-[0.4375rem] py-[0.125rem] text-[0.75rem]",
  };
  const variants = {
    outline: "border border-input hover:border-primary hover:bg-muted hover:text-primary",
    primary: "border border-primary bg-primary text-primary-foreground hover:opacity-90",
    success: "border border-ok bg-ok text-primary-foreground hover:brightness-110",
  };
  return (
    <button className={cn(base, sizes[size], variants[variant], className)} {...props}>
      {children}
    </button>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
 * 下面三个原语补的是同一个缺口。
 *
 * 在它们之前，`ui.tsx` 只有 141 行 6 个原语（三个徽标 + 状态片 + 代码标 + Button），
 * 没有 Input、没有 Select、没有 EmptyState、没有 ErrorCard。缺口不是漏了五个组件，
 * 是**同一处结构缺失漏出来的五处水**：
 *
 *   一致性  手写 `<button>` 111 次 vs `<Button>` 108 次；裸表单控件逾百处，
 *           统一只能靠 `index.css` 里三条**元素选择器**兜底——用全局样式表
 *           替代组件，改一次控件外观要动整个 app。
 *   可访问性 焦点样式无处可挂，于是三种表现并存，其中一种是没有。
 *   规格    `03 §9.3` 的空态引导长成四套写法；`§9.4` 的统一错误卡根本不存在，
 *           兜底是 `?? "记不下来"` / `?? "改不了"` / `?? "补不出来"` / `?? "造不出来"`
 *           四句硬编码中文——既没有 code，也没有重试。
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * 空态。**说清三件事：这里为什么空、空不等于坏、下一步点哪儿。**
 *
 * 这个产品实机上 11 个导航项里 6 个是空的、4 个 tab 是空的，所以空态不是边角料，
 * 是大多数人第一次看到的那一屏。写得最好的那几处（Trace 的「这里的零意思是
 * 还没人批准过，不是坏了」、Delivery 的「最近一次运行有 75 条待复核 [→]」）
 * 已经证明了该长什么样；这里把那个形状固定下来，而不是让每一屏各写一遍。
 */
export function EmptyState({
  title,
  body,
  actions,
  className,
}: {
  title: string;
  /** 为什么空。**不要写「暂无数据」**——写清楚零和坏的区别。 */
  body: string;
  /** 下一步。没有可点的下一步时才留空，而那种情况很少。 */
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-start gap-3 rounded-xl border border-dashed border-border bg-card/50 p-5",
        className,
      )}
    >
      <h2 className="text-[0.875rem] font-medium">{title}</h2>
      <p className="max-w-[60ch] text-[0.8125rem] leading-relaxed text-muted-foreground">{body}</p>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

/**
 * 统一错误卡：**code + 可读原因 + 重试**，`03 §9.4` 的原话。
 *
 * 三样缺一不可，理由各不相同：
 * - **code** 是人能拿去搜、能贴进 issue 的那一截。没有它，「改不了」是一句死路。
 * - **可读原因** 用服务端说的话，而不是前端编一句兜底——编出来的那四句中文
 *   （「记不下来」「改不了」「补不出来」「造不出来」）在英文界面上还会直接漏出来。
 * - **重试** 因为这个产品里大部分错误是本地模型或子进程的一次抖动，
 *   而不给重试按钮的后果是人去刷新整页，把手上的筛选和光标一起丢掉。
 */
export function ErrorCard({
  code,
  reason,
  onRetry,
  className,
}: {
  /** HTTP 状态、错误码，或触发它的那个动作名。 */
  code?: string;
  reason: string;
  onRetry?: () => void;
  className?: string;
}) {
  const t = useT();
  return (
    <div
      role="alert"
      className={cn("rounded-lg border border-bad/40 bg-bad-soft px-3 py-2", className)}
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        {code && <code className="font-mono text-[0.6875rem] text-bad/80">{code}</code>}
        <span className="min-w-0 flex-1 text-[0.8125rem] text-bad">{reason}</span>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="flex-none rounded border border-bad/40 px-1.5 py-px font-mono text-[0.6875rem] text-bad transition-colors hover:bg-bad/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t("common.retry")}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * 表单控件的共享外观。
 *
 * 盒子的**下限**仍然由 `index.css` 的元素选择器兜底——那一层保的是「页面里手写的
 * 裸控件也不会比旁边的按钮矮一截」。这里加的是元素选择器加不了的两样：
 * **焦点环**，和一个真正能被 `<label htmlFor>` 指到的 id。
 */
const CONTROL =
  "w-full rounded border border-input bg-card px-[0.5rem] py-[0.1875rem] text-[0.8125rem] leading-[1.35] " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground";

export const Input = ({ className, ...p }: React.InputHTMLAttributes<HTMLInputElement>) => (
  <input className={cn(CONTROL, className)} {...p} />
);
export const Textarea = ({ className, ...p }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => (
  <textarea className={cn(CONTROL, "resize-y", className)} {...p} />
);
export const Select = ({ className, ...p }: React.SelectHTMLAttributes<HTMLSelectElement>) => (
  <select className={cn(CONTROL, className)} {...p} />
);

/**
 * 一个带标签的控件。
 *
 * 存在的理由是数出来的：全仓 115 个表单控件，只有 18 个有 `<label htmlFor>`——
 * 15.7%。其余的靠占位符说明自己是什么，而占位符在人开始输入的那一刻就消失了，
 * 屏幕阅读器也读不出「这个框是干什么的」。
 *
 * `htmlFor` 与 `id` 在这里自动配对，调用处不需要各自编一个不重名的 id。
 */
let fieldSeq = 0;
export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: string;
  /** 接收自动生成的 id，挂到真正的控件上。 */
  children: (id: string) => React.ReactNode;
  className?: string;
}) {
  const [id] = useState(() => `f${++fieldSeq}`);
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <label htmlFor={id} className="text-[0.6875rem] font-medium text-muted-foreground">
        {label}
      </label>
      {children(id)}
      {hint && <p className="text-[0.6875rem] text-faint">{hint}</p>}
    </div>
  );
}
