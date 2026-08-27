import { useEffect, useState } from "react";
import { FlaskConical, Play, Lightbulb, RefreshCw, FileCode2 } from "lucide-react";
import { TopBar } from "@/components/TopBar";
import { Button } from "@/components/ui";
import { useT } from "@/lib/prefs";
import { cn } from "@/lib/cn";
import { useWf } from "@/lib/wf";
import { API_BASE } from "@/lib/base";

/**
 * Paired evaluation.
 *
 * Two arms of the same graph, differing by one switch, scored against the same checklist
 * and subtracted. The page shows both numbers and the significance reading side by side,
 * because a delta without "could this be chance" is not a result.
 */

const API = API_BASE;

interface ArmResult {
  label: string;
  wfRunId: string;
  ablate: string[];
  params?: Record<string, Record<string, unknown>>;
  graphVersion?: number;
  prompts?: { combined: string; entries: Record<string, string> };
  status: string;
  coverage: number;
  heldOutCoverage: number;
  cases: number;
  gateScore?: number;
  spend: { calls: number; tokens: number; ms: number };
}

interface EvalResult {
  id: string;
  graphId: string;
  gold: string;
  // An evaluation that failed or was interrupted has arms and no verdict: it never got to
  // the subtraction. Optional here rather than pretended-present, because the page used to
  // read straight through and take the whole route down with it.
  a?: ArmResult;
  b?: ArmResult;
  mcnemar?: { aOnly: number; bOnly: number; p: number; reading: string };
  costDelta?: { calls: number; tokens: number; ms: number };
  startedAt: string;
  finishedAt?: string;
  note?: string;
  error?: string;
  /** 出自 evals/ 里的哪份定义。界面上临时拼的一次评测没有。 */
  spec?: { id: string; title: string; why: string; path: string };
  /** 跑之前写下的预判，以及它对上了没有。不是通过/失败——见 eval.predictionWhy。 */
  prediction?: {
    expected: "a-better" | "b-better" | "no-difference" | "unknown";
    observed: "a-better" | "b-better" | "no-difference";
    significant: boolean;
    matched?: boolean;
  };
}

interface Suggestion {
  /** Set when the proposal broke a standing rule — shown, not hidden. */
  inadmissible?: string;
  title: string;
  target: string;
  change: string;
  evidence: string;
  test: { kind: string; handle?: string };
  expectedEffect?: string;
}

interface Critique {
  id: string;
  at: string;
  runs: string[];
  suggestions: Suggestion[];
  testable: number;
}

/**
 * A fault-injection evaluation, which is a different question from the paired one.
 *
 * Paired asks "is this version of the harness better at writing cases". This asks "does the
 * suite it wrote actually catch a bug" — the suite is run against the healthy build and then
 * against each injected fault. Two numbers matter and they pull in opposite directions:
 * **mutation score** (how many injected faults were noticed) and **false-alarm rate** (how
 * many cases failed on the build with nothing wrong with it). A suite that fails everything
 * scores 100% on the first and is worthless.
 *
 * It was already computed and stored — `server/src/evals.ts` writes these rows into the same
 * table — and the page listed them but rendered them as broken paired evals, because it read
 * every row as an A/B result and found no arms.
 */
interface DetectionResult {
  id: string;
  wfRunId: string;
  falseAlarms: string[];
  falseAlarmRate: number;
  mutants: Array<{ defect: string; title: string; killed: boolean; killedBy: string[]; ran: number }>;
  mutationScore: number;
  cases: number;
  note?: string;
  startedAt: string;
  finishedAt?: string;
}

/** A detection row has mutants; a paired row has arms. That is the whole discriminator. */
const isDetection = (e: unknown): e is DetectionResult =>
  !!e && Array.isArray((e as DetectionResult).mutants);

