import { SessionEvidenceFields, emptyIdentity, readIdentity, writeIdentity } from "@/components/SessionEvidenceFields";
import { useCallback, useEffect, useState } from "react";
import {
  CheckCircle,
  AlertTriangle,
  Loader2,
  Server,
  Boxes,
  KeyRound,
  Plus,
  Trash2,
  Lock,
  Bug,
  FileText,
  RotateCcw,
  RefreshCw,
  Languages,
  ClipboardPaste,
} from "lucide-react";
import { NeedProject } from "@/components/NeedProject";
import { Button } from "@/components/ui";
import { useT, usePrefs } from "@/lib/prefs";
import { useStore } from "@/lib/store";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import type { AppSettings, PromptTemplates } from "@/lib/api";
import type { Environment, LoginFlow, SecretMeta } from "@/lib/types";

/*
 * `ModelConfigPage`（模型端点这一整屏）已在 v3 Phase 3 退役——见 `docs/v3/history/00-架构.md` §1/§2 与
 * `components/SettingsDrawer.tsx` 的文件注释：模型端点归 PenguinHarness 的 session，不再是
 * 这台机器的设置。这个文件现在只剩它名字所说的另一半：环境、密钥、提示词模板与偏好，
 * 这三张卡被 `pages/SettingsSections.tsx` re-export 复用，是活代码。
 */

