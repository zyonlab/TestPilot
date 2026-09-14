import { useEffect, useState, type FormEvent } from "react";
import { useStore } from "@/lib/store";
import { useT } from "@/lib/prefs";
import { NeedProject } from "@/components/NeedProject";
import { Button } from "@/components/ui";
import { modelProfilesApi, ModelProfileRequestError, type ProjectModels, type PublicModelProfile, type ModelRole } from "@/lib/modelProfiles";

const fieldClass = "mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary";

function RoleForm({ projectId, role, initial, onSaved }: { projectId: string; role: ModelRole; initial?: PublicModelProfile; onSaved: (profile: PublicModelProfile) => void }) {
  const t = useT();
  const [saved, setSaved] = useState(initial);
  const [endpoint, setEndpoint] = useState(initial?.endpoint ?? "");
  const [model, setModel] = useState(initial?.model ?? "");
  const [provider, setProvider] = useState(initial?.provider ?? "openai-compatible");
  const [thinking, setThinking] = useState(initial?.thinking === null || initial?.thinking === undefined ? "unknown" : String(initial.thinking));
  const [apiKey, setApiKey] = useState("");
  const [clearCredential, setClearCredential] = useState(false);
  const [busy, setBusy] = useState<"save" | "probe" | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const dirty = !saved || saved.endpoint !== endpoint || saved.model !== model || saved.provider !== provider ||
    (saved.thinking === null ? "unknown" : String(saved.thinking)) !== thinking || !!apiKey || clearCredential;
  const explain = (e: unknown) => {
    const codes = ["profile_version_conflict", "endpoint_change_requires_credential_choice", "credential_undecryptable", "invalid_profile", "model_probe_failed"];
    return e instanceof ModelProfileRequestError && codes.includes(e.code) ? t(`modelRoles.error.${e.code}`) : t("modelRoles.error.generic");
  };
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy("save"); setError(""); setMessage("");
    try {
      const next = await modelProfilesApi.save(projectId, role, {
        expectedVersion: saved?.origin === "environment" ? 0 : saved?.version ?? 0, provider, model, endpoint,
        thinking: thinking === "unknown" ? null : thinking === "true",
        capabilities: saved?.capabilities ?? { vision: "unknown", toolUse: "unknown" },
        ...(saved?.timeoutMs !== undefined ? { timeoutMs: saved.timeoutMs } : {}),
        ...(saved?.thinkBudget !== undefined ? { thinkBudget: saved.thinkBudget } : {}),
        ...(saved?.vlMode ? { vlMode: saved.vlMode } : {}),
        ...(apiKey ? { apiKey } : {}), clearCredential,
      });
      setSaved(next); setEndpoint(next.endpoint); setModel(next.model); setProvider(next.provider);
      onSaved(next);
      setApiKey(""); setClearCredential(false); setMessage(t("modelRoles.saved"));
    } catch (e) { setError(explain(e)); }
    finally { setBusy(null); }
  }
  async function probe() {
    if (!saved || dirty) return;
    setBusy("probe"); setError(""); setMessage("");
    try {
      const result = await modelProfilesApi.probe(projectId, role, saved.version, saved.id);
      setMessage(t(result.state === "ok" ? "modelRoles.probeOk" : "modelRoles.probeEmpty"));
    } catch (e) { setError(explain(e)); }
    finally { setBusy(null); }
  }
  return <form onSubmit={save} className="rounded-xl border border-border bg-card p-5" aria-label={t(`modelRoles.${role}`)}>
    <div className="flex items-baseline justify-between gap-4"><h3 className="text-sm font-semibold">{t(`modelRoles.${role}`)}</h3><span className="font-mono text-xs text-muted-foreground">{saved ? `v${saved.version}` : t("modelRoles.unconfigured")}</span></div>
    <p className="mb-5 mt-2 text-xs text-muted-foreground">{t(`modelRoles.${role}Help`)}</p>
    {saved?.origin === "environment" && <p className="mb-4 rounded-md bg-muted px-3 py-2 text-xs">{t("modelRoles.fromEnv")}</p>}
    <fieldset disabled={!!busy} className="space-y-4 disabled:opacity-70">
      <label className="block text-xs">{t("modelRoles.provider")}<input className={fieldClass} value={provider} onChange={e => setProvider(e.target.value)} required maxLength={256} /></label>
      <label className="block text-xs">{t("modelRoles.endpoint")}<input className={fieldClass} type="url" value={endpoint} onChange={e => setEndpoint(e.target.value)} required placeholder="https://example.com/v1" /></label>
      <label className="block text-xs">{t("modelRoles.model")}<input className={fieldClass} value={model} onChange={e => setModel(e.target.value)} required maxLength={256} /></label>
      <label className="block text-xs">{t("modelRoles.key")}<input className={fieldClass} type="password" autoComplete="new-password" value={apiKey} disabled={clearCredential} onChange={e => setApiKey(e.target.value)} aria-describedby={`${role}-key-help`} /></label>
      <p id={`${role}-key-help`} className="text-xs text-muted-foreground">{saved?.credentialState === "ok" ? t(saved.origin === "environment" ? "modelRoles.keyFromEnv" : "modelRoles.keySaved") : saved?.credentialState === "undecryptable" ? t("modelRoles.error.credential_undecryptable") : t("modelRoles.keyHelp")}</p>
      {saved?.credentialState !== undefined && saved.credentialState !== "none" && <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={clearCredential} onChange={e => { setClearCredential(e.target.checked); setApiKey(""); }} />{t("modelRoles.clearKey")}</label>}
      <label className="block text-xs">{t("modelRoles.thinking")}<select className={fieldClass} style={{ height: 40, paddingTop: 0, paddingBottom: 0 }} value={thinking} onChange={e => setThinking(e.target.value)}><option value="unknown">{t("modelRoles.default")}</option><option value="true">{t("modelRoles.on")}</option><option value="false">{t("modelRoles.off")}</option></select></label>
      <div className="flex flex-wrap gap-2 pt-2"><Button type="submit" disabled={!dirty}>{t(busy === "save" ? "modelRoles.saving" : "modelRoles.save")}</Button><Button type="button" variant="outline" disabled={!saved || dirty} onClick={probe}>{t(busy === "probe" ? "modelRoles.probing" : "modelRoles.probe")}</Button></div>
    </fieldset>
    <div aria-live="polite" className="mt-3 text-xs">{error ? <p role="alert" className="text-bad">{error}</p> : message ? <p className="text-ok">{message}</p> : null}</div>
  </form>;
}