function DetectionCard({ d }: { d: DetectionResult }) {
  const t = useT();
  const killed = d.mutants.filter((m) => m.killed).length;
  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-xl border border-border bg-card p-3">
          <div className="font-display text-sm font-medium">{t("detect.mutationScore")}</div>
          <div
            className={cn(
              "mt-1 font-mono text-2xl tabular-nums",
              d.mutationScore >= 0.8 ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400",
            )}
          >
            {pct(d.mutationScore)}
          </div>
          <div className="mt-0.5 text-[11.5px] text-muted-foreground">
            {t("detect.killedOf").replace("{k}", String(killed)).replace("{n}", String(d.mutants.length))}
          </div>
        </div>
        <div className="rounded-xl border border-border bg-card p-3">
          <div className="font-display text-sm font-medium">{t("detect.falseAlarm")}</div>
          <div
            className={cn(
              "mt-1 font-mono text-2xl tabular-nums",
              d.falseAlarmRate === 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400",
            )}
          >
            {pct(d.falseAlarmRate)}
          </div>
          <div className="mt-0.5 text-[11.5px] text-muted-foreground">
            {t("detect.falseAlarmWhy").replace("{n}", String(d.cases))}
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card">
        <div className="border-b border-border px-3 py-2 font-display text-sm font-medium">{t("detect.mutants")}</div>
        {d.mutants.map((m) => (
          <div key={m.defect} className="flex items-baseline gap-2 border-b border-border/50 px-3 py-1.5 text-[12.5px] last:border-0">
            <span
              className={cn(
                "rounded px-1.5 py-0.5 text-[10.5px] font-medium",
                m.killed
                  ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
                  : "bg-rose-500/15 text-rose-700 dark:text-rose-400",
              )}
            >
              {m.killed ? t("detect.killed") : t("detect.survived")}
            </span>
            <span className="font-mono text-[11px] text-muted-foreground">{m.defect}</span>
            <span className="min-w-0 flex-1 truncate">{m.title}</span>
            <span className="whitespace-nowrap font-mono text-[10.5px] text-muted-foreground">
              {m.killed ? m.killedBy.join(" · ").slice(0, 60) : t("detect.nobodyNoticed").replace("{n}", String(m.ran))}
            </span>
          </div>
        ))}
      </div>

      {d.falseAlarms.length > 0 && (
        <div className="rounded-xl border border-rose-500/30 bg-card p-3 text-[12.5px]">
          <div className="font-medium text-rose-600 dark:text-rose-400">{t("detect.falseAlarmList")}</div>
          {d.falseAlarms.map((c) => (
            <div key={c} className="font-mono text-[11.5px] text-muted-foreground">{c}</div>
          ))}
        </div>
      )}

      {d.note && <p className="rounded-lg bg-muted p-3 text-[12px] leading-relaxed text-muted-foreground">{d.note}</p>}
    </div>
  );
}

interface EvalRow {
  id: string;
  graphId: string;
  status: string;
  startedAt: string;
  finishedAt?: string;
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

function ArmCard({ arm }: { arm: ArmResult }) {
  const t = useT();
  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <div className="flex items-center justify-between">
        <span className="font-display text-sm font-medium text-foreground">{arm.label}</span>
        <span className="font-mono text-[11px] text-muted-foreground">{arm.status}</span>
      </div>
      <div className="mt-1 text-[11px] text-muted-foreground">
        {arm.ablate.length ? `ablate: ${arm.ablate.join(", ")}` : t("eval.noAblation")}
        {/* What made this arm different has to be readable on the result itself, or a
            report six weeks old is a pair of numbers with no settings attached. */}
        {arm.params && Object.keys(arm.params).length > 0 && (
          <span className="ml-2 font-mono">params: {JSON.stringify(arm.params)}</span>
        )}
        {arm.graphVersion !== undefined && <span className="ml-2 font-mono">v{arm.graphVersion}</span>}
        {/* The version pins the shape; this pins what the model was told. */}
        {arm.prompts && <span className="ml-2 font-mono" title={t("eval.promptsHint")}>prompts {arm.prompts.combined}</span>}
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 font-mono text-[12px]">
        <div>
          <div className="text-[10px] text-muted-foreground">coverage</div>
          <div className="text-foreground">{pct(arm.coverage)}</div>
        </div>
        <div>
          <div className="text-[10px] text-muted-foreground">held-out</div>
          <div className="text-foreground">{pct(arm.heldOutCoverage)}</div>
        </div>
        <div>
          <div className="text-[10px] text-muted-foreground">cases</div>
          <div className="text-foreground">{arm.cases}</div>
        </div>
        <div>
          <div className="text-[10px] text-muted-foreground">cost</div>
          <div className="text-foreground">
            {arm.spend.calls} calls · {arm.spend.tokens} tok
          </div>
        </div>
      </div>
    </div>
  );
}

