import { LedgerError } from './runLedger.js';

/**
 * 前提里**明写了**是哪一页的，才当入口。业务性的前提照旧只给人看。
 *
 * 2026-09-15 Vikunja：前提写「已打开 http://localhost:3456/tasks/by/upcoming 且两个复选框都未勾选」，
 * 旧正则只认整行「打开 /路径」——完整地址、「已打开」、后半句三样都不认，于是入口退回首页，
 * 第一步「点『显示没有日期的任务』」在首页上找不到控件。两条用例这样红，产品什么事都没有。
 * 现在认完整地址（仍须同源）、认「已打开 / 停在 / 位于」，允许后面跟「且…」「，…」半句。
 */
const PAGE = /^(?:The page is|The visitor is on|Opened|Open|页面为|当前页面为|已打开|打开|停在|位于)\s*[`'"「]?((?:https?:\/\/[^\s`'"」，,。；;]+)|\/[^\s`'"」，,。；;]*)[`'"」]?(?:[.。]?$|\s+(?:且|并且|and\b).*$|[，,；;].*$)/i;

/** Resolve only explicit page preconditions. Other business preconditions remain visible for review. */
export function caseEntryUrl(preconditions:readonly string[],baseUrl:string):string {
  const routes=preconditions.flatMap(line=>{const match=PAGE.exec(line.trim());return match?[match[1].replace(/[.。]$/,'')]:[];});
  if(!routes.length)return baseUrl;
  const urls=[...new Set(routes.map(route=>new URL(route,baseUrl).href))];
  if(urls.length!==1)throw new LedgerError(409,'conflicting_page_preconditions');
  const parsed=new URL(urls[0]);if(!['http:','https:'].includes(parsed.protocol)||parsed.origin!==new URL(baseUrl).origin)throw new LedgerError(409,'page_precondition_origin_conflict');
  return parsed.href;
}

/**
 * 这条用例是不是**从未登录开始**。
 *
 * 环境配了登录步骤时，执行器给每条用例都先登录一遍。2026-09-15 Vikunja：前提写着
 * 「浏览器没有 Vikunja 会话」的 5 条（看登录页、错密码被拒、空提交、未登录访问被拦……）
 * 因此全红——它们从一开始就站在已登录的首页上，登录表单根本不存在。
 * 只认明写的未登录前提；「未连接钱包」不是未登录，不在这里。
 */
const LOGGED_OUT = /未登录|尚未登录|没有登录|已退出登录|没有(?:任何)?\s*\S{0,12}\s*会话|无会话|logged[- ]?out|not (?:logged|signed) in|no (?:active )?session|without (?:a )?session/i;
export const caseStartsLoggedOut = (preconditions: readonly string[]): boolean => preconditions.some((p) => LOGGED_OUT.test(p));
