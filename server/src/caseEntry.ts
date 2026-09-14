import { LedgerError } from './runLedger.js';
/** Resolve only explicit page preconditions. Other business preconditions remain visible for review. */
export function caseEntryUrl(preconditions:readonly string[],baseUrl:string):string {
  const routes=preconditions.flatMap(line=>{const match=/^(?:The page is|The visitor is on|Open|页面为|当前页面为|打开)\s*[`'"]?(\/[^\s`'"]*)[`'"]?[.。]?$/i.exec(line.trim());return match?[match[1].replace(/[.。]$/,'')]:[];});
  if(!routes.length)return baseUrl;
  const urls=[...new Set(routes.map(route=>new URL(route,baseUrl).href))];
  if(urls.length!==1)throw new LedgerError(409,'conflicting_page_preconditions');
  const parsed=new URL(urls[0]);if(!['http:','https:'].includes(parsed.protocol)||parsed.origin!==new URL(baseUrl).origin)throw new LedgerError(409,'page_precondition_origin_conflict');
  return parsed.href;
}
