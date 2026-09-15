import {expect,it} from 'vitest';
import {caseEntryUrl, caseStartsLoggedOut} from '../src/caseEntry.js';
it('applies an explicit page precondition before every independent case',()=>{expect(caseEntryUrl(['The page is /portfolio','The visitor is not connected'],'https://example.test/trade')).toBe('https://example.test/portfolio');expect(caseEntryUrl(['The page is /trade/HYPE/USDC'],'https://example.test/trade')).toBe('https://example.test/trade/HYPE/USDC');});
it('does not guess pages from business prose and rejects ambiguity and cross-origin paths',()=>{expect(caseEntryUrl(['View the portfolio'],'https://example.test/trade')).toBe('https://example.test/trade');expect(()=>caseEntryUrl(['The page is //other.test/'],'https://example.test/trade')).toThrow('page_precondition_origin_conflict');expect(()=>caseEntryUrl(['The page is /a','The page is /b'],'https://example.test/trade')).toThrow('conflicting_page_preconditions');});

// 2026-09-15 Vikunja：完整地址 +「已打开」+ 后半句，旧正则一样都不认，入口退回首页。
it('reads an explicit page from a full same-origin URL, with 已打开 and a trailing clause',()=>{
  const base='http://localhost:3456/';
  expect(caseEntryUrl(['已用 tptest 登录','已打开 http://localhost:3456/tasks/by/upcoming 且两个复选框都未勾选'],base)).toBe('http://localhost:3456/tasks/by/upcoming');
  expect(caseEntryUrl(['浏览器没有 Vikunja 会话','已打开 http://localhost:3456/login'],base)).toBe('http://localhost:3456/login');
  expect(caseEntryUrl(['已打开 /projects，清单不为空'],base)).toBe('http://localhost:3456/projects');
  expect(()=>caseEntryUrl(['已打开 http://other.test/login'],base)).toThrow('page_precondition_origin_conflict');
  // 句子里顺带提到一个地址，不算前提声明。
  expect(caseEntryUrl(['账号下的项目在 /projects 里能看到'],base)).toBe(base);
});
it('knows which cases start logged out — and that an unconnected wallet is not that',()=>{
  expect(caseStartsLoggedOut(['浏览器没有 Vikunja 会话','已打开 http://localhost:3456/login'])).toBe(true);
  expect(caseStartsLoggedOut(['用户未登录'])).toBe(true);
  expect(caseStartsLoggedOut(['The visitor is logged out'])).toBe(true);
  expect(caseStartsLoggedOut(['已用 ${env.USERNAME} 登录 Vikunja'])).toBe(false);
  expect(caseStartsLoggedOut(['The visitor is not connected'])).toBe(false);
});
