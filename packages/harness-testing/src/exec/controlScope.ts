/** Browser functions: self-contained so both Puppeteer and fixture tests run the production code. */
export function availableControlSelectors(selectors:string[]):string[] {
  const available:string[]=[];
  for(const selector of selectors){
    const e=document.querySelector(selector);
    if(!e)continue;
    const r=e.getBoundingClientRect();
    const x=r.left+r.width/2,y=r.top+r.height/2;
    const hit=document.elementFromPoint(x,y);
    if(r.width>0&&r.height>0&&hit&&(hit===e||e.contains(hit)))available.push(selector);
  }
  return available;
}

export function readControlScopes(selectors:string[]):string[][] {
  const results:string[][]=[];
  for(const selector of selectors){
    const scopes:string[]=[];
    let e=document.querySelector(selector)?.parentElement;
    for(let depth=0;e&&depth<10;e=e.parentElement,depth++){
      if(['BODY','HTML','MAIN'].includes(e.tagName))break;
      const text=(e.innerText||'').replace(/\s+/g,' ').trim();
      if(text&&text.length<=1500&&!scopes.includes(text))scopes.push(text);
      if(e.matches('[role="dialog"],[role="alertdialog"],[aria-modal="true"],form,[role="region"],section'))break;
    }
    results.push(scopes);
  }
  return results;
}

export function activateScopedControl(input:{sel:string;label:string;within?:string[];near?:string[]}):string {
  const candidates:HTMLElement[]=[];
  const direct=document.querySelector(input.sel);
  for(const node of document.querySelectorAll('button,a,div,span,input,label,[role="tab"]')){
    const e=node as HTMLElement,r=e.getBoundingClientRect();
    if(!r.width||!r.height||getComputedStyle(e).visibility==='hidden'||getComputedStyle(e).display==='none'||e.matches(':disabled,[aria-disabled="true"]'))continue;
    const label=(e.innerText||(e as HTMLInputElement).value||e.getAttribute('aria-label')||'').replace(/\s+/g,' ').trim();
    if(label!==input.label)continue;
    if(input.near?.length){
      let matched=false;
      for(let parent=e.parentElement,depth=0;parent&&depth<10;parent=parent.parentElement,depth++){
        if(['BODY','HTML','MAIN'].includes(parent.tagName))break;
        const text=(parent.innerText||'').replace(/\s+/g,' ').trim();
        if(text.length<=1500&&input.near.every(pattern=>new RegExp(pattern,'i').test(text))){matched=true;break;}
        if(parent.matches('[role="dialog"],[role="alertdialog"],[aria-modal="true"],form,[role="region"],section'))break;
      }
      if(!matched)continue;
    }
    if(input.within?.length){
      let text='';
      for(let parent:HTMLElement|null=e,depth=0;parent&&depth<12;parent=parent.parentElement,depth++){
        const style=getComputedStyle(parent),cls=typeof parent.className==='string'?parent.className:'';
        const floating=['fixed','absolute'].includes(style.position)&&Number.parseInt(style.zIndex||'0',10)>=10&&parent.offsetWidth>=200&&parent.offsetHeight>=100;
        if(parent.matches('[role="dialog"],[role="alertdialog"],[aria-modal="true"]')||/modal|dialog|popup|drawer|overlay/i.test(cls)||floating){text=(parent.innerText||'').replace(/\s+/g,' ').trim().slice(0,120);break;}
      }
      if(!input.within.some(pattern=>new RegExp(pattern,'i').test(text)))continue;
    }
    candidates.push(e);
  }
  // Keep the browser function self-contained: named inner closures acquire __name
  // helpers under the production tsx loader, which do not exist in the page.
  let selected:HTMLElement|undefined;
  let result='selector';
  if(direct&&candidates.includes(direct as HTMLElement))selected=direct as HTMLElement;
  else {
    const leaves=candidates.filter(e=>!candidates.some(other=>other!==e&&e.contains(other)));
    if(leaves.length!==1)return `ambiguous:${leaves.length}`;
    selected=leaves[0];result='relocated';
  }
  selected!.scrollIntoView({block:'center',inline:'nearest'});
  const r=selected!.getBoundingClientRect();
  const hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
  if(!hit || (hit!==selected && !selected!.contains(hit)))return 'ambiguous:occluded';
  selected!.click();return result;
}
