import {it,expect} from 'vitest';
import {verifyInjectedSession} from '../src/domain/injectedSessionEvidence.js';
const address='0x'+'1'.repeat(40),origin='https://test.example';
const check={address,origin,readyLabel:'Place Order',disconnectedLabels:['Enable Trading','Connect Wallet']};
const input={address,url:origin+'/trade/ETH',labels:['Place Order','0x111...111'],receipts:[{origin,method:'eth_signTypedData_v4',at:100}]};
it('uses signer identity and site receipt with a visible completed login',()=>expect(verifyInjectedSession(check,input)).toBe(true));
it('injection alone is insufficient',()=>expect(verifyInjectedSession(check,{...input,receipts:[]})).toBe(false));
it('rejects another account',()=>expect(verifyInjectedSession(check,{...input,address:'0x'+'2'.repeat(40)})).toBe(false));
it('rejects another site or its signature',()=>{
 expect(verifyInjectedSession(check,{...input,url:'https://other.example/trade'})).toBe(false);
 expect(verifyInjectedSession(check,{...input,receipts:[{origin:'https://other.example',method:'personal_sign',at:100}]})).toBe(false);
});
it('requires visible application completion and revokes on disconnect',()=>{
 expect(verifyInjectedSession(check,{...input,labels:[]})).toBe(false);
 expect(verifyInjectedSession(check,{...input,labels:['Place Order','Enable Trading']})).toBe(false);
});
it('a transaction receipt is not login proof',()=>expect(verifyInjectedSession(check,{...input,receipts:[{origin,method:'eth_sendTransaction',at:100}]})).toBe(false));
