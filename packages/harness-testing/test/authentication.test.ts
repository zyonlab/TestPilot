import {it,expect} from 'vitest';
import {authenticationState,shouldRunLogin,storageForOrigin} from '../src/exec/authentication.js';
const input={url:'https://app.test/dashboard',labels:['Sign out'],receipts:[]};
it('checks restored ordinary sessions without wallet requirements',()=>{
 expect(authenticationState({sessionChecks:[{capability:'session',checks:[{kind:'connected',label:'Sign out'}]}]},input)).toBe(true);
 expect(authenticationState({sessionChecks:[{capability:'session',checks:[{kind:'connected',label:'My account'}]}]},input)).toBe(false);
 expect(authenticationState({},input)).toBeUndefined();
});
it('only retries configured login for invalid sessions, not verified sessions',()=>{
 expect(shouldRunLogin(true,true,true)).toBe(false);
 expect(shouldRunLogin(false,true,true)).toBe(true);
 expect(shouldRunLogin(false,true,false)).toBe(false);
 expect(shouldRunLogin(undefined,true,true)).toBe(false);
 expect(shouldRunLogin(undefined,false,true)).toBe(true);
});
it('never applies another origin storage across scheme, host or port',()=>{
 const origins=[{origin:'https://app.test',localStorage:[{name:'token',value:'fixture'}]}];
 expect(storageForOrigin(input.url,origins)).toEqual(origins[0].localStorage);
 for(const url of ['http://app.test','https://other.test','https://app.test:444','bad'])expect(storageForOrigin(url,origins)).toEqual([]);
});
it('mixed wallet and cookie checks must all succeed',()=>{
 const address='0x'+'1'.repeat(40),origin='https://app.test';
 const checks={sessionChecks:[{capability:'session' as const,checks:[{kind:'connected' as const,label:'Sign out'}]}],injectedSessionCheck:{address,origin,readyLabel:'Place Order',disconnectedLabels:['Connect']}};
 expect(authenticationState(checks,{...input,address,labels:['Sign out','Place Order'],receipts:[{origin,method:'personal_sign',at:1}]})).toBe(true);
 expect(authenticationState(checks,{...input,address,labels:['Place Order'],receipts:[{origin,method:'personal_sign',at:1}]})).toBe(false);
});

import {classifyFailure,isInfraError} from '../src/failure.js';
it('attributes failed authentication to environment, never a product assertion',()=>{
 const message='AUTHENTICATION_NOT_VERIFIED: configured checks failed';
 expect(isInfraError(message)).toBe(true);
 expect(classifyFailure(message)).toMatchObject({code:'AUTHENTICATION_NOT_VERIFIED',attribution:'infra',retryable:false});
});
