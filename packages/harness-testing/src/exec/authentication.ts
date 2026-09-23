import {verifySessionChecks,type SessionCheck} from '../domain/sessionEvidence.js';
import {verifyInjectedSession,type InjectedSessionCheck,type WalletSignatureReceipt} from '../domain/injectedSessionEvidence.js';
export interface AuthenticationChecks {sessionChecks?:SessionCheck[];injectedSessionCheck?:InjectedSessionCheck}
/** Undefined means unverified, never authenticated. Cookie presence is not proof. */
export function authenticationState(checks:AuthenticationChecks,input:{url:string;labels:string[];address?:string;receipts:WalletSignatureReceipt[]}):boolean|undefined {
 const results=verifySessionChecks(checks.sessionChecks??[],input.labels).map(r=>r.verified);
 if(checks.injectedSessionCheck)results.push(verifyInjectedSession(checks.injectedSessionCheck,input));
 return results.length?results.every(Boolean):undefined;
}
export function shouldRunLogin(verified:boolean|undefined,hasRestoredSession:boolean,hasSteps:boolean){
 return hasSteps && verified!==true && !(verified===undefined&&hasRestoredSession);
}
export function storageForOrigin(url:string,origins:Array<{origin:string;localStorage:{name:string;value:string}[]}> = []){
 try{return origins.find(o=>o.origin===new URL(url).origin)?.localStorage??[];}catch{return [];}
}
