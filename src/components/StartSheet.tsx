import { useEffect, useState } from "react";
import { Play, X } from "lucide-react";
import { Button } from "@/components/ui";
import { useT } from "@/lib/prefs";
import { cn } from "@/lib/cn";
import { API_BASE } from "@/lib/base";
import type { GraphDef, NodeTypeDef } from "@/lib/wf";
import type { Environment } from "@/lib/types";

const API = API_BASE;

/**
 * 起跑单。
 *
 * 服务端的 `startRun` 一直收着 envRef / url / budget / params / ablate / graphVersion 六样，
 * 而界面上此前只有一个「运行」按钮——六样里五样发不出去。于是「换个环境跑一次」
 * 「这次把 repair.limit 调到整套」「这次把门禁关掉看看差多少」都只有一条路：
 * **去改图本身**。而改图会立一个新版本，把一次试跑写成一次定义变更；
 * 版本列表因此长满了从没打算留下的版本。
 *
 * 这张单子的规矩只有一条：**它只影响这一次**。图不动，版本号不动，
 * 改了什么会记进这次运行的 `paramOverrides`，运行列表上标出来——
 * 一次带覆盖的运行不该被当成这张图的基线成绩。
 */
export function StartSheet({
  def,
  nodeTypes,
  projectId,
  onClose,
  onStart,
  title,
}: {
  def?: GraphDef;
  nodeTypes: NodeTypeDef[];
  projectId: string;
  onClose: () => void;
  onStart: (opts: {
    envRef?: string;
    url?: string;
    budget?: { calls?: number; usd?: number; ms?: number };
    params?: Record<string, Record<string, unknown>>;
    ablate?: string[];
  }) => void;
  title: string;
}) {
  const t = useT();
  const [envs, setEnvs] = useState<Environment[]>([]);
  const [envRef, setEnvRef] = useState("");
  const [url, setUrl] = useState("");
  const [calls, setCalls] = useState("");
  const [usd, setUsd] = useState("");
  const [minutes, setMinutes] = useState("");
  const [ablatable, setAblatable] = useState<string[]>([]);
  const [ablate, setAblate] = useState<string[]>([]);
  /** 每个节点一份 JSON 文本。只有被人动过的那些才会发出去。 */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [paramError, setParamError] = useState("");

  useEffect(() => {
    if (projectId)
      void fetch(`${API}/api/projects/${projectId}/environments`)
        .then((r) => r.json())
        .then((d: { environments?: Environment[] }) => setEnvs(d.environments ?? []))
        .catch(() => setEnvs([]));
    void fetch(`${API}/api/ablatable`)
      .then((r) => r.json())
      .then((d: { ablatable?: string[] }) => setAblatable(d.ablatable ?? []))
      .catch(() => setAblatable([]));
  }, [projectId]);

  /**
   * 把动过的那几个节点收成覆盖。
   *
   * 没动过的不发：发一份和图上一模一样的参数，会让这次运行被标成「带覆盖」，
   * 而它其实什么都没改——那是在制造噪音。
   */
  const collect = (): Record<string, Record<string, unknown>> | undefined => {
    const out: Record<string, Record<string, unknown>> = {};
    for (const [nodeId, text] of Object.entries(drafts)) {
      const original = JSON.stringify(def?.nodes.find((n) => n.id === nodeId)?.params ?? {}, null, 2);
      if (text.trim() === original.trim()) continue;
      out[nodeId] = JSON.parse(text) as Record<string, unknown>;
    }
    return Object.keys(out).length ? out : undefined;
  };

  const go = () => {
    let params: Record<string, Record<string, unknown>> | undefined;
    try {
      params = collect();
    } catch (e) {
      // JSON 都不成立就别发了：服务端会用同一套 zod 再拒一次，但那要多跑一个来回，
      // 而这一条错误在这里就能说清是哪个节点。
      return setParamError((e as Error).message);
    }
    setParamError("");
    onStart({
      ...(envRef ? { envRef } : {}),
      ...(url.trim() ? { url: url.trim() } : {}),
      ...(calls || usd || minutes
        ? {
            budget: {
              ...(calls ? { calls: Number(calls) } : {}),
              ...(usd ? { usd: Number(usd) } : {}),
              ...(minutes ? { ms: Number(minutes) * 60_000 } : {}),
            },
          }
        : {}),
      ...(params ? { params } : {}),
      ...(ablate.length ? { ablate } : {}),
    });
  };

  const withParams = (def?.nodes ?? []).filter((n) => n.params && Object.keys(n.params).length);

  return (
    <div className="absolute right-3 top-14 z-30 flex max-h-[calc(100vh-6rem)] w-[26.25rem] flex-col overflow-hidden rounded-xl border border-border bg-card shadow-lg">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-[0.8125rem] font-medium">{title}</span>
        <button
          onClick={onClose}
          className="ml-auto cursor-pointer text-muted-foreground hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-auto p-3 text-[0.75rem]">
        {/* 打哪里。没选就是「拿默认环境」——那也会被记进运行记录，事后分得清。 */}
        <label className="block">
          <span className="text-muted-foreground">{t("start.env")}</span>
          <select
            className="mt-1 w-full rounded-md border border-border bg-card px-2 py-1"
            value={envRef}
            onChange={(e) => setEnvRef(e.target.value)}
            disabled={!projectId}
          >
            <option value="">{t("start.envDefault")}</option>
            {envs.map((e) => (
              <option key={e.id} value={e.name}>
                {e.name} · {e.baseUrl}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="text-muted-foreground">{t("start.url")}</span>
          <input
            className="mt-1 w-full rounded-md border border-border bg-card px-2 py-[0.1875rem] font-mono"
            placeholder={t("start.urlHint")}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </label>

        {/* 上限。三个都空就是不设——**不是设成 0**。 */}
        <div>
          <span className="text-muted-foreground">{t("start.budget")}</span>
          <div className="mt-1 grid grid-cols-3 gap-2">
            <input
              className="rounded-md border border-border bg-card px-2 py-[0.1875rem] font-mono"
              placeholder="calls"
              value={calls}
              onChange={(e) => setCalls(e.target.value.replace(/\D/g, ""))}
            />
            <input
              className="rounded-md border border-border bg-card px-2 py-[0.1875rem] font-mono"
              placeholder="usd"
              value={usd}
              onChange={(e) => setUsd(e.target.value.replace(/[^\d.]/g, ""))}
            />
            <input
              className="rounded-md border border-border bg-card px-2 py-[0.1875rem] font-mono"
              placeholder={t("start.minutes")}
              value={minutes}
              onChange={(e) => setMinutes(e.target.value.replace(/\D/g, ""))}
            />
          </div>
        </div>

        {/* 消融：这次关掉哪些组件。关掉了什么是结果含义的一部分，所以它进运行记录。 */}
        {ablatable.length > 0 && (
          <div>
            <span className="text-muted-foreground">{t("start.ablate")}</span>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {ablatable.map((a) => (
                <button
                  key={a}
                  onClick={() => setAblate((s) => (s.includes(a) ? s.filter((x) => x !== a) : [...s, a]))}
                  className={cn(
                    "rounded px-1.5 py-0.5 font-mono text-[0.6875rem]",
                    ablate.includes(a)
                      ? "bg-bad-soft text-bad"
                      : "bg-muted text-muted-foreground hover:brightness-95",
                  )}
                >
                  {a}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* 参数覆盖：只影响这一次，图不动、版本号不动。 */}
        {withParams.length > 0 && (
          <div>
            <span className="text-muted-foreground">{t("start.params")}</span>
            <p className="mt-0.5 text-[0.6875rem] text-muted-foreground">{t("start.paramsWhy")}</p>
            <div className="mt-1 space-y-2">
              {withParams.map((n) => {
                const original = JSON.stringify(n.params ?? {}, null, 2);
                const text = drafts[n.id] ?? original;
                const changed = text.trim() !== original.trim();
                return (
                  <div key={n.id}>
                    <div className="flex items-center gap-1.5 font-mono text-[0.6875rem] text-muted-foreground">
                      <span>{n.id}</span>
                      <span className="opacity-60">
                        {nodeTypes.find((nt) => nt.type === n.type)?.title ?? n.type}
                      </span>
                      {changed && (
                        <button
                          className="ml-auto cursor-pointer underline decoration-dotted hover:text-foreground"
                          onClick={() => setDrafts((d) => ({ ...d, [n.id]: original }))}
                        >
                          {t("start.paramReset")}
                        </button>
                      )}
                    </div>
                    <textarea
                      rows={Math.min(6, original.split("\n").length)}
                      className={cn(
                        "mt-0.5 w-full rounded-md border bg-card px-2 py-1 font-mono text-[0.6875rem]",
                        changed ? "border-warn" : "border-border",
                      )}
                      value={text}
                      onChange={(e) => setDrafts((d) => ({ ...d, [n.id]: e.target.value }))}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {paramError && <p className="text-[0.75rem] text-bad">{paramError}</p>}
      </div>

      <div className="flex items-center gap-2 border-t border-border px-3 py-2">
        <Button variant="primary" onClick={go}>
          <Play className="h-3.5 w-3.5" />
          {t("start.go")}
        </Button>
        <span className="text-[0.6875rem] text-muted-foreground">{t("start.onlyThisRun")}</span>
      </div>
    </div>
  );
}
