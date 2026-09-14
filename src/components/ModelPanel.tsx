import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui";
import { useT } from "@/lib/prefs";
import { API_BASE } from "@/lib/base";
import { cn } from "@/lib/cn";

/**
 * 模型：端点、模型名、密钥、思考开关。
 *
 * 三条纪律，每一条都对应一次真实的误诊：
 *
 * ① **显示的是「服务端此刻真的在用的」，不是框里填的。** 此前这一页什么都不保存，
 *    四个值活在内存 store 里、刷新即丢，而真实运行读的是环境变量——
 *    于是同一台机器上「配置页说的模型」和「实际在跑的模型」可以不是一个。
 * ② **每一项都标出来源**（落盘 / env / 默认）。落盘优先于 env，
 *    所以「我改了 .env 怎么没反应」是必然会出现的困惑，只能靠说出来解决。
 * ③ **密钥只写不读**。界面永远不交出它拿不到的东西——此前它交出过 `****`，
 *    粘进 `.env` 之后每一次调用都 401，而 401 读起来像模型服务坏了。
 */
interface Cfg {
  effective: {
    baseUrl: string;
    modelName: string;
    think: boolean;
    thinkBudget: number | null;
    timeoutMs: number | null;
    useQwenVL: boolean;
  };
  sources: Record<"baseUrl" | "apiKey" | "modelName" | "think", "saved" | "env" | "default">;
  apiKey: { set: boolean; state: "none" | "ok" | "undecryptable" };
  savedAt: string | null;
  proxyInUse: string | null;
}

export function ModelPanel({ onChanged }: { onChanged?: () => void }) {
  const t = useT();
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [modelName, setModelName] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [think, setThink] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [restart, setRestart] = useState<string[]>([]);

  const load = useCallback(async () => {
    const r = await fetch(`${API_BASE}/api/model/config`);
    const d = (await r.json()) as Cfg;
    setCfg(d);
    setBaseUrl(d.effective.baseUrl);
    setModelName(d.effective.modelName);
    setThink(d.effective.think);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!cfg) return <p className="text-[0.8125rem] text-muted-foreground">…</p>;

  const save = async () => {
    setBusy(true);
    setMsg("");
    try {
      const r = await fetch(`${API_BASE}/api/model/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // 密钥只在人真的填了新值时才发。留空 = 不动它（不是清除）。
        body: JSON.stringify({ baseUrl, modelName, think, ...(apiKey ? { apiKey } : {}) }),
      });
      const d = (await r.json()) as { error?: string; needsRestart?: string[] };
      if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
      setApiKey("");
      setRestart(d.needsRestart ?? []);
      await load();
      onChanged?.();
      setMsg(t("mdl.saved"));
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const clearSaved = async () => {
    setBusy(true);
    try {
      await fetch(`${API_BASE}/api/model/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseUrl: "", modelName: "", apiKey: "", thinkBudget: "", timeoutMs: "" }),
      });
      await load();
      onChanged?.();
      setMsg(t("mdl.cleared"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-3xl">
      {/* 服务端此刻在用的那一份。它和下面的输入框可能不同——那正是要说出来的事。 */}
      <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-[0.8125rem]">
        <div className="font-medium">{t("mdl.inUse")}</div>
        <div className="mt-1 font-mono text-[0.75rem]">
          {cfg.effective.modelName} @ {cfg.effective.baseUrl}
        </div>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          <Src label={t("mdl.baseUrl")} v={cfg.sources.baseUrl} />
          <Src label={t("mdl.modelName")} v={cfg.sources.modelName} />
          <Src label={t("mdl.apiKey")} v={cfg.sources.apiKey} />
          <Src label={t("mdl.think")} v={cfg.sources.think} />
        </div>
        {/*
          执行层打的地址可能不是上面那个：MIDSCENE_PROXY_URL 在 runner 的 baseUrl 上是
          第一优先级。不说出来的话，这次改造只是把误诊挪了个位置。
        */}
        {cfg.proxyInUse && (
          <p className="mt-2 rounded border border-warn bg-warn-soft px-2 py-1.5 text-[0.75rem] text-warn">
            {t("mdl.proxy", { url: cfg.proxyInUse })}
          </p>
        )}
        {cfg.apiKey.state === "undecryptable" && (
          <p className="mt-2 rounded border border-bad bg-bad-soft px-2 py-1.5 text-[0.75rem] text-bad">
            {t("mdl.keyBroken")}
          </p>
        )}
      </div>

      <Field
        label={t("mdl.baseUrl")}
        value={baseUrl}
        onChange={setBaseUrl}
        mono
        placeholder="https://api.example.com/v1"
      />
      <Field label={t("mdl.modelName")} value={modelName} onChange={setModelName} mono />
      <div className="mt-3">
        <label className="block font-mono text-[0.6875rem] uppercase tracking-[0.08em] text-muted-foreground">
          {t("mdl.apiKey")}
        </label>
        <input
          type="password"
          autoComplete="new-password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={cfg.apiKey.set ? "••••••" : t("mdl.keyUnset")}
          className="mt-1 w-full rounded-md border border-border bg-card px-2.5 py-1.5 font-mono text-[0.8125rem]"
        />
        <p className="mt-1 text-[0.75rem] leading-relaxed text-muted-foreground">{t("mdl.keyWhy")}</p>
      </div>

      <label className="mt-3 flex items-start gap-2 text-[0.8125rem]">
        <input
          type="checkbox"
          checked={think}
          onChange={(e) => setThink(e.target.checked)}
          className="mt-1"
        />
        <span>
          {t("mdl.think")}
          <span className="mt-0.5 block text-[0.75rem] leading-relaxed text-muted-foreground">
            {t("mdl.thinkWhy")}
          </span>
        </span>
      </label>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button variant="primary" disabled={busy} onClick={() => void save()}>
          {t("mdl.save")}
        </Button>
        <Button disabled={busy || !cfg.savedAt} onClick={() => void clearSaved()}>
          {t("mdl.clear")}
        </Button>
        {msg && <span className="text-[0.75rem] text-muted-foreground">{msg}</span>}
      </div>

      {/*
        保存之后网关立刻生效，但 agent / runner 是在 spawn 那一刻拿到 env 快照的。
        **不自动重启**——重启 agent 会 abort 正在跑的图，那是一个人该做的决定。
      */}
      {restart.length > 0 && (
        <p className="mt-3 rounded border border-warn bg-warn-soft px-2.5 py-2 text-[0.75rem] leading-relaxed text-warn">
          {t("mdl.needsRestart", { who: restart.join(" / ") })}
        </p>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  mono,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  mono?: boolean;
  placeholder?: string;
}) {
  return (
    <div className="mt-3">
      <label className="block font-mono text-[0.6875rem] uppercase tracking-[0.08em] text-muted-foreground">
        {label}
      </label>
      <input
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          "mt-1 w-full rounded-md border border-border bg-card px-2.5 py-1.5 text-[0.8125rem]",
          mono && "font-mono",
        )}
      />
    </div>
  );
}

/** 这一项来自哪儿。落盘优先于 env——不说出来，人会以为自己改的 .env 坏了。 */
function Src({ label, v }: { label: string; v: "saved" | "env" | "default" }) {
  const t = useT();
  return (
    <span
      className={cn(
        "rounded px-1.5 py-0.5 font-mono text-[0.6875rem]",
        v === "saved"
          ? "bg-primary/10 text-primary"
          : v === "env"
            ? "bg-muted text-muted-foreground"
            : "bg-muted/60 text-muted-foreground/70",
      )}
    >
      {label} · {t(`mdl.src.${v}`)}
    </span>
  );
}
