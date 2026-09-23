import {z} from 'zod';
export const InjectedSessionCheckSchema=z.object({
 address:z.string().regex(/^0x[0-9a-fA-F]{40}$/),
 origin:z.string().url(),
 readyLabel:z.string().trim().min(1),
 disconnectedLabels:z.array(z.string().trim().min(1)).min(1),
}).strict();
export type InjectedSessionCheck=z.infer<typeof InjectedSessionCheckSchema>;
export type WalletSignatureReceipt={origin:string;method:string;at:number};
/** Receipts come from the Node signer, not planner declarations or page JavaScript. */
export function verifyInjectedSession(check:InjectedSessionCheck,input:{address?:string;url:string;labels:string[];receipts:WalletSignatureReceipt[]}){
 let origin:string;try{origin=new URL(input.url).origin;if(new URL(check.origin).origin!==check.origin)return false;}catch{return false;}
 const labels=new Set(input.labels.map(s=>s.trim()));
 return origin===check.origin && input.address?.toLowerCase()===check.address.toLowerCase()
  && labels.has(check.readyLabel) && !check.disconnectedLabels.some(label=>labels.has(label))
  && input.receipts.some(r=>r.origin===origin&&r.at>0&&['personal_sign','eth_sign','eth_signTypedData','eth_signTypedData_v4'].includes(r.method));
}
