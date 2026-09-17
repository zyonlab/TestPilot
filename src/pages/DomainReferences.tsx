import { useCallback, useEffect, useState } from 'react';
import { API_BASE } from '@/lib/base';
import { useStore } from '@/lib/store';
import { useT } from '@/lib/prefs';
import { NeedProject } from '@/components/NeedProject';
import { TopBar } from '@/components/TopBar';
import { Button } from '@/components/ui';
import { FieldChatDrawer } from '@/components/FieldChatDrawer';

/**
 * 领域参考：这个产品有哪些不变量、用例可以拿什么去反驳它。按版本存。
 *
 * 2026-09-15 之前它不是项目数据，是代码——一段写死的永续合约不变量对每个产品默认发送，
 * 一个真正需要领域参考的新产品反而没有地方放自己的那份。现在它和规则包一个待遇：
 * 列出每一版、看内容、**聊出一版**、上传、删没用过的版本；新建运行时用最新那一版，冻结进运行。
 * 没有就没有——下游不会替这个产品补一段。
 */
type Version = { id: string; hash: string; title: string; chars: number; createdAt: string; usedByRuns: string[] };
const base = (projectId: string) => `${API_BASE}/api/projects/${encodeURIComponent(projectId)}/domain-references`;

export function DomainReferences() {
  const projectId = useStore(s => s.activeProjectId);
  return projectId ? <References key={projectId} projectId={projectId} /> : <NeedProject />;
}

function References({ projectId }: { projectId: string }) {
  const t = useT();
  const [refs, setRefs] = useState<Version[]>([]);
  const [selected, setSelected] = useState('');
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [drafting, setDrafting] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(base(projectId));
      const d = await r.json() as { references?: Version[]; error?: string };
      if (!r.ok) throw new Error(d.error ?? 'request_failed');
      setRefs(d.references ?? []); setError('');
    } catch (e) { setError(String((e as Error).message)); } finally { setLoaded(true); }
  }, [projectId]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!selected) { setText(''); return; }
    const c = new AbortController();
    void fetch(`${base(projectId)}/${selected}`, { signal: c.signal })
      .then(r => r.json()).then((d: { reference?: { text: string } }) => setText(d.reference?.text ?? '')).catch(() => {});
    return () => c.abort();
  }, [projectId, selected]);

  /** 上传和聊出来的走同一条保存路径；被拒的理由返回给抽屉，显示在按钮旁边。 */
  async function save(body: { title?: string; text: string }): Promise<string | void> {
    setBusy(true); setError('');
    try {
      const r = await fetch(base(projectId), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = await r.json() as { error?: string; created?: boolean; hash?: string };
      if (!r.ok) throw new Error(d.error ?? 'request_failed');
      await refresh();
      if (d.hash) setSelected(d.hash);
      if (d.created === false) setError(t('domainRef.duplicate'));
    } catch (e) { const m = String((e as Error).message); setError(m); return m; } finally { setBusy(false); }
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
    <TopBar title={t('surface.domainReferences')} actions={<Button onClick={() => void refresh()}>{t('workflow.refresh')}</Button>} />
    <div className="min-h-0 flex-1 overflow-auto p-5">
      <p className="mb-4 max-w-3xl text-sm text-muted-foreground">{t('domainRef.intro')}</p>
      <div className="mb-5 flex flex-wrap items-center gap-3 text-sm">
        <Button variant="primary" disabled={busy} onClick={() => setDrafting(true)}>{t('domainRef.draft')}</Button>
        <label htmlFor="domain-ref-upload">{t('domainRef.upload')}</label>
        <input id="domain-ref-upload" type="file" accept=".md,.txt" disabled={busy} onChange={e => {
          const f = e.target.files?.[0]; if (!f) return;
          if (f.size > 2_000_000) { setError(t('bench.fileTooLarge')); return; }
          void f.text().then(body => save({ title: f.name, text: body })).finally(() => { e.target.value = ''; });
        }} />
      </div>
      {error && <p role="alert" className="mb-4 max-w-3xl break-words text-sm text-bad">{error}</p>}
      {!loaded ? <p role="status">{t('workflow.loading')}</p>
        : !refs.length ? <p className="text-sm text-muted-foreground">{t('domainRef.empty')}</p>
        : <div className="grid items-start gap-5 lg:grid-cols-[320px_minmax(0,1fr)]">
          <aside className="max-h-[70vh] overflow-auto rounded-lg border border-border">
            {refs.map(v => <div key={v.hash} className={`border-b border-border ${v.hash === selected ? 'bg-primary-soft' : ''}`}>
              <button aria-current={v.hash === selected} onClick={() => setSelected(v.hash)} className="block w-full px-4 py-3 text-left text-sm hover:bg-muted">
                <span className="block break-words font-medium">{v.title}</span>
                <span className="mt-1 block font-mono text-xs text-muted-foreground">{v.hash.slice(0, 12)} · {new Date(v.createdAt).toLocaleString()} · {t('domainRef.chars', { n: v.chars })}</span>
                <span className={`mt-1 block text-xs ${v.usedByRuns.length ? 'text-ok' : 'text-muted-foreground'}`}>
                  {v.usedByRuns.length ? t('domainRef.usedBy', { n: v.usedByRuns.length }) : t('domainRef.unused')}
                </span>
              </button>
              {!v.usedByRuns.length && <div className="px-4 pb-3">
                <Button size="sm" disabled={busy} onClick={() => void remove(v.hash)}>{t('domainRef.delete')}</Button>
              </div>}
            </div>)}
          </aside>
          <div className="min-w-0">
            {text ? <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-card p-4 text-xs">{text}</pre>
              : <p className="py-6 text-sm text-muted-foreground">{t('domainRef.pick')}</p>}
          </div>
        </div>}
    </div>
    {drafting && <FieldChatDrawer field="domainReference" title={t('surface.domainReferences')} projectId={projectId}
      onApply={v => save({ text: String(v) })} onClose={() => setDrafting(false)} />}
  </div>;
}
