import { useT } from "@/lib/prefs";
import { cn } from "@/lib/cn";
import type { Artifact, NodeRun, RunContext, Runtime } from "@/lib/wf";

/**
 * 右栏，三节，固定顺序：**进度 / 产物 / 这次它看得到什么**。
 *
 * 三节的分工是「机器在做什么 / 它做出了什么 / 它是在什么前提下做的」。
 * 第三节看起来最不起眼，却是两个月后回头看这次运行时唯一能回答
 * 「它当时打的是哪里、读的什么、用哪一版图」的东西——而这些数据服务端一直记着，
 * 前端此前一项都没读。
 *
 * 为什么是常驻右栏而不是抽屉：这三样是**读任何一件产物时都要对着看的**背景。
 * 装进抽屉，人每判断一条就要开关一次；而抽屉一开就盖住了它要解释的那个东西。
 */
export function RunRail({
  runtime,
  nodeRuns,
  order,
  produced = [],
  artifacts,
  context,
  onOpen,
}: {
  runtime: Runtime;
  nodeRuns: Record<string, NodeRun>;
  /** 图上的节点顺序。进度要按流水线的顺序排，不是按 Object.keys 的顺序。 */
  order: string[];
  /**
   * 这次运行已经产出过哪几个节点。
   *
   * **产物是事实，`nodeRuns` 是汇报。** 一次跑了三步才被打断的运行，
   * 它的步骤记录里一条都没有（`wf.run.finished` 根本没机会发出去），
   * 而三份产物就落在库里。只看汇报，进度会说「2/5」，
   * 而那五步里实际上有四步是有东西的——这跟服务端 `completedNodes` 是同一条判断。
   */
  produced?: string[];
  artifacts: Artifact[];
  context: RunContext;
  onOpen?: (surface: string) => void;
}) {
  const t = useT();
  const has = new Set(produced);
  /** 汇报说 done，或者它确实产出过东西——两者取其一。 */
  const isDone = (id: string): boolean => nodeRuns[id]?.state === "done" || has.has(id);
  const done = order.filter(isDone).length;
  /** 这次运行给了哪些上限、各用掉多少。没给的那些一格都不画。 */
  const caps: Array<{ key: string; label: string; used: number; cap: number }> = [
    { key: "calls", label: t("rail.capCalls"), used: runtime.spend.calls, cap: runtime.budget.calls ?? 0 },
    {
      key: "usd",
      label: t("rail.capUsd"),
      used: Math.round(runtime.spend.usd * 100) / 100,
      cap: runtime.budget.usd ?? 0,
    },
    {
      key: "ms",
      label: t("rail.capMs"),
      used: Math.round(runtime.spend.ms / 1000),
      cap: runtime.budget.ms ? Math.round(runtime.budget.ms / 1000) : 0,
    },
  ].filter((c) => c.cap > 0);

  const secs = (ms?: number) => (ms ? `${Math.round(ms / 1000)}s` : "");
  const k = (n?: number) => (n ? `${(n / 1000).toFixed(1)}k` : "");

  return (
    <aside className="flex w-[16.75rem] flex-none flex-col overflow-y-auto border-l border-border bg-card">
      <Section title={t("rail.progress")} count={order.length ? `${done}/${order.length}` : ""}>
        {order.length === 0 && <Empty>{t("rail.noRun")}</Empty>}
        {order.map((id) => {
          const n = nodeRuns[id];
          const st = n?.state ?? (has.has(id) ? "done" : "idle");
          return (
            <div key={id} className="flex items-baseline gap-2 py-[0.1875rem] text-[0.75rem]">
              <span
                className={cn(
                  "h-1.5 w-1.5 flex-none rounded-full",
                  st === "done"
                    ? "bg-ok"
                    : st === "running"
                      ? "animate-pulse bg-warn"
                      : st === "failed"
                        ? "bg-bad"
                        : st === "paused"
                          ? "bg-chat"
                          : "bg-muted-foreground/30",
                )}
              />
              <span
                className={cn(
                  "min-w-0 flex-1 truncate font-mono",
                  st === "idle" && "text-muted-foreground/60",
                )}
              >
                {id}
              </span>
              {/* 耗时与 token 分开给：最慢的一步和最贵的一步常常不是同一步。 */}
              <span className="flex-none font-mono text-[0.6875rem] tabular-nums text-muted-foreground">
                {[secs(n?.ms), k(n?.tokens)].filter(Boolean).join(" · ")}
              </span>
            </div>
          );
        })}

        {/* 上限用掉多少，一条进度条。只在真的给了上限时才画——
            没有上限却画一条空槽，是在暗示存在一个不存在的分母。 */}
        {caps.map(({ key, label, used, cap }) => (
          <div key={key} className="mt-1.5">
            <div className="flex items-baseline justify-between text-[0.6875rem] text-muted-foreground">
              <span>{label}</span>
              <span className="font-mono tabular-nums">
                {used}/{cap}
              </span>
            </div>
            <div className="mt-0.5 h-1 w-full overflow-hidden rounded bg-muted">
              <div
                className={cn(
                  "h-full rounded",
                  used >= cap ? "bg-bad" : used / cap > 0.8 ? "bg-warn" : "bg-ok",
                )}
                style={{ width: `${Math.min(100, Math.round((used / cap) * 100))}%` }}
              />
            </div>
          </div>
        ))}
      </Section>

      <Section title={t("rail.artifacts")} count={artifacts.length ? String(artifacts.length) : ""}>
        {artifacts.length === 0 && <Empty>{t("rail.noArtifacts")}</Empty>}
        {artifacts.map((a) => (
          <button
            key={a.id}
            type="button"
            disabled={!a.opens || !onOpen}
            onClick={() => a.opens && onOpen?.(a.opens.surface)}
            className={cn(
              "flex w-full items-baseline gap-2 rounded px-1 py-[0.1875rem] text-left text-[0.75rem]",
              a.opens && onOpen ? "hover:bg-accent" : "cursor-default",
            )}
          >
            <span className="min-w-0 flex-1 truncate">{a.title}</span>
            <span
              className={cn(
                "flex-none font-mono text-[0.6875rem] tabular-nums",
                a.tone === "warn" ? "text-warn" : "text-foreground",
              )}
            >
              {a.value}
            </span>
          </button>
        ))}
      </Section>

      <Section title={t("rail.context")}>
        {!context.describe && !context.baseUrl && <Empty>{t("rail.noRun")}</Empty>}
        <Row label={t("rail.target")} value={context.describe} />
        <Row label={t("rail.baseUrl")} value={context.baseUrl} mono />
        {/* 地址从哪儿来的、环境是不是人选的——事后有人改了默认环境，
            只有这两栏能说清这次运行当时打的到底是什么。 */}
        {context.urlFrom && <Row label={t("rail.urlFrom")} value={t(`rail.urlFrom.${context.urlFrom}`)} />}
        {context.envPick && (
          <Row
            label={t("rail.envPick")}
            value={t(`rail.envPick.${context.envPick}`)}
            tone={context.envPick === "default" ? "muted" : undefined}
          />
        )}
        <Row
          label={t("rail.session")}
          value={context.usedSession ? t("rail.sessionYes") : t("rail.sessionNo")}
          tone={context.usedSession ? undefined : "muted"}
        />
        <Row
          label={t("rail.graph")}
          value={context.graphId ? `${context.graphId} v${context.graphVersion}` : ""}
          mono
        />
        <Row
          label={t("rail.materials")}
          value={context.materials.length ? context.materials.join("、") : t("rail.materialsNone")}
        />
        <Row
          label={t("rail.ablate")}
          value={runtime.ablate.length ? runtime.ablate.join("、") : t("rail.ablateNone")}
        />
        <Row label={t("rail.prompts")} value={runtime.prompts || "—"} mono />
        {/*
          图上写死了材料路径 → 项目挂的 PRD **这次没被读**。
          这是本仓库查出来的一处谎言：项目卡上亮着「规格来自 N 份文档」，
          而内置图的 docs 节点出厂就写死了 fixtures 里那份 mock。
          它必须在这里说出来，否则人要等二十分钟拿到一百条关于别人产品的用例才会发现。
        */}
        {context.graphPinned.map((g) => (
          <div
            key={g.node}
            className="mt-1.5 rounded border border-warn bg-warn-soft px-2 py-1.5 text-[0.75rem] leading-relaxed text-warn"
          >
            {t("rail.pinned", { node: g.node, said: g.said })}
          </div>
        ))}
      </Section>
    </aside>
  );
}

function Section({ title, count, children }: { title: string; count?: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-border">
      <div className="flex items-center gap-2 px-3 py-2 font-mono text-[0.6875rem] uppercase tracking-[0.09em] text-muted-foreground">
        {title}
        {count && <span className="ml-auto tabular-nums">{count}</span>}
      </div>
      <div className="px-3 pb-2.5">{children}</div>
    </div>
  );
}

const Empty = ({ children }: { children: React.ReactNode }) => (
  <p className="py-1 text-[0.75rem] text-muted-foreground">{children}</p>
);

function Row({ label, value, mono, tone }: { label: string; value: string; mono?: boolean; tone?: "muted" }) {
  if (!value) return null;
  return (
    <div className="flex items-baseline gap-2 py-[0.1875rem] text-[0.75rem]">
      <span className="w-[4.25rem] flex-none text-muted-foreground">{label}</span>
      <span
        className={cn(
          "min-w-0 flex-1 break-words",
          mono && "font-mono text-[0.6875rem]",
          tone === "muted" && "text-muted-foreground",
        )}
      >
        {value}
      </span>
    </div>
  );
}
