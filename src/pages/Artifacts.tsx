import { useEffect, useMemo, useState } from "react";
import { TopBar } from "@/components/TopBar";
import { useT } from "@/lib/prefs";
import { useWf } from "@/lib/wf";
import { cn } from "@/lib/cn";
import { openCard } from "@/lib/open";

/**
 * 物料：一份统一列表，不是十三张卡。
 *
 * 「每类产物一张卡」随类型数**线性劣化**——13 类就是 13 张卡，人仍然要先在脑子里
 * 建一张地图才找得到东西，只是那张地图从菜单换成了画布。而这个产品的产物类型只会更多。
 *
 * 统一列表 + 筛选 + pin 是 Claude Artifacts 与 Langfuse 都收敛到的形状：
 * 加一类产物就是列表里多一行，不需要在画布上再找一块地方摆它。
 *
 * pin 存在本地：它是**这个人此刻在盯什么**，不是这次运行的属性，
 * 不该写进运行记录，也不该跟着链接发给别人。
 */
const PINS = "tp.pinnedArtifacts";

function readPins(): string[] {
  try {
    return JSON.parse(window.localStorage.getItem(PINS) ?? "[]") as string[];
  } catch {
    return [];
  }
}
function writePins(v: string[]): void {
  try {
    window.localStorage.setItem(PINS, JSON.stringify(v));
  } catch {
    /* 无痕窗口会抛；pin 只是便利，不该因此让这一屏打不开 */
  }
}

export function ArtifactsPage() {
  const t = useT();
  const artifacts = useWf((s) => s.artifacts);
  const runs = useWf((s) => s.runs);
  const wfRunId = useWf((s) => s.wfRunId);
  const selectRun = useWf((s) => s.selectRun);
  const load = useWf((s) => s.load);

  const [pins, setPins] = useState<string[]>(readPins);
  const [kind, setKind] = useState("all");

  /**
   * 这一屏可以被**直接打开**（左导航、⌘K、别人发来的链接），
   * 那时画布从来没挂载过，`runs` 还是空的。此前所有数据都靠画布的挂载 effect 加载——
   * 这正是左导航带出的那一类回归：换个入口进来，界面就空了。
   */
  useEffect(() => {
    if (!runs.length) void load();
  }, [runs.length, load]);

  const kinds = useMemo(() => ["all", ...new Set(artifacts.map((a) => a.node))], [artifacts]);
  const shown = useMemo(() => {
    const list = kind === "all" ? artifacts : artifacts.filter((a) => a.node === kind);
    // pin 过的排在前面，其余保持产出顺序——那是流水线的顺序，本身有意义。
    return [...list].sort((a, b) => Number(pins.includes(b.id)) - Number(pins.includes(a.id)));
  }, [artifacts, kind, pins]);

  const toggle = (id: string) => {
    const next = pins.includes(id) ? pins.filter((x) => x !== id) : [...pins, id];
    setPins(next);
    writePins(next);
  };

  const recent = useMemo(
    () => [...runs].sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt))).slice(0, 20),
    [runs],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TopBar
        title={t("surface.artifacts")}
        actions={
          /* 这一屏自己带运行选择器：它不再依附画布，人从任何入口进来都要能换看哪一次。 */
          <select
            className="max-w-[16.25rem] rounded border border-input bg-card px-2 py-[0.1875rem] text-[0.8125rem]"
            value={wfRunId}
            onChange={(e) => e.target.value && void selectRun(e.target.value)}
          >
            <option value="">{t("art.pickRun")}</option>
            {recent.map((r) => (
              <option key={r.id} value={r.id}>
                {r.graphId} · {String(r.startedAt).slice(5, 16).replace("T", " ")} · {r.status}
              </option>
            ))}
          </select>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <p className="mt-1 max-w-2xl text-[0.8125rem] leading-relaxed text-muted-foreground">{t("art.why")}</p>

        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {kinds.map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              className={cn(
                "rounded-full border px-2.5 py-1 font-mono text-[0.6875rem]",
                kind === k
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:bg-accent",
              )}
            >
              {k === "all" ? t("art.all") : k}
            </button>
          ))}
        </div>

        {shown.length === 0 && (
          <p className="mt-6 text-[0.8125rem] text-muted-foreground">
            {wfRunId ? t("art.emptyRun") : t("art.pickRunFirst")}
          </p>
        )}

        <div className="mt-3 divide-y divide-border rounded-lg border border-border">
          {shown.map((a) => (
            <div key={a.id} className="flex items-center gap-3 px-3 py-2.5">
              <button
                type="button"
                title={t(pins.includes(a.id) ? "art.unpin" : "art.pin")}
                onClick={() => toggle(a.id)}
                className={cn(
                  "flex-none text-[0.8125rem]",
                  pins.includes(a.id) ? "text-warn" : "text-muted-foreground/35 hover:text-muted-foreground",
                )}
              >
                ★
              </button>
              <span className="w-[5.375rem] flex-none truncate font-mono text-[0.6875rem] text-muted-foreground">
                {a.node}
              </span>
              <span className="min-w-0 flex-1 truncate text-[0.8125rem]">{a.title}</span>
              <span
                className={cn(
                  "flex-none font-mono text-[0.8125rem] tabular-nums",
                  a.tone === "warn" && "text-warn",
                )}
              >
                {a.value}
              </span>
              <span className="w-[9.375rem] flex-none truncate text-right text-[0.75rem] text-muted-foreground">
                {a.sub}
              </span>
              {a.opens ? (
                <button
                  type="button"
                  onClick={() => openCard(a.opens!.surface)}
                  className="flex-none rounded border border-border px-2 py-0.5 text-[0.75rem] hover:bg-accent"
                >
                  {a.opens.label}
                </button>
              ) : (
                <span className="w-[4rem] flex-none" />
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
