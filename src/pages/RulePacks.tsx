import { useCallback, useEffect, useState } from 'react';
import { API_BASE } from '@/lib/base';
import { useStore } from '@/lib/store';
import { useT } from '@/lib/prefs';
import { NeedProject } from '@/components/NeedProject';
import { TopBar } from '@/components/TopBar';
import { Button } from '@/components/ui';

/**
 * 产品规则包：这个项目的领域事实，按版本存。
 *
 * 在这一页之前，规则包**只能在新建运行的表单里贴一次 JSON**，然后躺在那次运行的账本里：
 * 列不出来、改不了、比不了两版的差异、跨运行也不复用。而它是这个产品最主要的领域资产——
 * 探索目标、前提的供给关系、fill 的值、行业禁点词表，全在里面。
 * 同一个项目的两次运行可以用着不同的包而没人拦得住，两臂对照最怕的就是这个。
 *
 * 这一页只做四件事：列出每一版、看内容、传新版、删没用过的版本。
 * 「哪几次运行用的是哪一版」直接标在版本上——那是判断一次运行按什么跑的唯一凭证。
 */
type PackVersion = {
  id: string; packId: string; version: string; hash: string; createdAt: string;
  counts: { modules: number; features: number; rules: number; targets: number };
  usedByRuns: string[];
};
const base = (projectId: string) => `${API_BASE}/api/projects/${encodeURIComponent(projectId)}/rule-packs`;

export function RulePacks() {
  const projectId = useStore(s => s.activeProjectId);
  return projectId ? <Packs key={projectId} projectId={projectId} /> : <NeedProject />;
}

function Packs({ projectId }: { projectId: string }) {
  const t = useT();
  const [packs, setPacks] = useState<PackVersion[]>([]);
  const [selected, setSelected] = useState<string>('');
  const [body, setBody] = useState<unknown>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(base(projectId));
      const d = await r.json() as { packs?: PackVersion[]; error?: string };
      if (!r.ok) throw new Error(d.error ?? 'request_failed');
      setPacks(d.packs ?? []); setError('');
    } catch (e) { setError(String((e as Error).message)); } finally { setLoaded(true); }
  }, [projectId]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!selected) { setBody(undefined); return; }
    const c = new AbortController();
    void fetch(`${base(projectId)}/${selected}`, { signal: c.signal })
      .then(r => r.json()).then(d => setBody(d.pack)).catch(() => {});
    return () => c.abort();
  }, [projectId, selected]);

  async function upload(text: string) {
    setBusy(true); setError('');
    try {
      const pack = JSON.parse(text) as unknown;
      const r = await fetch(base(projectId), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pack }) });
      const d = await r.json() as { error?: string; created?: boolean; hash?: string };
      // 校验失败时服务端把 code + jsonPointer 原样带回来——那正是要给写包的人看的东西。
      if (!r.ok) throw new Error(d.error ?? 'request_failed');
      await refresh();
      if (d.hash) setSelected(d.hash);
      if (d.created === false) setError(t('rulePack.duplicate'));
    } catch (e) { setError(String((e as Error).message)); } finally { setBusy(false); }
  }
  async function remove(hash: string) {
    setBusy(true); setError('');
    try {
      const r = await fetch(`${base(projectId)}/${hash}`, { method: 'DELETE' });
      const d = await r.json() as { error?: string };
      if (!r.ok) throw new Error(d.error ?? 'request_failed');
      if (selected === hash) setSelected('');
      await refresh();
    } catch (e) { setError(String((e as Error).message)); } finally { setBusy(false); }
  }

  return <div className="flex min-h-0 flex-1 flex-col">
    <TopBar title={t('surface.rulePacks')} actions={<Button onClick={() => void refresh()}>{t('workflow.refresh')}</Button>} />
    <div className="min-h-0 flex-1 overflow-auto p-5">
      <p className="mb-4 max-w-3xl text-sm text-muted-foreground">{t('rulePack.intro')}</p>
      <label className="mb-5 flex flex-wrap items-center gap-3 text-sm">
        <span>{t('rulePack.upload')}</span>
        <input type="file" accept=".json" disabled={busy} onChange={e => {
          const f = e.target.files?.[0]; if (!f) return;
          if (f.size > 2_000_000) { setError(t('bench.fileTooLarge')); return; }
          void f.text().then(upload).finally(() => { e.target.value = ''; });
        }} />
      </label>
      {error && <p role="alert" className="mb-4 max-w-3xl break-words text-sm text-bad">{error}</p>}
      {!loaded ? <p role="status">{t('workflow.loading')}</p>
        : !packs.length ? <p className="text-sm text-muted-foreground">{t('rulePack.empty')}</p>
        : <div className="grid items-start gap-5 lg:grid-cols-[320px_minmax(0,1fr)]">
          <aside className="max-h-[70vh] overflow-auto rounded-lg border border-border">
            {packs.map(p => <div key={p.hash} className={`border-b border-border ${p.hash === selected ? 'bg-primary-soft' : ''}`}>
              <button aria-current={p.hash === selected} onClick={() => setSelected(p.hash)} className="block w-full px-4 py-3 text-left text-sm hover:bg-muted">
                <span className="block break-words font-medium">{p.packId} · v{p.version}</span>
                <span className="mt-1 block font-mono text-xs text-muted-foreground">{p.hash.slice(0, 12)} · {new Date(p.createdAt).toLocaleString()}</span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  {t('rulePack.counts', { m: p.counts.modules, f: p.counts.features, r: p.counts.rules, g: p.counts.targets })}
                </span>
                {/* 用过的版本不能删：运行的回执指着它，删了那次运行就说不清自己按什么跑的。 */}
                <span className={`mt-1 block text-xs ${p.usedByRuns.length ? 'text-ok' : 'text-muted-foreground'}`}>
                  {p.usedByRuns.length ? t('rulePack.usedBy', { n: p.usedByRuns.length }) : t('rulePack.unused')}
                </span>
              </button>
              {!p.usedByRuns.length && <div className="px-4 pb-3">
                <Button size="sm" disabled={busy} onClick={() => void remove(p.hash)}>{t('rulePack.delete')}</Button>
              </div>}
            </div>)}
          </aside>
          <div className="min-w-0">
            {body ? <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-card p-4 text-xs">{JSON.stringify(body, null, 2)}</pre>
              : <p className="py-6 text-sm text-muted-foreground">{t('rulePack.pick')}</p>}
          </div>
        </div>}
    </div>
  </div>;
}
