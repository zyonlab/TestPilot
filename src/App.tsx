import { useEffect, useState } from "react";
import { WorkspacePage } from "./pages/Workspace";

/**
 * 一个界面。
 *
 * 之前是五个落点、十九个分节——那解决了「东西放哪」，没解决「东西太多」。目录要求人先记住
 * 每样东西归在哪一类才找得到它，而这是一个垂类 agent 产品：应该只有一处干活的地方，
 * 其余的东西**通过你正在处理的那个对象**进入。
 *
 * 所以这里没有路由表，只有工作台：chat 在左，画布在右，产物卡从产出它的那一步打开，
 * 设置退到一个抽屉里。
 *
 * 旧地址仍然可用，但它们不再是地址，而是「打开哪张卡」：`#/cases` 会变成 `#/?open=cases`。
 * 拆掉导航不该顺手作废别人存下的链接。
 */
const LEGACY: Record<string, string> = {
  "/cases": "cases",
  "/review": "review",
  "/trace": "trace",
  "/code": "code",
  "/changes": "changes",
  "/deliver": "deliver",
  "/runs": "runs",
  "/suite": "batches",
  "/batches": "batches",
  "/baselines": "baselines",
  "/trends": "trends",
  "/evals": "evals",
  "/assets": "cases",
  "/history": "runs",
};

/** Old section addresses carried their section in `?s=`; that name is now the card's name. */
function normalise(): void {
  const raw = window.location.hash.replace(/^#/, "") || "/";
  const [path, query] = raw.split("?");
  const params = new URLSearchParams(query ?? "");
  if (params.get("open")) return;

  /**
   * `#/review/<runId>` 是给人发链接用的短写法。
   *
   * 这个应用只有一个地址，别的路径一律被规整回 `#/`——包括这一个，
   * 于是「请复核这一次」这句话没有对应的链接可发。规整成
   * `#/?open=review&run=<id>`，短写法照样能用，内部仍然只有一个地址。
   */
  const deep = /^\/review\/(wf-[A-Za-z0-9_-]+)$/.exec(path ?? "");
  if (deep) {
    window.location.hash = `#/?open=review&run=${deep[1]}`;
    return;
  }

  const section = params.get("s");
  const card = (section && LEGACY[`/${section}`]) || LEGACY[path];
  // 设置 is a drawer rather than a card, and the workspace itself is the address.
  if (path === "/settings" || path === "/projects" || path === "/model" || path === "/chain" ||
      path === "/processes" || path === "/capabilities") {
    window.location.hash = "#/";
    return;
  }
  if (card) window.location.hash = `#/?open=${card}`;
  else if (path !== "/" && path !== "/workspace" && path !== "/canvas") window.location.hash = "#/";
  else if (path !== "/") window.location.hash = query ? `#/?${query}` : "#/";
}

export function App() {
  const [, force] = useState(0);
  useEffect(() => {
    normalise();
    const onHash = () => {
      normalise();
      force((n) => n + 1);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  return (
    <div className="flex h-screen w-full overflow-hidden">
      <div className="flex min-w-0 flex-1 flex-col">
        <WorkspacePage />
      </div>
    </div>
  );
}
