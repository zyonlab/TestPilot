interface ElementTree {node:{isVisible:boolean}|null;children:ElementTree[]}
/** Keep visible element identities and ancestors. No changes to the application DOM. */
export function visibleContextTree<T extends ElementTree>(tree:T):T {
  const children=tree.children.map(c=>visibleContextTree(c)).filter(c=>c.node!==null||c.children.length>0);
  return {...tree,node:tree.node?.isVisible?tree.node:null,children} as T;
}