function ProjectModelSettings({ projectId }: { projectId: string }) {
  const t = useT();
  const [data, setData] = useState<ProjectModels | null>(null);
  const [error, setError] = useState(false);
  const [reload, setReload] = useState(0);
  const [entry, setEntry] = useState("web");
  const onSaved = (profile: PublicModelProfile) => setData(d => d ? { ...d, profiles: { ...d.profiles, [profile.role]: profile } } : d);
  useEffect(() => {
    let active = true; setError(false); setData(null);
    modelProfilesApi.read(projectId).then(d => { if (active) setData(d); }).catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [projectId, reload]);
  return <div className="max-w-4xl space-y-5">
    <div><h2 className="text-lg font-medium">{t("modelRoles.title")}</h2><p className="mt-2 text-sm text-muted-foreground">{t("modelRoles.help")}</p></div>
    <label className="block max-w-xs text-xs">{t("modelRoles.entry")}<select className={fieldClass} style={{ height: 40, paddingTop: 0, paddingBottom: 0 }} value={entry} onChange={e => setEntry(e.target.value)}><option value="web">{t("modelRoles.web")}</option><option value="host">{t("modelRoles.host")}</option></select></label>
    {entry === "host" && <p className="rounded-lg border border-border p-4 text-sm">{t("modelRoles.inherited")}</p>}
    {error ? <div role="alert" className="space-y-3"><p className="text-sm text-bad">{t("modelRoles.error.generic")}</p><Button variant="outline" onClick={() => setReload(n => n + 1)}>{t("modelRoles.reload")}</Button></div> : !data ? <p role="status" className="text-sm text-muted-foreground">{t("modelRoles.loading")}</p> : <>
      {!data.profiles.planner && !data.profiles.executor && (data.migration.legacy.modelPresent || data.migration.legacy.endpointPresent) && <p className="rounded-lg bg-muted p-4 text-xs text-muted-foreground">{t("modelRoles.migration")}</p>}
      <div className="grid items-start gap-4 lg:grid-cols-2">
        {entry === "web" && <RoleForm key={`${projectId}:planner`} projectId={projectId} role="planner" initial={data.profiles.planner} onSaved={onSaved} />}
        <RoleForm key={`${projectId}:executor`} projectId={projectId} role="executor" initial={data.profiles.executor} onSaved={onSaved} />
      </div>
      <p className="text-xs text-muted-foreground">{t("modelRoles.probeHelp")}</p>
    </>}
  </div>;
}

export function ModelProfilesSection() {
  const projectId = useStore(s => s.activeProjectId);
  return <div className="flex-1 overflow-auto p-4">{projectId ? <ProjectModelSettings key={projectId} projectId={projectId} /> : <NeedProject />}</div>;
}
