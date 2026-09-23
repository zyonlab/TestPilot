import { useT } from '@/lib/prefs';
export function ExplorationSettings({maxScreens,scope,onChange}:{maxScreens:number;scope:'current-url'|'rules';onChange:(maxScreens:number,scope:'current-url'|'rules')=>void}) {
  const t=useT();
  const field='rounded-md border border-border bg-background px-2.5 py-1.5 text-sm';
  return <div className="space-y-2">
    <label className="flex flex-wrap items-center gap-2 text-sm">{t('exploration.budget')}
      <select className={field} value={maxScreens===0?'unlimited':'limited'} onChange={e=>onChange(e.target.value==='unlimited'?0:20,e.target.value==='unlimited'?'current-url':scope)}>
        <option value="limited">{t('exploration.limited')}</option><option value="unlimited">{t('exploration.unlimited')}</option>
      </select>
      {maxScreens!==0&&<input aria-label={t('bench.maxScreens')} className={`${field} w-24`} type="number" min={1} max={50} value={maxScreens} onChange={e=>{const n=Number(e.target.value);if(Number.isInteger(n)&&n>=1&&n<=50)onChange(n,scope);}}/>}
    </label>
    <label className="flex flex-wrap items-center gap-2 text-sm">{t('exploration.scope')}
      <select className={field} value={maxScreens===0?'current-url':scope} disabled={maxScreens===0} onChange={e=>onChange(maxScreens,e.target.value as 'current-url'|'rules')}>
        <option value="current-url">{t('exploration.currentUrl')}</option><option value="rules">{t('exploration.rules')}</option>
      </select>
    </label>
    <p className="text-xs text-muted-foreground">{t('exploration.hint')}</p>
  </div>;
}
