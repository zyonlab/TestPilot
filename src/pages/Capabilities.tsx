import { useEffect, useState } from "react";
import { Boxes, Play, Square, Send, Save, Sparkles } from "lucide-react";
import { TopBar } from "@/components/TopBar";
import { Button } from "@/components/ui";
import { useT } from "@/lib/prefs";
import { useProcs } from "@/lib/procs";
import { cn } from "@/lib/cn";
import { API_BASE } from "@/lib/base";

/**
 * Capabilities, and the chat that drafts them.
 *
 * The two belong on one page because they are two halves of the same act: a capability is
 * an external service this machine will run, and the way you get one is to ask for it and
 * then read what came back. The chat produces a draft and nothing else — save is a separate
 * press, start is another, and neither button exists until the gateway says the draft
 * validates. A model that writes a command line is fine; a model that runs one is not.
 */

const API = API_BASE;

interface Capability {
  id: string;
  kind: string;
  description?: string;
  command: string;
  args?: string[];
  autostart?: boolean;
  healthcheck?: Record<string, unknown>;
  status?: { state: string; pid?: number; healthy?: boolean } | null;
}

interface Draft {
  kind: "capability" | "graph" | "prompt";
  value: unknown;
  valid: boolean;
  issues: string[];
  /** Valid, but it would change more than you asked for. */
  warnings?: string[];
  diff?: string[];
  target?: string;
}

interface Turn {
  role: "user" | "assistant";
  text: string;
}

type Intent = "capability" | "graph" | "prompt" | "ask";

const INTENTS: Intent[] = ["capability", "graph", "prompt", "ask"];

function CapabilityCard({ c, onAct }: { c: Capability; onAct: (action: "start" | "stop") => void }) {
  const t = useT();
  const state = c.status?.state ?? "idle";
  const running = state === "alive" || state === "spawning";
  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <div className="flex items-center gap-2">
        <span className="font-display text-[14px] font-medium text-foreground">{c.id}</span>
        <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">{c.kind}</span>
        <span
          className={cn(
            "rounded px-1.5 py-0.5 text-[11px]",
            running ? "bg-emerald-500/15 text-emerald-600" : "bg-muted text-muted-foreground",
          )}
        >
          {state}
          {c.status?.pid ? ` · pid ${c.status.pid}` : ""}
        </span>
        <span className="ml-auto flex gap-1">
          {running ? (
            <Button onClick={() => onAct("stop")}>
              <Square className="h-3.5 w-3.5" />
              {t("cap.stop")}
            </Button>
          ) : (
            <Button variant="primary" onClick={() => onAct("start")}>
              <Play className="h-3.5 w-3.5" />
              {t("cap.start")}
            </Button>
          )}
        </span>
      </div>
      {c.description && <div className="mt-1 text-[12px] text-muted-foreground">{c.description}</div>}
      <div className="mt-1 font-mono text-[11px] text-muted-foreground">
        {c.command} {(c.args ?? []).join(" ")}
      </div>
      <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
        {/* Readiness, not liveness: a chain holds its port open before it answers RPC. */}
        {c.healthcheck ? `health: ${JSON.stringify(c.healthcheck)}` : t("cap.noHealthcheck")}
      </div>
    </div>
  );
}

