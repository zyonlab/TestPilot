import {useT} from '@/lib/prefs';
import type {LoginFlow} from '@/lib/types';
export type IdentityChecks = {connected:string;address:string;network:string;authorized:string};
export const emptyIdentity = ():IdentityChecks=>({connected:'',address:'',network:'',authorized:''});
export function readIdentity(checks:LoginFlow['sessionChecks']):IdentityChecks {
 const rows=checks?.flatMap(c=>c.checks)??[];
 return Object.fromEntries(Object.keys(emptyIdentity()).map(k=>[k,rows.find(c=>c.kind===k)?.label??''])) as IdentityChecks;
}
export function writeIdentity(value:IdentityChecks):NonNullable<LoginFlow['sessionChecks']> {
 const checks=(Object.keys(value) as (keyof IdentityChecks)[]).filter(kind=>value[kind].trim()).map(kind=>({kind,label:value[kind].trim()}));
 return [...(value.connected.trim()?[{capability:'session' as const,checks:checks.filter(c=>c.kind==='connected')}]:[]),...(value.address.trim()||value.network.trim()?[{capability:'wallet-session' as const,checks:checks.filter(c=>c.kind!=='authorized')}]:[]),...(value.authorized.trim()?[{capability:'trading-authorized' as const,checks}]:[])];
}
export function SessionEvidenceFields({value=emptyIdentity(),onChange}:{value:IdentityChecks;onChange:(v:IdentityChecks)=>void}) {
 const t=useT();
 return <fieldset className="space-y-2 rounded border border-border p-3"><legend className="text-sm font-medium">{t('sut.sessionEvidence')}</legend><p className="text-xs text-muted-foreground">{t('sut.sessionEvidenceHint')}</p>{(Object.keys(value) as (keyof IdentityChecks)[]).map(kind=><label key={kind} className="block text-xs">{t(`sut.identity.${kind}`)}<input className="mt-1 block w-full rounded border border-border bg-background p-2 text-sm" value={value[kind]} onChange={e=>onChange({...value,[kind]:e.target.value})}/></label>)}</fieldset>;
}
