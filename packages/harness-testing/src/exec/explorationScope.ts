/** Query values may select a market; hash routes retain their path boundary. */
export function sameExplorationPage(entry: string, candidate: string, templates: string[] = []): boolean {
  try {
    const a=new URL(entry), b=new URL(candidate,entry);
    const hashPath=(u:URL)=>u.hash.startsWith('#/')||u.hash.startsWith('#!/')?u.hash.split('?')[0]:'';
    const matches = (path: string, template: string) => {
      if (!template.startsWith('/') || template.includes('?') || template.includes('#')) return false;
      const parts=template.split('/'), actual=path.split('/');
      return parts.length===actual.length && parts.every((part,i)=>part.startsWith(':') ? /^[^/]+$/.test(actual[i]??'') : part===actual[i]);
    };
    const pathAllowed = a.pathname===b.pathname || templates.some(template=> {
      const root=template.split('/:')[0];
      return (a.pathname===root || matches(a.pathname,template)) && (b.pathname===root || matches(b.pathname,template));
    });
    return a.origin===b.origin&&pathAllowed&&hashPath(a)===hashPath(b);
  } catch { return false; }
}