export function CapabilitiesPage() {
  const t = useT();
  const act = useProcs((s) => s.act);
  const [caps, setCaps] = useState<Capability[]>([]);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [intent, setIntent] = useState<Intent>("capability");
  const [graphId, setGraphId] = useState("");
  const [graphs, setGraphs] = useState<string[]>([]);
  const [promptKey, setPromptKey] = useState("explore");
  const [promptKeys, setPromptKeys] = useState<string[]>([]);
  const [draft, setDraft] = useState<Draft | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  const load = async () => {
    try {
      const [c, g, s] = await Promise.all([
        fetch(`${API}/api/capabilities`).then((r) => r.json()) as Promise<{ capabilities: Capability[] }>,
        fetch(`${API}/api/graphs`).then((r) => r.json()) as Promise<{ graphs: Array<{ id: string }> }>,
        fetch(`${API}/api/settings`).then((r) => r.json()) as Promise<{ defaults: Record<string, string> }>,
      ]);
      setCaps(c.capabilities);
      setGraphs(g.graphs.map((x) => x.id));
      setGraphId((prev) => prev || g.graphs[0]?.id || "");
      setPromptKeys(Object.keys(s.defaults ?? {}));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    const next = [...turns, { role: "user" as const, text }];
    setTurns(next);
    setInput("");
    setBusy(true);
    setError("");
    setDraft(undefined);
    try {
      const res = await fetch(`${API}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: next, intent, graphId, promptKey }),
      });
      const body = (await res.json()) as { reply?: string; draft?: Draft; error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setTurns([...next, { role: "assistant", text: body.reply ?? "" }]);
      setDraft(body.draft);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /** Save. Only reachable for a draft the gateway called valid — and it re-checks anyway. */
  const save = async () => {
    if (!draft?.valid) return;
    setBusy(true);
    setError("");
    try {
      const path =
        draft.kind === "capability"
          ? "/api/capabilities"
          : draft.kind === "graph"
            ? "/api/chat/apply-graph"
            : "/api/chat/apply-prompt";
      const body =
        draft.kind === "capability"
          ? { recipe: draft.value }
          : draft.kind === "graph"
            ? { graph: draft.value, note: note || "from chat" }
            : { key: draft.target, prompt: draft.value };
      const res = await fetch(`${API}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const parsed = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(parsed.error ?? `HTTP ${res.status}`);
      setDraft(undefined);
      setTurns((prev) => [...prev, { role: "assistant", text: t("cap.saved") }]);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <TopBar />
      <div className="flex h-[calc(100vh-52px)] min-h-0">
        <div className="min-w-0 flex-1 overflow-auto p-4">
          <h1 className="flex items-center gap-2 font-display text-lg font-medium text-foreground">
            <Boxes className="h-5 w-5 text-primary" />
            {t("nav.capabilities")}
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{t("cap.subtitle")}</p>
          {error && <p className="mt-1 text-[12px] text-rose-500">{error}</p>}
          <div className="mt-3 space-y-2">
            {caps.map((c) => (
              <CapabilityCard key={c.id} c={c} onAct={(a) => void act(c.id, a).then(load)} />
            ))}
            {caps.length === 0 && <p className="text-[12px] text-muted-foreground">{t("cap.none")}</p>}
          </div>
        </div>

        <aside className="flex w-[460px] flex-col border-l border-border">
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
            <Sparkles className="h-4 w-4 text-primary" />
            <span className="font-display text-sm font-medium text-foreground">{t("cap.chat")}</span>
            <select
              className="rounded-md border border-border bg-card px-2 py-1 text-[12px]"
              value={intent}
              onChange={(e) => setIntent(e.target.value as Intent)}
            >
              {INTENTS.map((i) => (
                <option key={i} value={i}>
                  {t(`cap.intent.${i}`)}
                </option>
              ))}
            </select>
            {intent === "graph" && (
              <select
                className="rounded-md border border-border bg-card px-2 py-1 text-[12px]"
                value={graphId}
                onChange={(e) => setGraphId(e.target.value)}
              >
                {graphs.map((g) => (
                  <option key={g} value={g}>
                    {g}
                  </option>
                ))}
              </select>
            )}
            {intent === "prompt" && (
              <select
                className="rounded-md border border-border bg-card px-2 py-1 text-[12px]"
                value={promptKey}
                onChange={(e) => setPromptKey(e.target.value)}
              >
                {promptKeys.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            )}
          </div>

          <div className="min-h-0 flex-1 space-y-2 overflow-auto p-3">
            {turns.length === 0 && <p className="text-[12px] text-muted-foreground">{t("cap.chatHint")}</p>}
            {turns.map((m, i) => (
              <div
                key={i}
                className={cn(
                  "rounded-lg px-2.5 py-1.5 text-[12px]",
                  m.role === "user" ? "bg-primary/10 text-foreground" : "bg-muted text-foreground",
                )}
              >
                {m.text}
              </div>
            ))}

            {draft && (
              <div
                className={cn(
                  "rounded-lg border p-2",
                  draft.valid ? "border-emerald-300" : "border-rose-300",
                )}
              >
                <div className="mb-1 text-[11px] font-medium text-muted-foreground">
                  {t("cap.draft")} · {draft.kind}
                  {draft.target ? ` · ${draft.target}` : ""}
                </div>
                <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-2 font-mono text-[10px] text-muted-foreground">
                  {typeof draft.value === "string" ? draft.value : JSON.stringify(draft.value, null, 2)}
                </pre>
                {draft.issues.length > 0 && (
                  <ul className="mt-1 space-y-0.5">
                    {draft.issues.map((i, k) => (
                      <li key={k} className="text-[11px] text-rose-600">
                        {i}
                      </li>
                    ))}
                  </ul>
                )}
                {/* Valid is not the same as harmless: a draft that validates can still be
                    dropping settings it was never asked to touch. */}
                {draft.warnings && draft.warnings.length > 0 && (
                  <ul className="mt-1 space-y-0.5">
                    {draft.warnings.map((w, k) => (
                      <li key={k} className="text-[11px] text-amber-600">
                        {w}
                      </li>
                    ))}
                  </ul>
                )}
                {draft.diff && draft.diff.length > 0 && (
                  <pre className="mt-1 max-h-28 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 font-mono text-[10px] text-muted-foreground">
                    {draft.diff.join("\n")}
                  </pre>
                )}
                {/* The assertion this page exists to satisfy: no save button until it validates. */}
                {draft.valid ? (
                  <div className="mt-2 flex items-center gap-2">
                    {draft.kind === "graph" && (
                      <input
                        className="min-w-0 flex-1 rounded border border-border bg-card px-2 py-1 text-[11px]"
                        placeholder={t("cap.notePlaceholder")}
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                      />
                    )}
                    <Button variant="primary" disabled={busy} onClick={() => void save()}>
                      <Save className="h-3.5 w-3.5" />
                      {t("cap.save")}
                    </Button>
                  </div>
                ) : (
                  <p className="mt-1 text-[10px] text-muted-foreground">{t("cap.invalidHint")}</p>
                )}
              </div>
            )}
          </div>

          <div className="flex items-end gap-2 border-t border-border p-2">
            <textarea
              className="h-16 min-w-0 flex-1 resize-none rounded-md border border-border bg-card px-2 py-1 text-[12px]"
              value={input}
              placeholder={t("cap.inputPlaceholder")}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send();
              }}
            />
            <Button variant="primary" disabled={busy || !input.trim()} onClick={() => void send()}>
              <Send className="h-3.5 w-3.5" />
              {busy ? t("cap.thinking") : t("cap.send")}
            </Button>
          </div>
        </aside>
      </div>
    </>
  );
}