/** 一份仓库里的评测定义，如网关返回的那样。 */
interface EvalSpecRow {
  id: string;
  title: string;
  why: string;
  path: string;
  graphId: string;
  a: { label: string };
  b: { label: string };
  expect?: { direction: "a-better" | "b-better" | "no-difference" | "unknown"; note: string };
}

export function EvalsPage() {
  const t = useT();
  const { graphs, load } = useWf();
  const [rows, setRows] = useState<EvalRow[]>([]);
  const [current, setCurrent] = useState<EvalResult | undefined>();
  const [ablatable, setAblatable] = useState<string[]>([]);
  const [graphId, setGraphId] = useState("g1-text-cases");
  const [armB, setArmB] = useState<string[]>([]);
  // The other way two arms can differ: one parameter. Ablation switches turn a component
  // off; this is for "the same harness with a different setting", which is most of the
  // questions this project actually asks.
  const [paramsB, setParamsB] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // What an evaluation of this graph would be scored against, shown before running one:
  // version, prompt fingerprint, checklist. Two results are only comparable if these match.
  const [subject, setSubject] = useState<{
    version?: number;
    prompts?: string;
    gold?: { path: string; items: number; heldOut: number };
    goldMissing?: string;
  } | null>(null);
  const [critique, setCritique] = useState<Critique | undefined>();
  const [critiquing, setCritiquing] = useState(false);
  /**
   * 仓库里定义好的评测。
   *
   * 下面那个自己拼两组的构造器是探索用的；这些是**这个 harness 拿什么在考自己**的答案。
   * 它们进了 git，所以有历史、能 review、改了看得见——一份可以被人在界面上随手改掉
   * 且不留痕迹的判断依据，不再是判断依据。
   */
  const [specs, setSpecs] = useState<EvalSpecRow[]>([]);
  const [specProblems, setSpecProblems] = useState<Array<{ path: string; error: string }>>([]);

  const refresh = async () => {
    const { evals } = (await fetch(`${API}/api/evals`).then((r) => r.json())) as { evals: EvalRow[] };
    setRows(evals);
    const newest = evals.find((e) => e.status === "done");
    if (newest && !current) await open(newest.id);
  };

  const open = async (id: string) => {
    const { eval: found } = (await fetch(`${API}/api/evals/${id}`).then((r) => r.json())) as { eval: EvalResult };
    setCurrent(found);
  };

  useEffect(() => {
    void load();
    void fetch(`${API}/api/ablatable`)
      .then((r) => r.json())
      .then((d: { ablatable: string[] }) => setAblatable(d.ablatable));
    void refresh();
    void fetch(`${API}/api/critic`)
      .then((r) => r.json())
      .then((d: { critiques: Critique[] }) => setCritique(d.critiques[0]));
    void fetch(`${API}/api/evals/specs`)
      .then((r) => r.json())
      .then((d: { specs: EvalSpecRow[]; problems: Array<{ path: string; error: string }> }) => {
        setSpecs(d.specs);
        setSpecProblems(d.problems);
      })
      .catch(() => undefined);
    // Two full runs take a while; poll rather than hold a socket open for it.
    const timer = setInterval(() => void refresh(), 10000);
    return () => clearInterval(timer);
  }, [load]);

  // The subject follows the graph picker: switching graphs switches the checklist too, and
  // that is exactly the mix-up worth showing before someone reads 0% as a regression.
  useEffect(() => {
    void fetch(`${API}/api/evals/subject/${graphId}`)
      .then((r) => r.json())
      .then(setSubject)
      .catch(() => setSubject(null));
  }, [graphId]);

  const start = async () => {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`${API}/api/evals/paired`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          graphId,
          a: { label: "baseline" },
          b: {
            label: armB.length
              ? `without ${armB.join("+")}`
              : paramsB.trim()
                ? `with ${paramsB.trim()}`
                : "same again",
            ablate: armB,
            ...(paramsB.trim() ? { params: JSON.parse(paramsB) } : {}),
          },
        }),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const runSpec = async (id: string) => {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`${API}/api/evals/specs/${id}/run`, { method: "POST" });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const askCritic = async () => {
    setCritiquing(true);
    setError("");
    try {
      const res = await fetch(`${API}/api/critic`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit: 8 }),
      });
      const body = (await res.json()) as { critique?: Critique; error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setCritique(body.critique);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCritiquing(false);
    }
  };

  const toggle = (name: string) =>
    setArmB((prev) => (prev.includes(name) ? prev.filter((x) => x !== name) : [...prev, name]));

  return (
    <>
      <TopBar />
      <div className="flex-1 overflow-auto p-4">
        <div className="mx-auto max-w-4xl space-y-4">
          <div>
            <h1 className="flex items-center gap-2 font-display text-lg font-medium text-foreground">
              <FlaskConical className="h-5 w-5 text-primary" />
              {t("nav.evals")}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">{t("eval.subtitle")}</p>
          </div>

          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card px-3 py-2 text-[12px]">
            <span className="font-medium">{t("eval.subject")}</span>
            <span className="rounded bg-muted px-1.5 py-0.5 font-mono">
              {graphId}
              {subject?.version !== undefined ? ` · v${subject.version}` : ""}
            </span>
            {subject?.prompts && (
              <span className="rounded bg-muted px-1.5 py-0.5 font-mono" title={t("eval.promptsHint")}>
                prompts {subject.prompts}
              </span>
            )}
            {subject?.gold ? (
              <span className="text-muted-foreground">
                {t("eval.goldIs")
                  .replace("{path}", subject.gold.path)
                  .replace("{n}", String(subject.gold.items))
                  .replace("{h}", String(subject.gold.heldOut))}
              </span>
            ) : subject?.goldMissing ? (
              <span className="text-amber-600 dark:text-amber-400">
                {t("eval.goldMissing")}：{subject.goldMissing}
              </span>
            ) : null}
          </div>

          {/* 仓库里定义好的评测，排在自建构造器之前：它们是这个项目的判断依据，
              下面那个是探索时临时问一个问题的地方。 */}
          <div className="rounded-xl border border-border bg-card p-3">
            <div className="flex items-center gap-2">
              <FileCode2 className="h-4 w-4 text-primary" />
              <span className="font-display text-sm font-medium text-foreground">
                {t("eval.specs")}
              </span>
              <span className="font-mono text-[11px] text-muted-foreground">evals/</span>
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">{t("eval.specsHint")}</p>

            {specs.length === 0 && specProblems.length === 0 && (
              <p className="mt-2 text-[12px] text-muted-foreground">{t("eval.specsEmpty")}</p>
            )}

            <div className="mt-2 space-y-2">
              {specs.map((sp) => (
                <div key={sp.id} className="rounded-lg bg-muted p-2">
                  <div className="flex items-baseline gap-2">
                    <span className="text-[13px] font-medium text-foreground">{sp.title}</span>
                    <span className="ml-auto shrink-0 font-mono text-[10.5px] text-muted-foreground">
                      {sp.path}
                    </span>
                  </div>
                  {/* 为什么问这个问题。它是必填的，所以这里一定有东西可显示——一份说不出
                      自己在问什么的评测，最后会变成一个谁也不会据此改任何东西的仪表盘。 */}
                  <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">{sp.why}</p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px]">
                    <span className="rounded bg-black/5 px-1.5 py-0.5 font-mono dark:bg-white/10">
                      {sp.graphId}
                    </span>
                    <span className="text-muted-foreground">{sp.a.label}</span>
                    <span className="text-muted-foreground">↔</span>
                    <span className="text-muted-foreground">{sp.b.label}</span>
                    {sp.expect && (
                      // 跑之前写下的预判。显示它，是因为它只有在结果出来之前就存在才有意义。
                      <span
                        title={sp.expect.note}
                        className="rounded bg-primary/10 px-1.5 py-0.5 text-primary"
                      >
                        {t("eval.predicted")}: {t(`eval.dir.${sp.expect.direction}`)}
                      </span>
                    )}
                    <Button className="ml-auto" onClick={() => void runSpec(sp.id)} disabled={busy}>
                      <Play className="h-3.5 w-3.5" />
                      {t("eval.run")}
                    </Button>
                  </div>
                </div>
              ))}
              {/* 读不出来的定义要说出来：静默跳过会让评测集悄悄变小，而界面上一切正常。 */}
              {specProblems.map((p) => (
                <div key={p.path} className="rounded-lg border border-rose-300 p-2 text-[12px]">
                  <span className="font-mono text-[11px] text-muted-foreground">{p.path}</span>
                  <div className="mt-0.5 text-rose-600">{p.error}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-xl border border-border bg-card p-3">
            <p className="mb-2 text-[11px] text-muted-foreground">{t("eval.adhocHint")}</p>
            <div className="flex flex-wrap items-center gap-2">
              <select
                className="rounded-md border border-border bg-card px-2 py-1 text-sm"
                value={graphId}
                onChange={(e) => setGraphId(e.target.value)}
              >
                {graphs.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.id}
                  </option>
                ))}
              </select>
              <span className="text-[12px] text-muted-foreground">{t("eval.armB")}</span>
              {ablatable.map((name) => (
                <button
                  key={name}
                  onClick={() => toggle(name)}
                  className={cn(
                    "rounded-md border px-2 py-1 font-mono text-[11px] transition-colors",
                    armB.includes(name)
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border text-muted-foreground hover:bg-muted",
                  )}
                >
                  {name}
                </button>
              ))}
              <input
                className="w-72 rounded-md border border-border bg-card px-2 py-1 font-mono text-[11px]"
                placeholder={'{"design":{"maxCasesPerStory":10}}'}
                value={paramsB}
                onChange={(e) => setParamsB(e.target.value)}
              />
              <Button variant="primary" onClick={() => void start()} disabled={busy}>
                <Play className="h-3.5 w-3.5" />
                {t("eval.run")}
              </Button>
            </div>
            <p className="mt-2 text-[11px] text-muted-foreground">{t("eval.hint")}</p>
            {error && <p className="mt-1 text-[12px] text-rose-500">{error}</p>}
          </div>

          <div className="rounded-xl border border-border bg-card p-3">
            <div className="flex items-center gap-2">
              <Lightbulb className="h-4 w-4 text-amber-500" />
              <span className="font-display text-sm font-medium text-foreground">{t("critic.title")}</span>
              <Button className="ml-auto" onClick={() => void askCritic()} disabled={critiquing}>
                <RefreshCw className={cn("h-3.5 w-3.5", critiquing && "animate-spin")} />
                {t("critic.run")}
              </Button>
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">{t("critic.hint")}</p>
            {critique ? (
              <div className="mt-2 space-y-2">
                {critique.suggestions.map((s, i) => (
                  <div key={i} className="rounded-lg bg-muted p-2">
                    <div className="flex items-center gap-2">
                      <span className="rounded bg-black/5 px-1 py-0.5 font-mono text-[10px] dark:bg-white/10">
                        {s.target}
                      </span>
                      <span className="text-[13px] font-medium text-foreground">{s.title}</span>
                      {/* A proposal that broke a rule keeps its place and loses its button:
                          refusing it quietly would hide something worth knowing about the
                          critic. */}
                      {s.inadmissible ? (
                        <span className="ml-auto rounded bg-rose-500/15 px-1.5 py-0.5 text-[10px] text-rose-600">
                          {t("critic.inadmissible")}
                        </span>
                      ) : (
                        s.test.kind !== "manual" &&
                        s.test.handle && (
                          <button
                            className="ml-auto rounded border border-primary px-1.5 py-0.5 text-[10px] text-primary"
                            onClick={() => setArmB([s.test.handle!])}
                          >
                            {t("critic.compare")}: {s.test.handle}
                          </button>
                        )
                      )}
                    </div>
                    <div className="mt-1 text-[12px] text-foreground">{s.change}</div>
                    <div className="mt-0.5 text-[11px] text-muted-foreground">{s.evidence}</div>
                    {s.inadmissible && (
                      <div className="mt-1 text-[11px] text-rose-600">{s.inadmissible}</div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-2 text-[12px] text-muted-foreground">{t("critic.empty")}</p>
            )}
          </div>

          {current && isDetection(current) && <DetectionCard d={current as unknown as DetectionResult} />}

          {current && !isDetection(current) && (
            <div className="space-y-3">
              <div className="grid gap-3 md:grid-cols-2">
                {current.a && <ArmCard arm={current.a} />}
                {current.b && <ArmCard arm={current.b} />}
              </div>
              <div className="rounded-xl border border-border bg-card p-3">
                <div className="font-display text-sm font-medium text-foreground">{t("eval.verdict")}</div>
                {/* 这次评测在回答哪个问题。三个月后没有人还记得当初为什么要比这两样，
                    而一个只有两组数字的结果不会提醒任何人。 */}
                {current.spec && (
                  <div className="mt-1 rounded-lg bg-muted p-2">
                    <div className="flex items-baseline gap-2">
                      <span className="text-[12.5px] font-medium text-foreground">{current.spec.title}</span>
                      <span className="ml-auto shrink-0 font-mono text-[10.5px] text-muted-foreground">
                        {current.spec.path}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[11.5px] leading-relaxed text-muted-foreground">
                      {current.spec.why}
                    </p>
                  </div>
                )}
                {current.mcnemar ? (
                  <>
                    <p className="mt-1 text-[13px] text-foreground">{current.mcnemar.reading}</p>
                    <div className="mt-2 grid grid-cols-3 gap-2 font-mono text-[12px] text-muted-foreground">
                      <div>A only: {current.mcnemar.aOnly}</div>
                      <div>B only: {current.mcnemar.bOnly}</div>
                      <div>p = {current.mcnemar.p}</div>
                    </div>
                  </>
                ) : (
                  <p className="mt-1 text-[13px] text-amber-600">{current.error ?? t("eval.noVerdict")}</p>
                )}
                {current.costDelta && (
                  <div className="mt-2 font-mono text-[11px] text-muted-foreground">
                    cost delta: {current.costDelta.calls} calls · {current.costDelta.tokens} tok ·{" "}
                    {Math.round(current.costDelta.ms / 1000)}s
                  </div>
                )}
                {/* 预判与结果并排。它不是通过/失败——一个会红的评测会被人调到绿为止。 */}
                {current.prediction && (
                  <div
                    title={t("eval.predictionWhy")}
                    className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-muted px-2 py-1.5 text-[12px]"
                  >
                    <span className="text-muted-foreground">
                      {t("eval.predicted")}: {t(`eval.dir.${current.prediction.expected}`)}
                    </span>
                    <span className="text-muted-foreground">→</span>
                    <span className="text-foreground">{t(`eval.dir.${current.prediction.observed}`)}</span>
                    {current.prediction.matched !== undefined && (
                      <span
                        className={cn(
                          "rounded px-1.5 py-0.5 text-[11px]",
                          current.prediction.matched
                            ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
                            : "bg-amber-500/15 text-amber-700 dark:text-amber-400",
                        )}
                      >
                        {t(current.prediction.matched ? "eval.predictionMatched" : "eval.predictionMissed")}
                      </span>
                    )}
                    {/* 方向对上但差异不显著，说明不了什么——不说出来就会被当成一次确认。 */}
                    {!current.prediction.significant && (
                      <span className="text-[11px] text-muted-foreground">{t("eval.notSignificant")}</span>
                    )}
                  </div>
                )}
                {current.note && <p className="mt-2 text-[12px] text-amber-600">{current.note}</p>}
              </div>
            </div>
          )}

          <div className="rounded-xl border border-border bg-card">
            {rows.length === 0 ? (
              <div className="p-6 text-center text-[13px] text-muted-foreground">{t("eval.empty")}</div>
            ) : (
              rows.map((r) => (
                <button
                  key={r.id}
                  onClick={() => void open(r.id)}
                  className="flex w-full items-center justify-between border-b border-border px-3 py-2 text-left last:border-0 hover:bg-muted"
                >
                  <span className="font-mono text-[12px] text-foreground">{r.id}</span>
                  <span className="text-[11px] text-muted-foreground">
                    {r.graphId} · {r.status} · {new Date(r.startedAt).toLocaleString()}
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      </div>
    </>
  );
}