// Global LLM-debug toggle + prompt-template editors. Both read/write the backend's
// app settings (/api/settings); the debug card also lists the most recent capture
// files (/api/llm-debug) when logging is on. Degrades gracefully when offline.
export function DebugPromptsCards({ show = "all" }: { show?: "all" | "prompts" | "prefs" }) {
  const t = useT();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [defaults, setDefaults] = useState<PromptTemplates | null>(null);
  const [offline, setOffline] = useState(false);

  // Local, editable copies of the prompts so typing doesn't fire requests.
  const [prompts, setPrompts] = useState<PromptTemplates>({
    explore: "",
    exploreDeepPrefix: "",
    exploreDapp: "",
    generateCode: "",
  });

  const load = useCallback(async () => {
    try {
      const { settings, defaults } = await api.getSettings();
      setSettings(settings);
      setDefaults(defaults);
      setPrompts(settings.prompts);
      setOffline(false);
    } catch {
      setOffline(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (offline) {
    return (
      <div className="rounded-xl border border-border bg-card p-4">
        <p className="text-xs text-muted-foreground">{t("model.debugOffline")}</p>
      </div>
    );
  }

  if (!settings || !defaults) {
    return (
      <div className="rounded-xl border border-border bg-card p-4">
        <p className="text-xs text-muted-foreground">{t("common.loading")}</p>
      </div>
    );
  }

  // Which of these cards is on screen is the caller's decision:"语言与调试" is a personal
  // preference and"提示词模板" changes what every future run is told — filed together only
  // because they happened to share one fetch. The fetch is still shared; the page is not.
  const prefs = show === "all" || show === "prefs";
  const tpl = show === "all" || show === "prompts";
  return (
    <>
      {prefs && <LanguageCard settings={settings} setSettings={setSettings} />}
      {prefs && <DebugCard settings={settings} setSettings={setSettings} />}
      {tpl && (
        <PromptsCard
          defaults={defaults}
          prompts={prompts}
          setPrompts={setPrompts}
          onReset={(next) => {
            setPrompts(next.prompts);
            setSettings(next);
          }}
        />
      )}
    </>
  );
}

// Global toggle: when on, the current UI language is injected into every AI request so
// the model's natural-language output (flow titles, reasons, steps, assertions, notes)
// comes back in that language. The language followed is whatever the UI is set to.
function LanguageCard({
  settings,
  setSettings,
}: {
  settings: AppSettings;
  setSettings: (s: AppSettings) => void;
}) {
  const t = useT();
  const lang = usePrefs((s) => s.lang);
  const LANG_LABEL: Record<string, string> = { zh: "简体中文", en: "English", ja: "日本語" };

  const toggle = async () => {
    const next = !settings.enforceLang;
    setSettings({ ...settings, enforceLang: next }); // optimistic
    try {
      const { settings: saved } = await api.saveSettings({ enforceLang: next });
      setSettings(saved);
    } catch {
      setSettings({ ...settings, enforceLang: !next });
    }
  };

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="mb-1 flex items-center gap-1.5">
        <Languages className="h-4 w-4 text-muted-foreground" />
        <h2 className="font-display text-sm font-medium text-foreground">{t("model.langCard")}</h2>
      </div>

      <label className="mt-2 flex cursor-pointer items-center gap-2.5">
        <button
          type="button"
          role="switch"
          aria-checked={settings.enforceLang}
          onClick={toggle}
          className={cn(
            "relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors",
            settings.enforceLang ? "bg-primary" : "bg-muted",
          )}
        >
          <span
            className={cn(
              "inline-block h-4 w-4 transform rounded-full bg-card shadow transition-transform",
              settings.enforceLang ? "translate-x-4" : "translate-x-0.5",
            )}
          />
        </button>
        <span className="text-sm text-foreground">{t("model.langToggle")}</span>
      </label>

      <p className="mt-2 text-xs text-muted-foreground">{t("model.langHelp")}</p>

      {settings.enforceLang && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-foreground">
          <span className="rounded bg-primary/10 px-1.5 py-0.5 font-medium text-primary">
            {LANG_LABEL[lang] ?? lang}
          </span>
          <span className="text-muted-foreground">{t("model.langCurrent")}</span>
        </p>
      )}
    </div>
  );
}

function DebugCard({
  settings,
  setSettings,
}: {
  settings: AppSettings;
  setSettings: (s: AppSettings) => void;
}) {
  const t = useT();
  const [captures, setCaptures] = useState<{
    dir?: string;
    entries: string[];
  } | null>(null);
  const [loadingCaptures, setLoadingCaptures] = useState(false);

  const refreshCaptures = useCallback(async () => {
    setLoadingCaptures(true);
    try {
      const { dir, entries } = await api.getLlmDebug();
      setCaptures({ dir, entries });
    } catch {
      setCaptures({ entries: [] });
    } finally {
      setLoadingCaptures(false);
    }
  }, []);

  useEffect(() => {
    if (settings.debugLLM) void refreshCaptures();
    else setCaptures(null);
  }, [settings.debugLLM, refreshCaptures]);

  const toggle = async () => {
    const next = !settings.debugLLM;
    // Optimistic; revert on failure.
    setSettings({ ...settings, debugLLM: next });
    try {
      const { settings: saved } = await api.saveSettings({ debugLLM: next });
      setSettings(saved);
    } catch {
      setSettings({ ...settings, debugLLM: !next });
    }
  };

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="mb-1 flex items-center gap-1.5">
        <Bug className="h-4 w-4 text-muted-foreground" />
        <h2 className="font-display text-sm font-medium text-foreground">{t("model.debugCard")}</h2>
      </div>

      <label className="mt-2 flex cursor-pointer items-center gap-2.5">
        <button
          type="button"
          role="switch"
          aria-checked={settings.debugLLM}
          onClick={toggle}
          className={cn(
            "relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors",
            settings.debugLLM ? "bg-primary" : "bg-muted",
          )}
        >
          <span
            className={cn(
              "inline-block h-4 w-4 transform rounded-full bg-card shadow transition-transform",
              settings.debugLLM ? "translate-x-4" : "translate-x-0.5",
            )}
          />
        </button>
        <span className="text-sm text-foreground">{t("model.debugToggle")}</span>
      </label>

      <p className="mt-2 text-xs text-muted-foreground">{t("model.debugHelp")}</p>

      {settings.debugLLM && (
        <div className="mt-3 border-t border-border pt-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium text-foreground">
              {captures ? captures.entries.length : 0} {t("model.debugCapturesCount")}
            </span>
            <button
              onClick={refreshCaptures}
              disabled={loadingCaptures}
              className="flex cursor-pointer items-center gap-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", loadingCaptures && "animate-spin")} />
              {t("model.refresh")}
            </button>
          </div>
          {captures?.dir && (
            <p className="mb-2 break-all font-mono text-[0.6875rem] text-muted-foreground">{captures.dir}</p>
          )}
          {captures && captures.entries.length > 0 ? (
            <div className="max-h-40 overflow-auto rounded-md bg-background p-2">
              {captures.entries.slice(0, 10).map((name) => (
                <p key={name} className="truncate font-mono text-[0.6875rem] text-muted-foreground">
                  {name}
                </p>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">{t("model.debugNoCaptures")}</p>
          )}
        </div>
      )}
    </div>
  );
}

const PROMPT_KEYS: {
  key: keyof PromptTemplates;
  label: string;
  desc: string;
  hint?: string;
}[] = [
  {
    key: "explore",
    label: "model.promptExplore",
    desc: "model.promptExploreDesc",
    hint: "model.promptExploreHint",
  },
  {
    key: "exploreDeepPrefix",
    label: "model.promptDeepPrefix",
    desc: "model.promptDeepPrefixDesc",
  },
  {
    key: "exploreDapp",
    label: "model.promptExploreDapp",
    desc: "model.promptExploreDappDesc",
  },
  {
    key: "generateCode",
    label: "model.promptGenerateCode",
    desc: "model.promptGenerateCodeDesc",
  },
];

function PromptsCard({
  defaults,
  prompts,
  setPrompts,
  onReset,
}: {
  defaults: PromptTemplates;
  prompts: PromptTemplates;
  setPrompts: (p: PromptTemplates) => void;
  onReset: (settings: AppSettings) => void;
}) {
  const t = useT();
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [detail, setDetail] = useState("");

  // Reset-to-default is available whenever the editors differ from defaults.
  const dirty = PROMPT_KEYS.some(({ key }) => prompts[key] !== defaults[key]);
  // Track the last persisted value so Save only enables on unsaved edits.
  const [saved, setSaved] = useState<PromptTemplates>(prompts);
  const editorsDirty = PROMPT_KEYS.some(({ key }) => prompts[key] !== saved[key]);

  const save = async () => {
    setState("saving");
    setDetail("");
    try {
      const { settings } = await api.saveSettings({ prompts });
      setPrompts(settings.prompts);
      setSaved(settings.prompts);
      setState("saved");
      window.setTimeout(() => setState("idle"), 1500);
    } catch (e) {
      setState("error");
      setDetail((e as Error).message);
    }
  };

  const reset = async () => {
    setState("saving");
    setDetail("");
    try {
      const { settings } = await api.resetPrompts();
      setSaved(settings.prompts);
      onReset(settings);
      setState("saved");
      window.setTimeout(() => setState("idle"), 1500);
    } catch (e) {
      setState("error");
      setDetail((e as Error).message);
    }
  };

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="mb-1 flex items-center gap-1.5">
        <FileText className="h-4 w-4 text-muted-foreground" />
        <h2 className="font-display text-sm font-medium text-foreground">{t("model.promptsCard")}</h2>
      </div>
      <p className="mb-3 text-xs text-muted-foreground">{t("model.promptsHelp")}</p>

      <div className="space-y-4">
        {PROMPT_KEYS.map(({ key, label, desc, hint }) => {
          const modified = prompts[key] !== defaults[key];
          return (
            <div key={key}>
              <div className="mb-1 flex items-center gap-2">
                <label htmlFor={`prompt-${key}`} className="text-xs font-medium text-foreground">
                  {t(label)}
                </label>
                {modified && (
                  <span className="rounded bg-warn-soft px-1.5 py-0.5 text-[0.6875rem] font-medium text-warn">
                    {t("model.modified")}
                  </span>
                )}
              </div>
              <p className="mb-1 text-[0.6875rem] text-muted-foreground">{t(desc)}</p>
              <textarea
                id={`prompt-${key}`}
                rows={key === "exploreDeepPrefix" ? 5 : 8}
                value={prompts[key]}
                onChange={(e) => setPrompts({ ...prompts, [key]: e.target.value })}
                className="w-full resize-y rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              {hint && <p className="mt-1 text-[0.6875rem] text-muted-foreground">{t(hint)}</p>}
            </div>
          );
        })}
      </div>

      <div className="mt-4 flex items-center gap-3 border-t border-border pt-3">
        <Button variant="primary" onClick={save} disabled={state === "saving" || !editorsDirty}>
          {state === "saving" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {t("common.save")}
        </Button>
        <Button onClick={reset} disabled={state === "saving" || !dirty}>
          <RotateCcw className="h-3.5 w-3.5" />
          {t("model.resetPrompts")}
        </Button>
        {state === "saved" && (
          <span className="flex items-center gap-1.5 text-xs text-ok">
            <CheckCircle className="h-4 w-4" /> {t("model.saved")}
          </span>
        )}
        {editorsDirty && state !== "saved" && (
          <span className="text-xs text-warn">{t("model.modified")}</span>
        )}
        {state === "error" && (
          <span className="flex items-center gap-1.5 text-xs text-bad">
            <AlertTriangle className="h-4 w-4" /> {detail}
          </span>
        )}
      </div>
    </div>
  );
}

const NEW_ENV = "__new__";
type VarRow = { key: string; value: string };
type SessionInfo = { hasSession: boolean; capturedAt?: string; cookies: number };

// Turn a key→value map (values may be arrays) into editable rows; arrays show as JSON.
const toRows = (obj?: Record<string, string | string[]>): VarRow[] =>
  Object.entries(obj ?? {}).map(([key, value]) => ({
    key,
    value: Array.isArray(value) ? JSON.stringify(value) : String(value),
  }));

// Rows → map. When parseArrays, a value that is a JSON array (e.g. ["a","b"]) is stored
// as a real array so ${env.KEY.N} works and data-driven runs can iterate it later.
function rowsToMap(rows: VarRow[], parseArrays = false): Record<string, string | string[]> {
  const m: Record<string, string | string[]> = {};
  for (const { key, value } of rows) {
    const k = key.trim();
    if (!k) continue;
    if (parseArrays && value.trim().startsWith("[")) {
      try {
        const a = JSON.parse(value.trim());
        if (Array.isArray(a)) {
          m[k] = a.map(String);
          continue;
        }
      } catch {
        /* not valid JSON — treat as a plain string */
      }
    }
    m[k] = value;
  }
  return m;
}

// Parse a batch paste — a JSON object or `key=value` / `key: value` lines — into rows.
function parseBatch(text: string): Record<string, string> | null {
  const t = text.trim();
  if (!t) return null;
  try {
    const o = JSON.parse(t);
    if (o && typeof o === "object" && !Array.isArray(o)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(o)) out[k] = Array.isArray(v) ? JSON.stringify(v) : String(v);
      return out;
    }
  } catch {
    /* not JSON — fall through to line parsing */
  }
  const out: Record<string, string> = {};
  for (const line of t.split("\n")) {
    const m = line.match(/^\s*([A-Za-z0-9_.-]+)\s*[=:]\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return Object.keys(out).length ? out : null;
}

// Reusable key/value editor (used for vars, headers, and query params).
function KvEditor({
  rows,
  setRows,
  keyPh = "KEY",
  valPh = "value",
}: {
  rows: VarRow[];
  setRows: (r: VarRow[]) => void;
  keyPh?: string;
  valPh?: string;
}) {
  const t = useT();
  const set = (i: number, patch: Partial<VarRow>) =>
    setRows(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-1.5">
      {rows.map((v, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <input
            type="text"
            value={v.key}
            placeholder={keyPh}
            onChange={(e) => set(i, { key: e.target.value })}
            className="w-1/3 rounded-md border border-border bg-background px-2 py-1 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <input
            type="text"
            value={v.value}
            placeholder={valPh}
            onChange={(e) => set(i, { value: e.target.value })}
            className="flex-1 rounded-md border border-border bg-background px-2 py-1 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <button
            onClick={() => setRows(rows.filter((_, idx) => idx !== i))}
            aria-label="Remove"
            className="cursor-pointer text-muted-foreground hover:text-bad"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      <button
        onClick={() => setRows([...rows, { key: "", value: "" }])}
        className="flex cursor-pointer items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <Plus className="h-3.5 w-3.5" /> {t("common.add")}
      </button>
    </div>
  );
}

function blankApiLogin() {
  return {
    enabled: false,
    url: "",
    method: "POST",
    contentType: "application/json",
    body: "",
    tokenPath: "",
    tokenHeader: "Authorization",
  };
}

function blankEnvForm() {
  return {
    id: undefined as string | undefined,
    name: "",
    baseUrl: "",
    viewportWidth: "", viewportHeight: "",
    vars: [{ key: "", value: "" }] as VarRow[],
    headers: [] as VarRow[],
    query: [] as VarRow[],
    identityChecks: emptyIdentity(),
    authRequired: false,
    steps: "",
    apiLogin: blankApiLogin(),
    isDefault: false,
    session: null as SessionInfo | null,
  };
}

function formFromEnv(env: Environment) {
  const vars = toRows(env.vars);
  return {
    id: env.id,
    name: env.name,
    baseUrl: env.baseUrl,
    viewportWidth: String(env.viewport?.width??""), viewportHeight: String(env.viewport?.height??""),
    vars: vars.length ? vars : [{ key: "", value: "" }],
    headers: toRows(env.headers),
    query: toRows(env.query),
    identityChecks: readIdentity(env.login?.sessionChecks),
    authRequired: !!env.login?.authRequired,
    steps: (env.login?.steps ?? []).join("\n"),
    apiLogin: {
      ...blankApiLogin(),
      enabled: !!env.login?.apiLogin,
      ...(env.login?.apiLogin ?? {}),
    },
    isDefault: env.isDefault,
    session: {
      hasSession: !!env.login?.hasSession,
      capturedAt: env.login?.capturedAt,
      cookies: env.login?.sessionCookies ?? 0,
    },
  };
}

// Per-project environments: base URL, non-secret vars, optional login flow, default toggle.
export function EnvironmentsCard() {
  const t = useT();
  const projectId = useStore((s) => s.activeProjectId);
  const [envs, setEnvs] = useState<Environment[]>([]);
  const [selected, setSelected] = useState<string>(NEW_ENV);
  const [form, setForm] = useState(blankEnvForm());
  const [state, setState] = useState<"loading" | "idle" | "saving" | "error">("loading");
  const [detail, setDetail] = useState("");

  const load = useCallback(async () => {
    if (!projectId) {
      setState("idle");
      setEnvs([]);
      return;
    }
    setState("loading");
    try {
      const { environments } = await api.getEnvironments(projectId);
      setEnvs(environments);
      // Auto-select the default env (or the first one) so existing config is visible.
      const target = environments.find((e) => e.isDefault) ?? environments[0];
      if (target) {
        setSelected(target.id);
        setForm(formFromEnv(target));
      } else {
        setSelected(NEW_ENV);
        setForm(blankEnvForm());
      }
      setState("idle");
    } catch {
      setEnvs([]);
      setState("error");
      setDetail("Backend offline — start the server to manage environments.");
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const pick = (id: string) => {
    setSelected(id);
    setDetail("");
    if (id === NEW_ENV) {
      setForm(blankEnvForm());
      return;
    }
    const env = envs.find((e) => e.id === id);
    if (env) setForm(formFromEnv(env));
  };

  // Batch import (JSON object or key=value lines) → merge into data vars.
  const [batchText, setBatchText] = useState("");
  const [showBatch, setShowBatch] = useState(false);
  const importBatch = () => {
    const parsed = parseBatch(batchText);
    if (!parsed) return;
    setForm((f) => {
      const map = new Map(f.vars.filter((v) => v.key.trim()).map((v) => [v.key.trim(), v.value]));
      for (const [k, v] of Object.entries(parsed)) map.set(k, v);
      return { ...f, vars: [...map.entries()].map(([key, value]) => ({ key, value })) };
    });
    setBatchText("");
    setShowBatch(false);
  };

  // Session capture / clear (runs the login flow once → cached storageState).
  const [sessionState, setSessionState] = useState<"idle" | "capturing" | "error">("idle");
  const [sessionMsg, setSessionMsg] = useState("");
  const applySessionInfo = (env: Environment) =>
    setForm((f) => ({
      ...f,
      session: {
        hasSession: !!env.login?.hasSession,
        capturedAt: env.login?.capturedAt,
        cookies: env.login?.sessionCookies ?? 0,
      },
    }));
  const capture = async () => {
    if (!form.id) return;
    setSessionState("capturing");
    setSessionMsg("");
    try {
      const r = await api.captureSession(form.id);
      applySessionInfo(r.environment);
      setEnvs((es) => es.map((e) => (e.id === r.environment.id ? r.environment : e)));
      setSessionMsg(`${r.cookies} cookies · ${r.localStorage} localStorage`);
      setSessionState("idle");
    } catch (e) {
      setSessionState("error");
      setSessionMsg((e as Error).message);
    }
  };
  const clearSession = async () => {
    if (!form.id) return;
    try {
      const { environment } = await api.clearSession(form.id);
      applySessionInfo(environment);
      setEnvs((es) => es.map((e) => (e.id === environment.id ? environment : e)));
      setSessionMsg("");
    } catch {
      /* ignore */
    }
  };

  // Paste a session directly (cookie string or storageState JSON).
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const applyPaste = async () => {
    if (!form.id) {
      setSessionState("error");
      setSessionMsg(t("model.captureNeedsSave"));
      return;
    }
    if (!pasteText.trim()) return;
    setSessionState("capturing");
    setSessionMsg("");
    try {
      const r = await api.setSession(form.id, pasteText.trim());
      applySessionInfo(r.environment);
      setEnvs((es) => es.map((e) => (e.id === r.environment.id ? r.environment : e)));
      setSessionMsg(`${r.cookies} cookies · ${r.origins} origins`);
      setPasteText("");
      setPasteOpen(false);
      setSessionState("idle");
    } catch (e) {
      setSessionState("error");
      setSessionMsg((e as Error).message);
    }
  };

  const save = async (): Promise<Environment | null> => {
    if (!projectId || !form.name.trim()) return null;
    setState("saving");
    setDetail("");
    const a = form.apiLogin;
    const login: LoginFlow = {
      sessionChecks: writeIdentity(form.identityChecks),
      authRequired: form.authRequired,
      steps: form.authRequired
        ? form.steps
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean)
        : [],
      apiLogin:
        form.authRequired && a.enabled && a.url.trim()
          ? {
              url: a.url.trim(),
              method: a.method,
              contentType: a.contentType,
              body: a.body,
              tokenPath: a.tokenPath.trim() || undefined,
              tokenHeader: a.tokenHeader.trim() || undefined,
            }
          : null,
    };
    try {
      const { environment } = await api.saveEnvironment(projectId, {
        id: form.id,
        name: form.name.trim(),
        baseUrl: form.baseUrl.trim(),
        vars: rowsToMap(form.vars, true),
        headers: rowsToMap(form.headers) as Record<string, string>,
        query: rowsToMap(form.query) as Record<string, string>,
        login,
        isDefault: form.isDefault,
        viewport: { ...(Number(form.viewportWidth)>0?{width:Number(form.viewportWidth)}:{}), ...(Number(form.viewportHeight)>0?{height:Number(form.viewportHeight)}:{}) },
      });
      setEnvs((es) => {
        const has = es.some((e) => e.id === environment.id);
        return has ? es.map((e) => (e.id === environment.id ? environment : e)) : [...es, environment];
      });
      setSelected(environment.id);
      setForm(formFromEnv(environment));
      setState("idle");
      return environment;
    } catch (e) {
      setState("error");
      setDetail((e as Error).message);
      return null;
    }
  };

  // API-style login: save the config, then call the endpoint to capture the session.
  const [apiState, setApiState] = useState<"idle" | "running" | "error">("idle");
  const [apiMsg, setApiMsg] = useState("");
  const runApiLogin = async () => {
    setApiState("running");
    setApiMsg("");
    const saved = await save();
    if (!saved?.id) {
      setApiState("error");
      setApiMsg(t("model.captureNeedsSave"));
      return;
    }
    try {
      const r = await api.apiLogin(saved.id);
      applySessionInfo(r.environment);
      setEnvs((es) => es.map((e) => (e.id === r.environment.id ? r.environment : e)));
      setSessionMsg(`${r.cookies} cookies · ${r.token ? "token ✓" : "—"}`);
      setApiState("idle");
    } catch (e) {
      setApiState("error");
      setApiMsg((e as Error).message);
    }
  };

  const remove = async () => {
    if (!form.id) return;
    setState("saving");
    try {
      await api.deleteEnvironment(form.id);
      setSelected(NEW_ENV);
      setForm(blankEnvForm());
      await load();
      setState("idle");
    } catch (e) {
      setState("error");
      setDetail((e as Error).message);
    }
  };

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="mb-1 flex items-center gap-1.5">
        <Boxes className="h-4 w-4 text-muted-foreground" />
        <h2 className="font-display text-sm font-medium text-foreground">{t("model.environments")}</h2>
      </div>
      <p className="mb-3 text-xs text-muted-foreground">{t("model.environmentsHelp")}</p>

      {!projectId ? (
        <p className="rounded-md border border-dashed border-border p-3 text-center text-xs text-muted-foreground">
          <NeedProject />
        </p>
      ) : (
        <div className="space-y-3">
          <div>
            <label htmlFor="envPick" className="mb-1 block text-xs text-muted-foreground">
              {t("model.environment")}
            </label>
            <select
              id="envPick"
              value={selected}
              onChange={(e) => pick(e.target.value)}
              className="w-full cursor-pointer rounded-md border border-border bg-background px-2.5 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value={NEW_ENV}>{t("model.newEnvironment")}</option>
              {envs.map((env) => (
                <option key={env.id} value={env.id}>
                  {env.name}
                  {env.isDefault ? ` (${t("model.default")})` : ""}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="envName" className="mb-1 block text-xs text-muted-foreground">
              {t("model.name")}
            </label>
            <input
              id="envName"
              type="text"
              value={form.name}
              placeholder="staging"
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>

          <div>
            <label htmlFor="envBaseUrl" className="mb-1 block text-xs text-muted-foreground">
              {t("model.baseUrl")}
            </label>
            <input
              id="envBaseUrl"
              type="text"
              value={form.baseUrl}
              placeholder="https://staging.acme.com"
              onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))}
              className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>

          <SessionEvidenceFields value={form.identityChecks} onChange={identityChecks=>setForm(f=>({...f,identityChecks}))}/>
          <fieldset className="grid grid-cols-2 gap-3"><legend className="mb-2 text-xs text-muted-foreground">{t('bench.viewport')}</legend><label className="text-xs">{t('bench.viewportWidth')}<input id="envViewportWidth" type="number" min={320} max={7680} placeholder="1024" value={form.viewportWidth} onChange={e=>setForm(f=>({...f,viewportWidth:e.target.value}))} className="mt-1 w-full rounded border border-border bg-background px-3 py-2"/></label><label className="text-xs">{t('bench.viewportHeight')}<input id="envViewportHeight" type="number" min={240} max={4320} placeholder="768" value={form.viewportHeight} onChange={e=>setForm(f=>({...f,viewportHeight:e.target.value}))} className="mt-1 w-full rounded border border-border bg-background px-3 py-2"/></label></fieldset>

          {/* Test data (non-secret vars) — batch import + array support */}
          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-xs text-muted-foreground">{t("model.varsNonSecret")}</span>
              <button
                onClick={() => setShowBatch((s) => !s)}
                className="flex cursor-pointer items-center gap-1 text-xs text-primary hover:underline"
              >
                <FileText className="h-3.5 w-3.5" /> {t("model.batchImport")}
              </button>
            </div>
            {showBatch && (
              <div className="mb-2 rounded-md border border-border bg-background p-2">
                <textarea
                  rows={4}
                  value={batchText}
                  onChange={(e) => setBatchText(e.target.value)}
                  placeholder={
                    '{"USER":"alice","terms": ["a","b","c"] }\n— or —\nUSER=alice\nterms=["a","b","c"]'
                  }
                  className="w-full rounded border border-border bg-card px-2 py-1 font-mono text-[0.6875rem] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
                <div className="mt-1.5 flex items-center gap-2">
                  <Button
                    variant="primary"
                    className="text-xs"
                    onClick={importBatch}
                    disabled={!batchText.trim()}
                  >
                    {t("model.import")}
                  </Button>
                  <span className="text-[0.6875rem] text-muted-foreground">{t("model.batchImportHelp")}</span>
                </div>
              </div>
            )}
            <KvEditor
              rows={form.vars}
              setRows={(vars) => setForm((f) => ({ ...f, vars }))}
              valPh='value or ["a","b"]'
            />
          </div>

          {/* Fixed request headers — pass the site's own checks (auth, feature flags, bot bypass) */}
          <div>
            <span className="mb-1 block text-xs text-muted-foreground">{t("model.headers")}</span>
            <KvEditor
              rows={form.headers}
              setRows={(headers) => setForm((f) => ({ ...f, headers }))}
              keyPh="X-Automation-Test"
              valPh="true  ·  Bearer ${secret.TOKEN}"
            />
            <p className="mt-1 text-[0.6875rem] text-muted-foreground">{t("model.headersHelp")}</p>
          </div>

          {/* Fixed query-string params appended to every navigation */}
          <div>
            <span className="mb-1 block text-xs text-muted-foreground">{t("model.queryParams")}</span>
            <KvEditor
              rows={form.query}
              setRows={(query) => setForm((f) => ({ ...f, query }))}
              keyPh="e2e"
              valPh="1"
            />
            <p className="mt-1 text-[0.6875rem] text-muted-foreground">{t("model.queryHelp")}</p>
          </div>

          <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={form.authRequired}
              onChange={(e) => setForm((f) => ({ ...f, authRequired: e.target.checked }))}
              className="h-3.5 w-3.5 cursor-pointer"
            />
            {t("model.requiresLogin")}
          </label>

          {form.authRequired && (
            <div>
              <label htmlFor="envSteps" className="mb-1 block text-xs text-muted-foreground">
                {t("model.loginFlow")}
              </label>
              <textarea
                id="envSteps"
                rows={4}
                value={form.steps}
                placeholder={
                  "Open ${env.BASE_URL}/login\nType ${env.USER} into the email field\nType ${secret.PASSWORD} into the password field\nClick Sign in"
                }
                onChange={(e) => setForm((f) => ({ ...f, steps: e.target.value }))}
                className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <p className="mt-1 text-[0.6875rem] text-muted-foreground">
                {t("model.placeholderReferences")} <code className="font-mono">{"${env.KEY}"}</code>{" "}
                {t("model.andPlaceholders")} <code className="font-mono">{"${secret.KEY}"}</code>{" "}
                {t("model.placeholders")}
              </p>

              {/* Session capture: run the login flow once, cache storageState, skip login on runs */}
              <div className="mt-3 rounded-md border border-border bg-background p-2.5">
                <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                  <KeyRound className="h-3.5 w-3.5 text-muted-foreground" /> {t("model.session")}
                </div>
                <p className="mt-1 text-[0.6875rem] leading-snug text-muted-foreground">
                  {t("model.sessionHelp")}
                </p>
                {form.session?.hasSession ? (
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                    <span className="rounded bg-ok-soft px-1.5 py-0.5 text-ok">
                      {t("model.sessionCaptured")} · {form.session.cookies} cookies
                    </span>
                    {form.session.capturedAt && (
                      <span className="text-muted-foreground">
                        {new Date(form.session.capturedAt).toLocaleString()}
                      </span>
                    )}
                  </div>
                ) : (
                  <p className="mt-2 text-[0.6875rem] text-muted-foreground">{t("model.noSession")}</p>
                )}
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Button
                    variant="primary"
                    className="bg-chat text-xs hover:bg-chat"
                    onClick={capture}
                    disabled={!form.id || sessionState === "capturing"}
                    title={!form.id ? t("model.captureNeedsSave") : undefined}
                  >
                    {sessionState === "capturing" ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <KeyRound className="h-3.5 w-3.5" />
                    )}
                    {form.session?.hasSession ? t("model.recapture") : t("model.captureSession")}
                  </Button>
                  {form.session?.hasSession && (
                    <Button className="text-xs" onClick={clearSession}>
                      <Trash2 className="h-3.5 w-3.5" /> {t("model.clearSession")}
                    </Button>
                  )}
                  {!form.id && <span className="text-[0.6875rem] text-warn">{t("model.captureNeedsSave")}</span>}
                  {sessionMsg && (
                    <span
                      className={cn(
                        "text-[0.6875rem]",
                        sessionState === "error" ? "text-bad" : "text-muted-foreground",
                      )}
                    >
                      {sessionMsg}
                    </span>
                  )}
                </div>

                {/* Paste a session directly (method B): a cookie string or storageState JSON */}
                <div className="mt-2 border-t border-border pt-2">
                  <button
                    onClick={() => setPasteOpen((o) => !o)}
                    className="flex cursor-pointer items-center gap-1 text-[0.6875rem] text-primary hover:underline"
                  >
                    <ClipboardPaste className="h-3 w-3" /> {t("model.pasteSession")}
                  </button>
                  {pasteOpen && (
                    <div className="mt-1.5">
                      <textarea
                        rows={3}
                        value={pasteText}
                        onChange={(e) => setPasteText(e.target.value)}
                        placeholder={t("model.pasteSessionPlaceholder")}
                        className="w-full rounded border border-border bg-card px-2 py-1 font-mono text-[0.6875rem] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      />
                      <div className="mt-1.5 flex flex-wrap items-center gap-2">
                        <Button
                          variant="primary"
                          className="text-xs"
                          onClick={applyPaste}
                          disabled={!pasteText.trim() || sessionState === "capturing"}
                        >
                          {t("model.applySession")}
                        </Button>
                        <span className="text-[0.6875rem] text-muted-foreground">
                          {t("model.pasteSessionHelp")}
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* API-style login (method C): capture the session via an HTTP call, no UI driving */}
              <div className="mt-2 rounded-md border border-border bg-background p-2.5">
                <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-foreground">
                  <input
                    type="checkbox"
                    checked={form.apiLogin.enabled}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, apiLogin: { ...f.apiLogin, enabled: e.target.checked } }))
                    }
                    className="h-3.5 w-3.5 cursor-pointer"
                  />
                  <Server className="h-3.5 w-3.5 text-muted-foreground" /> {t("model.apiLogin")}
                </label>
                <p className="mt-1 text-[0.6875rem] leading-snug text-muted-foreground">
                  {t("model.apiLoginHelp")}
                </p>
                {form.apiLogin.enabled && (
                  <div className="mt-2 space-y-1.5">
                    <div className="flex gap-1.5">
                      <select
                        value={form.apiLogin.method}
                        onChange={(e) =>
                          setForm((f) => ({ ...f, apiLogin: { ...f.apiLogin, method: e.target.value } }))
                        }
                        className="w-20 rounded border border-border bg-card px-1.5 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <option>POST</option>
                        <option>GET</option>
                        <option>PUT</option>
                      </select>
                      <input
                        value={form.apiLogin.url}
                        onChange={(e) =>
                          setForm((f) => ({ ...f, apiLogin: { ...f.apiLogin, url: e.target.value } }))
                        }
                        placeholder="https://api.site.com/login"
                        className="flex-1 rounded border border-border bg-card px-2 py-1 font-mono text-[0.6875rem] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      />
                    </div>
                    <textarea
                      rows={3}
                      value={form.apiLogin.body}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, apiLogin: { ...f.apiLogin, body: e.target.value } }))
                      }
                      placeholder={'{"username":"${env.USER}","password":"${secret.PASSWORD}"}'}
                      className="w-full rounded border border-border bg-card px-2 py-1 font-mono text-[0.6875rem] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />
                    <div className="flex gap-1.5">
                      <input
                        value={form.apiLogin.tokenPath}
                        onChange={(e) =>
                          setForm((f) => ({ ...f, apiLogin: { ...f.apiLogin, tokenPath: e.target.value } }))
                        }
                        placeholder={t("model.apiTokenPath")}
                        className="flex-1 rounded border border-border bg-card px-2 py-1 font-mono text-[0.6875rem] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      />
                      <input
                        value={form.apiLogin.tokenHeader}
                        onChange={(e) =>
                          setForm((f) => ({ ...f, apiLogin: { ...f.apiLogin, tokenHeader: e.target.value } }))
                        }
                        placeholder="Authorization"
                        className="w-32 rounded border border-border bg-card px-2 py-1 font-mono text-[0.6875rem] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      />
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        variant="primary"
                        className="bg-chat text-xs hover:bg-chat"
                        onClick={runApiLogin}
                        disabled={!form.apiLogin.url.trim() || apiState === "running"}
                      >
                        {apiState === "running" ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Server className="h-3.5 w-3.5" />
                        )}
                        {t("model.runApiLogin")}
                      </Button>
                      {apiMsg && (
                        <span
                          className={cn(
                            "text-[0.6875rem]",
                            apiState === "error" ? "text-bad" : "text-muted-foreground",
                          )}
                        >
                          {apiMsg}
                        </span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={form.isDefault}
              onChange={(e) => setForm((f) => ({ ...f, isDefault: e.target.checked }))}
              className="h-3.5 w-3.5 cursor-pointer"
            />
            {t("model.defaultEnvironment")}
          </label>

          <div className="flex items-center gap-3 pt-1">
            <Button
              variant="primary"
              onClick={save}
              disabled={state === "saving" || state === "loading" || !form.name.trim()}
            >
              {state === "saving" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {t("model.saveEnvironment")}
            </Button>
            {form.id && (
              <Button onClick={remove} disabled={state === "saving"}>
                <Trash2 className="h-3.5 w-3.5" />
                {t("common.delete")}
              </Button>
            )}
            {state === "error" && (
              <span className="flex items-center gap-1.5 text-xs text-bad">
                <AlertTriangle className="h-4 w-4" /> {detail}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// Per-project secrets. Values are write-only: the backend never returns them,
// so we only ever list keys + updatedAt.
export function SecretsCard() {
  const t = useT();
  const projectId = useStore((s) => s.activeProjectId);
  const [secrets, setSecrets] = useState<SecretMeta[]>([]);
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [state, setState] = useState<"loading" | "idle" | "saving" | "error">("loading");
  const [detail, setDetail] = useState("");

  const load = useCallback(async () => {
    if (!projectId) {
      setState("idle");
      setSecrets([]);
      return;
    }
    setState("loading");
    try {
      const { secrets } = await api.getSecrets(projectId);
      setSecrets(secrets);
      setState("idle");
    } catch {
      setSecrets([]);
      setState("error");
      setDetail("Backend offline — start the server to manage secrets.");
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!projectId || !key.trim() || !value) return;
    setState("saving");
    setDetail("");
    try {
      await api.setSecret(projectId, key.trim(), value);
      setKey("");
      setValue("");
      await load();
      setState("idle");
    } catch (e) {
      setState("error");
      setDetail((e as Error).message);
    }
  };

  const remove = async (k: string) => {
    if (!projectId) return;
    setState("saving");
    try {
      await api.deleteSecret(projectId, k);
      await load();
      setState("idle");
    } catch (e) {
      setState("error");
      setDetail((e as Error).message);
    }
  };

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="mb-1 flex items-center gap-1.5">
        <KeyRound className="h-4 w-4 text-muted-foreground" />
        <h2 className="font-display text-sm font-medium text-foreground">{t("model.secrets")}</h2>
      </div>
      <p className="mb-3 flex items-start gap-1.5 text-xs text-muted-foreground">
        <Lock className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
        {t("model.secretsHelp")} <code className="font-mono">{"${secret.KEY}"}</code>.
      </p>

      {!projectId ? (
        <p className="rounded-md border border-dashed border-border p-3 text-center text-xs text-muted-foreground">
          <NeedProject />
        </p>
      ) : (
        <div className="space-y-3">
          <div className="space-y-1.5">
            {state === "loading" ? (
              <p className="text-xs text-muted-foreground">{t("common.loading")}</p>
            ) : secrets.length === 0 ? (
              <p className="rounded-md border border-dashed border-border p-3 text-center text-xs text-muted-foreground">
                {t("model.noSecrets")}
              </p>
            ) : (
              secrets.map((s) => (
                <div
                  key={s.id}
                  className="flex items-center gap-2 rounded-md border border-border bg-background px-2.5 py-1.5"
                >
                  <KeyRound className="h-3.5 w-3.5 text-muted-foreground" />
                  <code className="flex-1 truncate font-mono text-xs text-foreground">{s.key}</code>
                  <span className="font-mono text-[0.6875rem] text-muted-foreground">••••••</span>
                  <span className="text-[0.6875rem] text-muted-foreground">
                    {new Date(s.updatedAt).toLocaleDateString()}
                  </span>
                  <button
                    onClick={() => remove(s.key)}
                    aria-label={`Delete secret ${s.key}`}
                    className="cursor-pointer text-muted-foreground hover:text-bad"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))
            )}
          </div>

          <div className="flex items-end gap-1.5 border-t border-border pt-3">
            <div className="w-1/3">
              <label htmlFor="secretKey" className="mb-1 block text-xs text-muted-foreground">
                {t("model.key")}
              </label>
              <input
                id="secretKey"
                type="text"
                value={key}
                placeholder="PASSWORD"
                onChange={(e) => setKey(e.target.value)}
                className="w-full rounded-md border border-border bg-background px-2 py-1 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>
            <div className="flex-1">
              <label htmlFor="secretValue" className="mb-1 block text-xs text-muted-foreground">
                {t("model.valueWriteOnly")}
              </label>
              <input
                id="secretValue"
                type="password"
                value={value}
                placeholder="••••••••"
                autoComplete="new-password"
                onChange={(e) => setValue(e.target.value)}
                className="w-full rounded-md border border-border bg-background px-2 py-1 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>
            <Button variant="primary" onClick={save} disabled={state === "saving" || !key.trim() || !value}>
              {state === "saving" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {t("common.save")}
            </Button>
          </div>

          {state === "error" && (
            <span className="flex items-center gap-1.5 text-xs text-bad">
              <AlertTriangle className="h-4 w-4" /> {detail}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
