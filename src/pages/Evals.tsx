import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, CheckCircle2, CircleAlert, Clock3, Loader2, Play, RefreshCw } from "lucide-react";
import { TopBar } from "@/components/TopBar";
import { Button } from "@/components/ui";
import { useT } from "@/lib/prefs";
import { CoverageMatrix } from "@/components/CoverageMatrix";
import { useWf } from "@/lib/wf";
import { useStore } from "@/lib/store";
import { api } from "@/lib/api";
import type { GoldState } from "@/lib/types";
import { Lifecycle } from "@/components/Lifecycle";
import {EvidenceStudy} from '@/components/EvidenceStudy';
import { useProjectRuns } from "@/lib/useProjectRuns";
import { API_BASE } from "@/lib/base";

type Admission = { ready: boolean; classification: string; issues: string[]; goldHash?: string; items?: number };
type Spec = { id: string; title: string; why: string; graphId: string; goldPath?: string; a: { label: string; runtime?: string }; b: { label: string; runtime?: string }; preflight: Admission };
type Row = { projectId?: string; capability?: string; id: string; graphId: string; startedAt: string; status: string; validity?: string; title?: string; error?: string };
type Detail = { validity?: string; classification?: string; error?: string; runId?: string; goldHash?: string; note?: string; mutationScore?: number | null; unknownInjection?: number; notApplied?: number; a?: { label: string; coverage: number; cases: number; wfRunId: string }; b?: { label: string; coverage: number; cases: number; wfRunId: string }; costDelta?: { calls: number; tokens: number; ms: number } | null };
async function request<T>(path: string, signal?: AbortSignal, method = "GET"): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, { method, credentials: "include", signal: signal ?? AbortSignal.timeout(10000), ...(method === "POST" ? { headers: { "content-type": "application/json" }, body: "{}" } : {}) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
  return value as T;
}

