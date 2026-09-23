import type { Task } from './contracts.js';

/** No network business API or hidden DOM oracle: all observed outcomes are visible text. */
export function fixture(task:Task, variant:'healthy'|'intermediate'|'final') {
  const escape=(s:string)=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
  const states=[variant==='intermediate'?'Transition unavailable':task.intermediate,variant==='final'?'Completion unavailable':task.final];
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>${escape(task.title)}</title><style>body{font:20px system-ui;padding:64px}button{padding:16px;margin:12px}output{display:block;padding:24px;border:1px solid #bbb}</style><h1>${escape(task.title)}</h1><button>${escape(task.buttons[0])}</button><button>${escape(task.buttons[1])}</button><output aria-live="polite">${escape(task.initial)}</output><script>const states=${JSON.stringify(states).replaceAll('<','\\u003c')};document.querySelectorAll('button').forEach((b,i)=>b.onclick=()=>{document.querySelector('output').textContent=states[i]})</script></html>`;
}
