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
      <span className="w-14 shrink-0 pt-px text-right font-mono text-[0.6875rem] leading-[1.7] text-muted-foreground">
        {label}
      </span>
      <div
        className={cn(
          "min-w-0 flex-1 text-[0.8125rem] leading-[1.7]",
          !has || tone === "muted"
            ? "text-muted-foreground"
            : tone === "warn"
              ? "text-warn"
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
      ? "bg-ok-soft text-ok"
      : tone === "warn"
        ? "bg-warn-soft text-warn"
        : tone === "bad"
          ? "bg-bad-soft text-bad"
          : tone === "accent"
            ? "bg-primary/10 text-primary"
            : "bg-muted text-muted-foreground";
  const Tag = onClick ? "button" : "span";
  return (
    <Tag
      title={title}
      onClick={onClick}
      className={cn(
        "rounded px-1.5 py-px font-mono text-[0.6875rem] leading-[1.6]",
        cls,
        onClick && "hover:brightness-95",
      )}
    >
      {children}
    </Tag>
  );
}