export function EvalsPage() {
  const t = useT();
  const projectId = useStore(s=>s.activeProjectId);
  const [datasets,setDatasets] = useState<GoldState[]>([]);
  const [goldError,setGoldError] = useState("");
  const projectRuns = useProjectRuns(projectId);
  const [runA,setRunA] = useState(""), [runB,setRunB] = useState(""), [capability,setCapability] = useState("");
  const compareRegistered = async () => {
    setStarting(true); setActionError("");
    try {
      const response = await fetch(`${API_BASE}/api/evals/registered`, {method:"POST",headers:{"content-type":"application/json"},credentials:"include",body:JSON.stringify({projectId,a:runA,b:runB,capability})});
      const result = await response.json(); if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
      setRunId(result.id); refresh();
    } catch(e) { setActionError((e as Error).message); } finally {setStarting(false);}
  };
  const wfRuns = useWf(state => state.runs);
  const [coverageOpen, setCoverageOpen] = useState(false);
  const [actionError, setActionError] = useState("");
  const [specs, setSpecs] = useState<Spec[]>([]), [rows, setRows] = useState<Row[]>([]);
  const [problems, setProblems] = useState<Array<{ path: string; error: string }>>([]);
  const [selected, setSelected] = useState(""), [runId, setRunId] = useState(() => new URLSearchParams(window.location.hash.split("?")[1]).get("evalId") ?? ""), [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(true), [starting, setStarting] = useState(false), [error, setError] = useState(""), [detailError, setDetailError] = useState("");
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(v => v + 1), []);
  const explain = (code: string) => { const key = `evaldesk.reason.${code}`; const text = t(key); return text === key ? code : text; };
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([request<{ specs: Spec[]; problems: typeof problems }>("/api/evals/specs", controller.signal), request<{ evals: Row[] }>("/api/evals", controller.signal)])
      .then(([catalog, history]) => { setSpecs(catalog.specs.map(spec => ({ ...spec, preflight: spec.preflight ?? { ready: false, classification: "diagnostic", issues: ["eval_backend_update_required"] } }))); setProblems(catalog.problems); setRows(history.evals); setSelected(old => catalog.specs.some(s => s.id === old) ? old : catalog.specs[0]?.id ?? ""); setError(""); })
      .catch(e => { if (!controller.signal.aborted) setError(e.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [revision]);
  useEffect(() => { if (!rows.some(r => r.status === "running")) return; const timer = setTimeout(refresh, 3000); return () => clearTimeout(timer); }, [rows, refresh]);
  useEffect(() => {
    if (!runId) { setDetail(null); return; }
    const controller = new AbortController(); setDetail(null); setDetailError("");
    void request<{ eval: Detail }>(`/api/evals/${encodeURIComponent(runId)}`, controller.signal).then(r => setDetail(r.eval)).catch(e => { if (!controller.signal.aborted) setDetailError(e.message); });
    return () => controller.abort();
  }, [runId, revision]);
  const spec = specs.find(s => s.id === selected), current = rows.find(r => r.id === runId);
  const start = async () => {
    if (!spec?.preflight.ready || starting) return;
    setStarting(true); setActionError("");
    try { const result = await request<{ id: string }>(`/api/evals/specs/${encodeURIComponent(spec.id)}/run`, undefined, "POST"); setRunId(result.id); refresh(); }
    catch (e) { setActionError((e as Error).message); refresh(); }
    finally { setStarting(false); }
  };
  useEffect(()=>{let active=true; setDatasets([]); setGoldError("");
    void api.getScoreboard().then(r=>Promise.all(r.capabilities.map(c=>api.getGold(c)))).then(data=>{if(!active)return;const available=data.filter(s=>s.projectId===projectId&&!s.archived);setDatasets(available);setCapability(old=>available.some(s=>s.capability===old)?old:available[0]?.capability??"");}).catch(e=>{if(active)setGoldError(e.message);});return()=>{active=false;};
  },[projectId,revision]);
  const selectedGold = datasets.find(s=>s.capability===capability);
  const goldReady = !!selectedGold?.frozenHash && selectedGold.frozenHash===selectedGold.currentHash && selectedGold.gold?.reviewPolicy==='individual-v1' && selectedGold.reviewIssues?.length===0 && !!selectedGold.gold.items.some(i=>i.heldOut) && !!selectedGold.gold.items.some(i=>i.split==='dev'&&!i.heldOut);
  useEffect(()=>{if(current?.projectId===projectId && detail?.a && detail.b){setRunA(v=>v||detail.a!.wfRunId);setRunB(v=>v||detail.b!.wfRunId);}},[detail,projectId,current?.projectId]);
  const goldCapability = spec?.goldPath?.match(/^benchmark\/([a-z0-9-]+)\/gold\.json$/)?.[1];
  const projectRows = rows.filter(row => !!projectId && row.projectId === projectId);
  const tabs = ["project", "harness", "graph"] as const;
  type EvalTab = typeof tabs[number];
  const readTab = (): EvalTab => { const value = new URLSearchParams(window.location.hash.split("?")[1]).get("evalTab"); return value === "harness" || value === "graph" ? value : "project"; };
  const [activeTab,setActiveTab] = useState<EvalTab>(readTab);
  const [harnessVisited,setHarnessVisited] = useState(activeTab === "harness");
  useEffect(()=>{if(activeTab === "harness")setHarnessVisited(true);},[activeTab]);
  const tabButtons = useRef<Array<HTMLButtonElement | null>>([]);
  const historySelection = useRef({project:"",graph:""});
  const changeTab = (tab: EvalTab) => {
    if (activeTab !== "harness") historySelection.current[activeTab] = runId;
    setActiveTab(tab); setActionError("");
    if (tab !== "harness") setRunId(historySelection.current[tab] || rows.find(r=>tab === "project" ? r.projectId === projectId : !r.projectId)?.id || "");
    const params = new URLSearchParams(window.location.hash.split("?")[1]); params.set("evalTab",tab); params.delete("evalId");
    window.history.replaceState(null,"",`${window.location.pathname}${window.location.search}#/?${params}`);
  };
  useEffect(()=>{const onHash=()=>setActiveTab(readTab());window.addEventListener("hashchange",onHash);return()=>window.removeEventListener("hashchange",onHash);},[]);
  const visibleRows = activeTab === "graph" ? rows.filter(r=>!r.projectId) : projectRows;
  useEffect(() => { historySelection.current={project:"",graph:""}; setRunA(""); setRunB(""); setCapability(""); setRunId(new URLSearchParams(window.location.hash.split("?")[1]).get("evalId") ?? ""); }, [projectId]);
  useEffect(()=>{if(activeTab!=="harness" && (!runId || (current && !visibleRows.some(r=>r.id===runId)))) setRunId(visibleRows[0]?.id??"");},[runId,rows,projectId,activeTab]);
  const ready = specs.filter(s => s.preflight.ready).length;
  const statusText = (row: Row) => t(`evaldesk.status.${row.validity === "legacy" && row.status === "done" ? "legacy" : row.status}`);
  return <>
    <TopBar title={t("nav.evals")} hint={t("evaldesk.subtitle")} />
    <div className="flex-1 overflow-auto bg-background p-4 md:p-6">
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-6">
          <div className="max-w-2xl"><h1 className="text-2xl font-semibold tracking-tight">{t("evaldesk.title")}</h1><p className="mt-3 text-sm leading-6 text-muted-foreground">{t("evaldesk.description")}</p></div>
          <Button onClick={refresh} disabled={loading || starting}><RefreshCw className="mr-2 h-4 w-4" />{t("evaldesk.refresh")}</Button>
        </header>
        <div role="tablist" aria-label={t("evaltabs.label")} className="flex gap-1 overflow-x-auto border-b border-border">
          {tabs.map((tab,index)=><button key={tab} ref={node=>{tabButtons.current[index]=node;}} id={`eval-tab-${tab}`} role="tab" aria-selected={activeTab===tab} aria-controls={`eval-panel-${tab}`} tabIndex={activeTab===tab?0:-1}
            className={`shrink-0 border-b-2 px-4 py-3 text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary ${activeTab===tab?"border-primary text-primary":"border-transparent text-muted-foreground hover:bg-muted hover:text-foreground"}`}
            onClick={()=>changeTab(tab)} onKeyDown={event=>{let next=index;if(event.key==="ArrowRight")next=(index+1)%tabs.length;else if(event.key==="ArrowLeft")next=(index+tabs.length-1)%tabs.length;else if(event.key==="Home")next=0;else if(event.key==="End")next=tabs.length-1;else return;event.preventDefault();changeTab(tabs[next]);tabButtons.current[next]?.focus();}}>{t(`evaltabs.${tab}`)}</button>)}
        </div>
        <div id={`eval-panel-${activeTab}`} role="tabpanel" aria-labelledby={`eval-tab-${activeTab}`} tabIndex={0} className="space-y-6 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
        {activeTab === "project" && <>
        <p className="max-w-3xl text-sm leading-6 text-muted-foreground">{t("life.relationship")}</p>
        {projectRows.some(r=>r.validity==='valid') && <p role="status" className="text-sm font-medium text-primary">{t("life.next")}</p>}
        <Lifecycle steps={[
          {title:t("life.gold"),done:goldReady,detail:<>{t("life.goldHelp")} <a className="text-primary underline" href={`#/?open=gold&project=${encodeURIComponent(projectId)}&capability=${encodeURIComponent(capability)}`}>{t("life.openGold")}</a></>},
          {title:t("life.pair"),done:!!runA && !!runB && runA!==runB,detail:t("life.pairHelp")},
          {title:t("life.compare"),done:projectRows.some(r=>r.validity==='valid'),detail:t("life.compareHelp")},
          {title:t("life.release"),done:false,detail:t("life.releaseHelp")},
        ]}/>
        {(error || actionError || goldError || projectRuns.error) && <p role="alert" className="text-sm text-bad">{explain(actionError || error || goldError || projectRuns.error)}</p>}
        <section className="rounded-lg border border-border bg-card p-5"><h2 className="text-sm font-semibold">{t("life.project")}</h2><p className="my-3 text-sm text-muted-foreground">{t("evaldesk.registeredHelp")}</p><div className="flex flex-wrap gap-3">{[[runA,setRunA,"A"],[runB,setRunB,"B"]].map(([value,setter,label])=><label key={String(label)} className="min-w-0 max-w-full text-sm">{String(label)} <select className="max-w-full rounded border bg-background p-2" value={value as string} onChange={e=>(setter as (v:string)=>void)(e.target.value)}><option value="">{t("evaldesk.selectRun")}</option>{projectRuns.runs.map(run=><option key={run.id} value={run.id}>{run.id} · {run.status}</option>)}</select></label>)}<label className="min-w-0 text-sm">{t("gold.capability")}<select className="block max-w-full rounded border bg-background p-2" value={capability} onChange={e=>setCapability(e.target.value)}><option value="">{t("life.openGold")}</option>{datasets.map(s=><option key={s.capability} value={s.capability}>{s.capability}</option>)}</select></label><Button disabled={!projectId || !runA || !runB || runA===runB || !goldReady || starting} onClick={()=>void compareRegistered()}>{t("evaldesk.compareRegistered")}</Button></div></section>
        </>}
        <div hidden={activeTab !== "harness"}>{harnessVisited && <EvidenceStudy />}</div>
        {activeTab === "graph" && <>
        {(error || actionError) && <div role="alert" className="rounded-md border border-bad/30 bg-bad-soft p-4 text-sm text-bad">{explain(actionError || error)}</div>}
        <div className="grid grid-cols-3 divide-x divide-border rounded-lg border border-border bg-card">
          {[ [t("evaldesk.ready"), ready], [t("evaldesk.blocked"), specs.length - ready + problems.length], [t("evaldesk.history"), rows.filter(r=>!r.projectId).length] ].map(([label, count]) => <div className="p-4 md:p-5" key={label}><div className="text-xs text-muted-foreground">{label}</div><div className="mt-2 font-mono text-2xl">{loading ? "—" : count}</div></div>)}
        </div>
        {loading ? <div role="status" className="flex items-center gap-2 p-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t("evaldesk.loading")}</div> : <div className="grid gap-5 lg:grid-cols-[minmax(230px,1fr)_minmax(0,2fr)]">
          <section aria-label={t("evaldesk.definitions")} className="space-y-2"><h2 className="mb-3 text-sm font-semibold">{t("evaldesk.definitions")}</h2>
            {!specs.length && <p className="rounded-md border border-dashed border-border p-5 text-sm text-muted-foreground">{t("evaldesk.emptySpecs")}</p>}
            {specs.map(item => <button key={item.id} onClick={() => setSelected(item.id)} aria-pressed={selected === item.id} className={`w-full rounded-md border p-4 text-left transition-colors ${selected === item.id ? "border-primary bg-primary-soft" : "border-border bg-card hover:bg-muted"}`}><div className="flex items-start justify-between gap-3"><span className="text-sm font-medium">{item.title}</span>{item.preflight.ready ? <CheckCircle2 className="h-4 w-4 shrink-0 text-ok" /> : <CircleAlert className="h-4 w-4 shrink-0 text-warn" />}</div><div className="mt-2 font-mono text-xs text-muted-foreground">{item.id}</div><p className="mt-3 text-xs text-muted-foreground">{t(item.preflight.ready ? "evaldesk.ready" : "evaldesk.blocked")}</p></button>)}
            {problems.map(p => <div key={p.path} className="rounded-md border border-bad/30 p-4 text-xs text-bad"><p className="break-all font-mono">{p.path}</p><p className="mt-2">{p.error}</p></div>)}
          </section>
          <section aria-label={t("evaldesk.preflight")} className="min-w-0 rounded-lg border border-border bg-card p-5 md:p-6">
            <h2 className="text-sm font-semibold">{t("evaldesk.preflight")}</h2>
            {spec ? <><p className="mt-4 text-lg font-medium">{spec.title}</p><p className="mt-2 text-sm leading-6 text-muted-foreground">{spec.why}</p>
              <div className="my-5 grid grid-cols-[1fr_auto_1fr] items-center gap-3 rounded-md bg-muted p-4"><div><span className="font-mono text-xs text-muted-foreground">A</span><p className="mt-1 text-sm">{spec.a.label}</p></div><ArrowRight className="h-4 w-4 text-muted-foreground" /><div><span className="font-mono text-xs text-muted-foreground">B</span><p className="mt-1 text-sm">{spec.b.label}</p></div></div>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs"><dt className="text-muted-foreground">{t("evaldesk.graph")}</dt><dd className="break-all font-mono">{spec.graphId}</dd><dt className="text-muted-foreground">{t("evaldesk.dataset")}</dt><dd className="break-all font-mono">{spec.goldPath ?? "—"}</dd><dt className="text-muted-foreground">{t("evaldesk.items")}</dt><dd>{spec.preflight.items ?? "—"}</dd>{spec.preflight.goldHash && <><dt className="text-muted-foreground">{t("evaldesk.fingerprint")}</dt><dd className="break-all font-mono" title={spec.preflight.goldHash}>{spec.preflight.goldHash.slice(0, 16)}</dd></>}</dl>
              <div className={`mt-5 rounded-md border p-4 ${spec.preflight.ready ? "border-ok/30 bg-ok-soft" : "border-warn/30 bg-warn-soft"}`}><p className="text-sm font-medium">{t(spec.preflight.ready ? "evaldesk.canRun" : "evaldesk.cannotRun")}</p><ul className="mt-2 space-y-2 text-sm leading-6">{spec.preflight.issues.map(code => <li key={code}>{explain(code)}</li>)}</ul></div>
              <p className="mt-4 text-xs leading-5 text-muted-foreground">{t("evaldesk.scope")}</p>{goldCapability && <a className="mt-3 block text-sm text-primary underline" href={`#/?open=gold&capability=${encodeURIComponent(goldCapability)}`}>{t("evaldesk.openGold")}</a>}<p className="mt-3 text-xs leading-5 text-muted-foreground">{t("evaldesk.gatewayHint")}</p><Button className="mt-4" variant="primary" disabled={!spec.preflight.ready || starting || !!error} onClick={() => void start()}>{starting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}{t("evaldesk.start")}</Button>
            </> : <p className="mt-5 text-sm text-muted-foreground">{t("evaldesk.emptySpecs")}</p>}
          </section>
        </div>}
        </>}
        {activeTab !== "harness" && <>
        <section className="border-t border-border pt-6"><div className="mb-4 flex items-center gap-2"><Clock3 className="h-4 w-4 text-muted-foreground" /><h2 className="text-sm font-semibold">{t("evaldesk.history")}</h2></div>
          {!visibleRows.length ? <p className="rounded-md border border-dashed border-border p-6 text-sm text-muted-foreground">{t("evaldesk.emptyRuns")}</p> : <div className="grid gap-5 lg:grid-cols-2"><div className="space-y-2">{visibleRows.map(row => <button key={row.id} onClick={() => setRunId(row.id)} aria-pressed={row.id === runId} className={`w-full rounded-md border p-4 text-left ${row.id === runId ? "border-primary bg-primary-soft" : "border-border bg-card"}`}><div className="flex items-center justify-between gap-3"><span className="truncate text-sm font-medium">{row.title ?? row.graphId}</span><span className={`shrink-0 text-xs ${["invalid", "failed"].includes(row.status) ? "text-bad" : "text-muted-foreground"}`}>{statusText(row)}</span></div><p className="mt-2 text-xs text-muted-foreground">{new Date(row.startedAt).toLocaleString()}</p>{row.error && <p className="mt-2 text-xs text-bad">{explain(row.error)}</p>}</button>)}</div>
            <div className="min-w-0 rounded-lg border border-border bg-card p-5" aria-live="polite"><h3 className="text-sm font-semibold">{t("evaldesk.result")}</h3>{detailError ? <p role="alert" className="mt-4 text-sm text-bad">{detailError}</p> : !visibleRows.some(r=>r.id===runId) ? <p className="mt-4 text-sm text-muted-foreground">{t("evaldesk.selectRun")}</p> : !detail ? <p className="mt-4 text-sm">{t("evaldesk.loading")}</p> : <><p className="mt-2 break-all font-mono text-xs text-muted-foreground">{runId}</p>{detail.error ? <p className="mt-5 rounded-md bg-bad-soft p-4 text-sm text-bad">{explain(detail.error)}</p> : current?.status === "running" ? <p className="mt-5 flex items-center gap-2 text-sm"><Loader2 className="h-4 w-4 animate-spin" />{t("evaldesk.status.running")}</p> : detail.validity === "valid" && detail.a && detail.b ? <><div className="mt-5 grid grid-cols-2 gap-3">{[detail.a, detail.b].map((arm, i) => <div key={i} className="rounded-md bg-muted p-4"><p className="text-xs text-muted-foreground">{arm.label}</p><p className="mt-2 font-mono text-2xl">{(arm.coverage * 100).toFixed(1)}%</p><p className="mt-1 text-xs">{t("evaldesk.coverage")}</p><p className="mt-3 text-xs text-muted-foreground">{arm.cases} {t("evaldesk.cases")}</p></div>)}</div><p className="mt-4 text-xs text-muted-foreground">{detail.costDelta ? t("evaldesk.cost", { calls: detail.costDelta.calls, tokens: detail.costDelta.tokens }) : t("evaldesk.costUnknown")}</p><p className="mt-4 text-sm leading-6 text-muted-foreground">{t("evaldesk.noWinner")}</p></> : "mutationScore" in detail ? <p className="mt-5 text-sm">{t("evaldesk.mutation")}: {detail.mutationScore == null ? t("evaldesk.unobservable") : `${(detail.mutationScore * 100).toFixed(1)}%`}<br />{t("evaldesk.unknownInjection")}: {detail.unknownInjection ?? "—"}</p> : <p className="mt-5 text-sm text-muted-foreground">{t("evaldesk.legacy")}</p>}{detail.note && <p className="mt-4 text-sm text-warn">{detail.note}</p>}{detail.runId && <p className="mt-4 break-all font-mono text-xs">{detail.runId}</p>}</>}</div>
          </div>}
        </section>
        </>}
        {activeTab === "project" && <>
        <details className="border-t border-border pt-5" onToggle={event => { setCoverageOpen(event.currentTarget.open); if (event.currentTarget.open) void useWf.getState().load(); }}><summary className="cursor-pointer text-sm font-semibold">{t("evaldesk.singleRun")}</summary>{coverageOpen && <div className="mt-4"><CoverageMatrix runs={wfRuns.map(run => ({ id: run.id, label: `${run.graphId} · ${run.id}` }))} /></div>}</details>        </>}
        </div>
      </div>
    </div>
  </>;
}
