import { createHash } from 'node:crypto';
import { canonicalJSON } from '@testpilot/harness-core/run-contracts';
export const CACHE_POLICY_VERSION='context-v4-viewport';
export function cacheDigest(value:unknown):string { return createHash('sha256').update(canonicalJSON(value)).digest('hex'); }
/** Full context and initial scene. Old unscoped caches are deliberately not replayed. */
export function scopedCacheId(id:string|undefined, context:unknown, page:{url:string;dom:string;scene:string}):string|undefined {
 return id ? `tp-${CACHE_POLICY_VERSION}-${cacheDigest({id,context,page})}` : undefined;
}
