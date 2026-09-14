import type { CorsOptions } from 'cors';
/** Local Web requests may cross development ports, only for the configured UI origins. */
export function trustedWebOrigin(origin:string|undefined):boolean {
 if(!origin)return true;
 try{const url=new URL(origin);return ['localhost','127.0.0.1','[::1]'].includes(url.hostname)&&['http:','https:'].includes(url.protocol)||(process.env.TP_WEB_ORIGINS??'').split(',').map(s=>s.trim()).includes(url.origin);}catch{return false;}
}
export const reviewCorsOptions:CorsOptions={credentials:true,origin:(origin,callback)=>callback(null,trustedWebOrigin(origin))};
