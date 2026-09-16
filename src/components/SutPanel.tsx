import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui";
import { useT } from "@/lib/prefs";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import type { Environment } from "@/lib/types";

/**
 * 被测对象：地址、随请求带上什么、怎么登录。
 *
 * 这一屏存在的理由是三处**静默失败**——它们都不会当场报错，都会在二十分钟后的一次运行里，
 * 或者客户仓库的第一次 `npm test` 上暴露：
 *
 * ① **地址可以为空**。保存只校验名字非空，而 baseUrl 是抓登录态的唯一目标地址、
 *    也是导出 `playwright.config` 里 baseURL 的唯一来源。
 * ② **三张长得一模一样的 KV 表，命运完全不同**。headers 变成 `extraHTTPHeaders`，
 *    vars 进 `.env.example`，而 query **只被扫了一遍变量名就再没有消费点**——
 *    导出的工程里根本不带它。所以这里合成一张表，多一列「去向」，
 *    没真正实现的去向标红，而不是让人事后在客户仓库里发现。
 * ③ **三条登录路只有一条能被导出带走**。`hasAuth` 要求 `login.steps` 非空，
 *    粘贴的会话与 API 登录都不满足——导出的工程跑起来是未登录态，而界面此前一个字没提。
 */
export function SutPanel({ projectId, onChanged }: { projectId: string; onChanged?: () => void }) {
  const t = useT();
  const [envs, setEnvs] = useState<Environment[]>([]);
  const [env, setEnv] = useState<Environment | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  /** 视口。空 = 沿用默认，不是 0。 */
  const [vpW, setVpW] = useState("");
  const [vpH, setVpH] = useState("");
  /** 环境画像：前提名（逗号分隔）、默认注入钱包。 */
  const [caps, setCaps] = useState("");
  const [injectWallet, setInjectWallet] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [log, setLog] = useState<string[]>([]);

  const load = useCallback(async () => {
    if (!projectId) return;
    const { environments } = await api.getEnvironments(projectId);
    setEnvs(environments);
    const e = environments.find((x) => x.isDefault) ?? environments[0] ?? null;
    setEnv(e);
    setBaseUrl(e?.baseUrl ?? "");
    setVpW(e?.viewport?.width ? String(e.viewport.width) : "");
    setVpH(e?.viewport?.height ? String(e.viewport.height) : "");
    setCaps((e?.capabilities ?? []).join(", "));
    setInjectWallet(!!e?.injectWallet);
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!env) return <p className="text-[0.8125rem] text-muted-foreground">{t("sut.noEnv")}</p>;

  /** 地址必填。空 baseUrl 存得下去，是一条会在二十分钟后才暴露的失败。 */
  const urlBad = !baseUrl.trim();

  const save = async () => {
    if (urlBad) return;
    setBusy(true);
    setMsg("");
    try {
      await api.saveEnvironment(projectId, {
        id: env.id,
        name: env.name,
        baseUrl: baseUrl.trim(),
        vars: env.vars,
        headers: env.headers,
        query: env.query,
        // 两个都空就不发 viewport——发一个 `{}` 会让界面上看起来"配过了"，而它什么都没说。
        ...(vpW || vpH
          ? {
              viewport: {
                ...(vpW ? { width: Number(vpW) } : {}),
                ...(vpH ? { height: Number(vpH) } : {}),
              },
            }
          : {}),
        login: {
          authRequired: env.login?.authRequired,
          steps: env.login?.steps,
          apiLogin: env.login?.apiLogin ?? null,
        },
        isDefault: env.isDefault,
        capabilities: caps.split(/[,，\s]+/).map((c) => c.trim()).filter(Boolean),
        injectWallet,
      });
      await load();
      onChanged?.();
      setMsg(t("sut.saved"));
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /**
   * 抓登录态是一次**前台可见的作业**，不是一个转圈的按钮。
   *
   * 服务端一直返回逐步日志，而前端只取了 cookies 与 localStorage 两个数——
   * 于是这一步是十分钟的黑盒，失败只剩一行 `capture failed: …`，
   * 而它恰恰是视觉模型驱动真浏览器点登录页，最需要那份日志的一步。
   */
  const capture = async () => {
    setBusy(true);
    setMsg("");
    setLog([]);
    try {
      const r = await api.captureSession(env.id);
      setLog(r.log ?? []);
      setMsg(t("sut.captured", { c: r.cookies, l: r.localStorage }));
      await load();
      onChanged?.();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const rows: Array<{ k: string; v: string; fate: "header" | "env" | "query" }> = [
    ...Object.entries(env.headers ?? {}).map(([k, v]) => ({ k, v: String(v), fate: "header" as const })),
    ...Object.entries(env.vars ?? {}).map(([k, v]) => ({
      k,
      v: Array.isArray(v) ? v.join(", ") : String(v),
      fate: "env" as const,
    })),
    ...Object.entries(env.query ?? {}).map(([k, v]) => ({ k, v: String(v), fate: "query" as const })),
  ];

  const hasSession = !!env.login?.hasSession;
  const hasSteps = !!env.login?.steps?.length;

  return (
    <div className="max-w-3xl">
      <div className="flex flex-wrap items-center gap-2">
        <select
          className="rounded-md border border-border bg-card px-2 py-1 text-[0.8125rem]"
          value={env.id}
          onChange={(e) => {
            const n = envs.find((x) => x.id === e.target.value) ?? null;
            setEnv(n);
            setBaseUrl(n?.baseUrl ?? "");
            setLog([]);
          }}
        >
          {envs.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
              {e.isDefault ? " ★" : ""}
            </option>
          ))}
        </select>
      </div>

      <label className="mt-4 block font-mono text-[0.6875rem] uppercase tracking-[0.08em] text-muted-foreground">
        {t("sut.baseUrl")}
      </label>
      <input
        value={baseUrl}
        onChange={(e) => setBaseUrl(e.target.value)}
        placeholder="https://staging.example.com"
        className={cn(
          "mt-1 w-full rounded-md border bg-card px-2.5 py-1.5 font-mono text-[0.8125rem]",
          urlBad ? "border-bad" : "border-border",
        )}
      />
      {urlBad && <p className="mt-1 text-[0.75rem] text-bad">{t("sut.baseUrlRequired")}</p>}
      <p className="mt-1 text-[0.75rem] leading-relaxed text-muted-foreground">{t("sut.baseUrlWhy")}</p>

      {/* 视口跟着被测对象走。
          默认 1024×720 是为压小视觉模型的图定的，而它对一部分真实界面撑不开——
          在那个宽度下下单面板整块不渲染，而探索器不会报错，它只是看不见半个产品。
          放在这里而不是做成全局设置：调大默认会让所有被测对象一起变贵。 */}
      <label className="mt-3 block text-[0.75rem] font-medium">{t("sut.viewport")}</label>
      <div className="mt-1 flex items-center gap-2">
        <input
          className="w-24 rounded-md border border-border bg-card px-2 py-[0.1875rem] font-mono text-[0.75rem]"
          placeholder="1024"
          value={vpW}
          onChange={(e) => setVpW(e.target.value.replace(/\D/g, ""))}
        />
        <span className="text-muted-foreground">×</span>
        <input
          className="w-24 rounded-md border border-border bg-card px-2 py-[0.1875rem] font-mono text-[0.75rem]"
          placeholder="720"
          value={vpH}
          onChange={(e) => setVpH(e.target.value.replace(/\D/g, ""))}
        />
      </div>
      <p className="mt-1 text-[0.75rem] leading-relaxed text-muted-foreground">{t("sut.viewportWhy")}</p>

      {/* 环境画像。三样都是这个被测对象的属性，由人决定，不从代码或聊天里来：
          规则包目标的 requires 对照前提名；探索默认带不带钱包；能不能执行删除、支付这类不可逆步骤。
          最后一项打勾要再确认一次，确认框里写明是哪个地址。 */}
      <label htmlFor="sut-capabilities" className="mt-4 block text-[0.75rem] font-medium">{t("sut.capabilities")}</label>
      <input
        id="sut-capabilities"
        className="mt-1 w-full rounded-md border border-border bg-card px-2.5 py-1.5 font-mono text-[0.8125rem]"
        placeholder="session"
        value={caps}
        onChange={(e) => setCaps(e.target.value)}
      />
      <p className="mt-1 text-[0.75rem] leading-relaxed text-muted-foreground">{t("sut.capabilitiesWhy")}</p>
      <label className="mt-3 flex items-start gap-2 text-[0.8125rem]">
        <input id="sut-inject-wallet" type="checkbox" className="mt-1" checked={injectWallet} onChange={(e) => setInjectWallet(e.target.checked)} />
        <span><span className="font-medium">{t("sut.injectWallet")}</span><span className="mt-0.5 block text-[0.75rem] text-muted-foreground">{t("sut.injectWalletWhy")}</span></span>
      </label>
      <h3 className="mt-5 text-[0.8125rem] font-semibold">{t("sut.carried")}</h3>
      <p className="mt-1 text-[0.75rem] leading-relaxed text-muted-foreground">{t("sut.carriedWhy")}</p>
      <table className="mt-2 w-full text-[0.8125rem]">
        <thead>
          <tr className="border-b border-border text-left font-mono text-[0.6875rem] uppercase tracking-wide text-muted-foreground">
            <th className="py-1.5">{t("sut.key")}</th>
            <th>{t("sut.value")}</th>
            <th className="w-[13.125rem]">{t("sut.fate")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={3} className="py-2 text-muted-foreground">
                {t("sut.nothingCarried")}
              </td>
            </tr>
          )}
          {rows.map((r) => (
            <tr key={`${r.fate}:${r.k}`} className="border-b border-border/60">
              <td className="py-1.5 font-mono">{r.k}</td>
              <td className="font-mono text-muted-foreground">{r.v.slice(0, 40)}</td>
              <td>
                <span
                  className={cn(
                    "rounded px-1.5 py-0.5 font-mono text-[0.6875rem]",
                    r.fate === "query" ? "bg-bad-soft text-bad" : "bg-ok-soft text-ok",
                  )}
                >
                  {t(`sut.fate.${r.fate}`)}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3 className="mt-5 text-[0.8125rem] font-semibold">{t("sut.login")}</h3>
      <div className="mt-1 space-y-1.5">
        <LoginRow ok={hasSteps} label={t("sut.loginSteps")} note={t("sut.exportKeeps")} active={hasSteps} />
        <LoginRow
          ok={false}
          label={t("sut.loginPasted")}
          note={t("sut.exportDrops")}
          active={hasSession && !hasSteps}
        />
        <LoginRow
          ok={false}
          label={t("sut.loginApi")}
          note={t("sut.exportDrops")}
          active={!!env.login?.apiLogin}
        />
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <Button variant="primary" disabled={busy || urlBad} onClick={() => void save()}>
          {t("sut.save")}
        </Button>
        <Button
          disabled={busy || !hasSteps}
          title={hasSteps ? undefined : t("sut.needSteps")}
          onClick={() => void capture()}
        >
          {t("sut.verify")}
        </Button>
        {msg && <span className="text-[0.75rem] text-muted-foreground">{msg}</span>}
      </div>

      {log.length > 0 && (
        <pre className="mt-3 max-h-60 overflow-auto rounded-lg border border-border bg-muted/40 p-2.5 font-mono text-[0.75rem] leading-relaxed">
          {log.join("\n")}
        </pre>
      )}
    </div>
  );
}

function LoginRow({
  ok,
  label,
  note,
  active,
}: {
  ok: boolean;
  label: string;
  note: string;
  active: boolean;
}) {
  return (
    <div className={cn("flex items-baseline gap-2 text-[0.8125rem]", !active && "opacity-55")}>
      <span className="w-3 flex-none">{active ? "●" : "○"}</span>
      <span className="min-w-0 flex-1">{label}</span>
      <span
        className={cn(
          "flex-none rounded px-1.5 py-0.5 font-mono text-[0.6875rem]",
          ok ? "bg-ok-soft text-ok" : "bg-warn-soft text-warn",
        )}
      >
        {note}
      </span>
    </div>
  );
}
