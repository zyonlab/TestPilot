import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * 产物卡里的一段：左边一个窄标签，右边内容。
 *
 * 为什么值得单独成一个组件：这一轮要补的字段（前置条件、机器判据、覆盖的转移）此前
 * 之所以没画，很大一部分原因是「没有现成的地方放」——每加一个字段都要现想一次版式，
 * 于是最省事的做法就是不加。有了这一格，加字段变成一行调用。
 */
export function Field({
  label,
  children,
  empty,
  tone = "normal",
  id,
}: {
  label: string;
  children?: ReactNode;
  /** 没内容时说的那句话。**必须给**——留白等于宣称这个字段不存在。 */
  empty?: string;
  tone?: "normal" | "muted" | "warn";
  id?: string;
}) {
  const has = children !== undefined && children !== null && children !== false;
  return (
    <div className="flex gap-2.5" id={id}>
      <span className="w-14 shrink-0 pt-px text-right font-mono text-[10.5px] leading-[1.7] text-muted-foreground">
        {label}
      </span>
      <div
        className={cn(
          "min-w-0 flex-1 text-[12.5px] leading-[1.7]",
          !has || tone === "muted"
            ? "text-muted-foreground"
            : tone === "warn"
              ? "text-amber-600 dark:text-amber-400"
              : "text-foreground",
        )}
      >
        {has ? children : empty}
      </div>
    </div>
  );
}

/** 一枚小标签。产物卡的元信息全用它，颜色只在「需要注意」时才出现。 */
export function Chip({
  children,
  tone = "plain",
  title,
  onClick,
}: {
  children: ReactNode;
  tone?: "plain" | "good" | "warn" | "bad" | "accent";
  title?: string;
  onClick?: () => void;
}) {
  const cls =
    tone === "good"
      ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
      : tone === "warn"
        ? "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300"
        : tone === "bad"
          ? "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300"
          : tone === "accent"
            ? "bg-primary/10 text-primary"
            : "bg-muted text-muted-foreground";
  const Tag = onClick ? "button" : "span";
  return (
    <Tag
      title={title}
      onClick={onClick}
      className={cn(
        "rounded px-1.5 py-px font-mono text-[10.5px] leading-[1.6]",
        cls,
        onClick && "hover:brightness-95",
      )}
    >
      {children}
    </Tag>
  );
}
