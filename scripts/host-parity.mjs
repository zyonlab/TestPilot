/**
 * **宿主入口要能覆盖 Web UI 的每一个操作——这条要能被检查，不能只是一句话。**
 *
 * 2026-09-14 用户定的方向：「只是将入口从 UI 换成了宿主」。当时实测的差距是
 * 160 条 HTTP 路由 vs 27 个 MCP 工具，而且没有任何机制会告诉你差在哪、差多少。
 * 这个仓库已经被「同一件事写两遍、其中一份悄悄落后」咬过好几次
 * （`sourceRefs` 同名不同义、宿主 plugin 副本落后四个文件两天没人知道）。
 *
 * 所以照 `check-drift` 的套路：**每一条路由都必须被显式分类**，
 * 分不了类就红。三种分类：
 *
 * - `host: "<tool>.<action>"` —— 宿主已经能做这件事；
 * - `todo` —— 还没做，带一句为什么它重要（覆盖率的分母）；
 * - `ui-only: "<理由>"` —— 故意不给宿主，理由要写下来。
 *
 * 注意 `ui-only` 不是「人工闸」的藏身处。用户明确说了宿主理论上要能覆盖全部操作——
 * 冻结模块树、批准用例这些**人做的决定**，在宿主里同样是人做的决定（人在 chat 里说），
 * agent 只是那只手。要保住的是审计属性：谁做的决定、经哪条入口进来的，
 * 记在账本上；而不是「宿主没有这个工具」。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERB = "get|post|put|patch|delete";

/** 从源码里把路由抠出来。泛型形式 `router.get<{…}>("/x")` 也要认——漏掉它等于凭空少几条。 */
export function routeInventory() {
  const out = [];
  const app = readFileSync(path.join(ROOT, "server/src/index.ts"), "utf8");
  for (const m of app.matchAll(new RegExp(`app\\.(${VERB})\\(\\s*['"\`](\\/api\\/[^'"\`]+)['"\`]`, "g")))
    out.push({ source: "index.ts", method: m[1].toUpperCase(), path: m[2] });
  const mounted = [
    ["server/src/runRoutes.ts", "/api/projects/:projectId/workflow-runs"],
    ["server/src/modelProfilesRoutes.ts", "/api/projects/:projectId/model-profiles"],
  ];
  for (const [file, prefix] of mounted) {
    const text = readFileSync(path.join(ROOT, file), "utf8");
    for (const m of text.matchAll(new RegExp(`router\\.(${VERB})(?:<[^>]*>)?\\(\\s*['"\`]([^'"\`]+)['"\`]`, "g")))
      out.push({ source: path.basename(file), method: m[1].toUpperCase(), path: prefix + (m[2] === "/" ? "" : m[2]) });
  }
  /**
   * 循环注册的路由要**展开**，不能留着 `${action}`。
   *
   * `runRoutes.ts` 用 `for (const action of […]) router.post(\`/:runId/stages/${action}\`)`
   * 注册了十几个真实端点；静态抠出来是一条带 `${action}` 的字符串。留着它，
   * 清单里就少了十几条真实操作，而覆盖率会显得好看——这正是这个检查要防的那种假象。
   *
   * 展开表跟着源码走：源码里那两个数组改了，这里对不上会在下面 `unexpanded` 处红。
   */
  const LOOPS = {
    "/api/projects/:projectId/workflow-runs/:runId/stages/${action}": [
      "instructions", "retrieve", "modules", "modules/state", "stories", "cases", "gate",
      "finalize", "g2", "execute", "decisions", "status", "units/claim", "units/write",
      "units/status", "units/merge",
    ],
    "/api/projects/:projectId/workflow-runs/:runId/artifacts/:revisionId/${action}": ["lineage", "diff", "export"],
  };
  const expanded = out.flatMap((r) => {
    const actions = LOOPS[r.path];
    return actions ? actions.map((a) => ({ ...r, path: r.path.replace("${action}", a) })) : [r];
  });
  const unexpanded = expanded.filter((r) => r.path.includes("${"));
  if (unexpanded.length)
    throw new Error(`路由清单里还有没展开的循环注册：${unexpanded.map((r) => r.path).join(", ")}——把它加进 LOOPS`);
  out.length = 0; out.push(...expanded);

  // 同一条路径同一个方法只算一次：几处循环注册会重复出现。
  const seen = new Set();
  return out.filter((r) => { const k = `${r.method} ${r.path}`; return seen.has(k) ? false : (seen.add(k), true); })
    .sort((a, b) => (a.path + a.method).localeCompare(b.path + b.method));
}

export const routeKey = (r) => `${r.method} ${r.path}`;
