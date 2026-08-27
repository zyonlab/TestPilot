import { useState } from "react";
import { CircleDollarSign } from "lucide-react";
import { Drawer } from "@/components/overlay";
import { Button } from "@/components/ui";
import { useT } from "@/lib/prefs";
import { useWf } from "@/lib/wf";

/**
 * 一次运行停在它的上限上时，能做的那一件事。
 *
 * 上限是硬的：撞上了就停，而且**续跑不会顺手把它撤掉**。此前两件事都不成立——续跑既没
 * 带上限也没带已花费，于是设了上限的运行一被续上就变成不限额的，而且这次运行最后记下来
 * 的花费比它真的花的少。看起来在管着，实际上没有。
 *
 * 所以要继续，得先明确地改上限或撤掉它。这是一个人做的决定，不该由「点了继续」完成——
 * 让「继续」同时具备提高上限的作用，等于让上限在最容易被忽略的那一刻失效。
 */
export function BudgetDrawer({ onClose }: { onClose: () => void }) {
  const t = useT();
  const { runtime, stoppedBy, setBudget, resume } = useWf();
  const [calls, setCalls] = useState(runtime.budget.calls?.toString() ?? "");
  const [usd, setUsd] = useState(runtime.budget.usd?.toString() ?? "");
  const [min, setMin] = useState(
    runtime.budget.ms !== undefined ? String(Math.round(runtime.budget.ms / 60000)) : "",
  );
  const [busy, setBusy] = useState(false);

  const num = (v: string): number | undefined => {
    const n = Number(v.trim());
    return v.trim() && Number.isFinite(n) && n > 0 ? n : undefined;
  };

  const apply = async (clear: boolean) => {
    setBusy(true);
    try {
      await setBudget(
        clear ? null : { calls: num(calls), usd: num(usd), ms: num(min) ? num(min)! * 60000 : undefined },
      );
      await resume();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const spent = runtime.spend;
  const row = (label: string, value: string, hit: boolean) => (
    <div className="flex items-baseline gap-2 text-[12.5px]">
      <span className="w-20 shrink-0 text-muted-foreground">{label}</span>
      <span className={hit ? "font-medium text-amber-600 dark:text-amber-400" : "text-foreground"}>
        {value}
      </span>
      {hit && <span className="text-[11px] text-amber-600 dark:text-amber-400">{t("wf.capHit")}</span>}
    </div>
  );

  return (
    <Drawer
      open
      onClose={onClose}
      resizeKey="budget"
      defaultWidth={460}
      title={
        <span className="flex items-center gap-1.5">
          <CircleDollarSign className="h-4 w-4 text-amber-500" />
          {t("wf.capTitle")}
        </span>
      }
    >
      <div className="min-h-0 flex-1 overflow-auto p-4">
        <p className="text-[12.5px] leading-relaxed text-muted-foreground">{t("wf.capWhy")}</p>

        <div className="mt-3 space-y-1 rounded-lg bg-muted p-3">
          {row(
            t("wf.rtCalls"),
            `${spent.calls}${runtime.budget.calls !== undefined ? ` / ${runtime.budget.calls}` : ""}`,
            stoppedBy === "calls",
          )}
          {row(
            "usd",
            `${spent.usd.toFixed(2)}${runtime.budget.usd !== undefined ? ` / ${runtime.budget.usd}` : ""}`,
            stoppedBy === "usd",
          )}
          {row(
            t("wf.rtTime"),
            `${Math.round(spent.ms / 60000)}${runtime.budget.ms !== undefined ? ` / ${Math.round(runtime.budget.ms / 60000)}` : ""} min`,
            stoppedBy === "ms",
          )}
        </div>
        {/* 已经跑出来的产物还在：续跑是接着往下走，不是从头再来。 */}
        <p className="mt-2 text-[11.5px] leading-relaxed text-muted-foreground">{t("wf.capKept")}</p>

        <div className="mt-4 space-y-2">
          {[
            { label: t("wf.rtCalls"), value: calls, set: setCalls, unit: "" },
            { label: "usd", value: usd, set: setUsd, unit: "$" },
            { label: t("wf.rtTime"), value: min, set: setMin, unit: "min" },
          ].map((f) => (
            <label key={f.label} className="flex items-center gap-2 text-[12.5px]">
              <span className="w-20 shrink-0 text-muted-foreground">{f.label}</span>
              <input
                className="w-32 rounded-md border border-border bg-background px-2 py-1 font-mono text-[12px]"
                value={f.value}
                inputMode="numeric"
                placeholder={t("wf.capNone")}
                onChange={(e) => f.set(e.target.value)}
              />
              <span className="text-[11px] text-muted-foreground">{f.unit}</span>
            </label>
          ))}
          <p className="text-[11px] text-muted-foreground">{t("wf.capBlank")}</p>
        </div>
      </div>

      <div className="flex items-center gap-2 border-t border-border p-3">
        <Button variant="primary" disabled={busy} onClick={() => void apply(false)}>
          {t("wf.capApply")}
        </Button>
        {/* 撤掉上限是一个正当的选择，但它要被说成「撤掉」，不能伪装成「继续」。 */}
        <Button disabled={busy} onClick={() => void apply(true)} title={t("wf.capClearWhy")}>
          {t("wf.capClear")}
        </Button>
      </div>
    </Drawer>
  );
}
