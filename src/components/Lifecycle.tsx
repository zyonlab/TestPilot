import { CheckCircle2, Circle } from "lucide-react";
import { useT } from "@/lib/prefs";
import type { ReactNode } from "react";
export function Lifecycle({steps}: {steps: Array<{title:string; done:boolean; detail?:ReactNode}>}) {
  const t = useT();
  return <section aria-label={t("life.title")} className="border-b border-border pb-5">
    <h2 className="mb-4 text-base font-semibold">{t("life.title")}</h2>
    <ol className="grid gap-x-6 gap-y-5 md:grid-cols-2 xl:grid-cols-4">
      {steps.map(step => <li key={step.title} className="min-w-0">
        <div className="flex items-start gap-2">{step.done ? <CheckCircle2 aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-ok"/> : <Circle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"/>}
          <div><h3 className="text-sm font-medium">{step.title}</h3><p className="mt-1 text-xs text-muted-foreground">{t(step.done ? "life.done" : "life.pending")}</p></div></div>
        {step.detail && <div className="mt-2 text-sm leading-6 text-muted-foreground">{step.detail}</div>}
      </li>)}
    </ol>
  </section>;
}
