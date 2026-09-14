import { z } from "zod";
import type { HostApi } from "./api.js";
import { DOMAINS, type ActionSpec, type DomainSpec } from "./registry.js";

/**
 * 把路由表变成 MCP 工具。
 *
 * **一个域一个工具，动作是枚举**，而不是一条路由一个工具。180 条路由摊成 180 个工具，
 * agent 的工具列表会长到没法读，而且每加一条 UI 路由就要动一次工具注册；
 * 十来个域工具让清单可读，映射收在 `registry.ts` 一处。
 *
 * 这一层同样不懂业务：填路径参数、带上凭证、把服务端的回答原样递回去。
 */

/** 路径模板 + 参数 → 实际路径。缺参数当场抛，不发一个注定 404 的请求。 */
export function fillPath(spec: ActionSpec, params: Record<string, string | undefined>): string {
  let path = spec.path;
  for (const name of spec.params ?? []) {
    const value = params[name];
    if (!value) throw new Error(`缺少路径参数 ${name}（这个动作需要 ${(spec.params ?? []).join("、")}）`);
    path = path.replace(`:${name}`, encodeURIComponent(value));
  }
  const left = path.match(/:[a-zA-Z]+/);
  if (left) throw new Error(`路径里还有没填的参数 ${left[0]}——registry 的 params 漏了它`);
  return path;
}

/** 动作清单，进工具描述。agent 靠它选动作，所以要写人话。 */
export function describeActions(domain: DomainSpec): string {
  return Object.entries(domain.actions)
    .map(([name, s]) => `  ${name}${s.mutates ? "（会改东西）" : ""} — ${s.summary}`)
    .join("\n");
}

export interface ToolHost {
  registerTool(
    name: string,
    config: { title: string; description: string; inputSchema: Record<string, z.ZodTypeAny> },
    handler: (input: Record<string, unknown>) => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>,
  ): void;
}

const ok = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value ?? null) }] });
const fail = (e: unknown) => ({ content: [{ type: "text" as const, text: String((e as Error)?.message ?? e) }], isError: true });

export function registerHostDomains(server: ToolHost, api: HostApi, domains: readonly DomainSpec[] = DOMAINS): void {
  for (const domain of domains) {
    const names = Object.keys(domain.actions) as [string, ...string[]];
    server.registerTool(
      domain.tool,
      {
        title: domain.title,
        description: `${domain.description}\n\n动作：\n${describeActions(domain)}`,
        inputSchema: {
          action: z.enum(names),
          /** 路径参数放这里：projectId / runId / caseId 之类。 */
          params: z.record(z.string()).optional(),
          /** 请求体。形状由动作决定，服务端会校验并说明缺了什么。 */
          body: z.unknown().optional(),
        },
      },
      async (input) => {
        try {
          const action = String(input.action);
          const spec = domain.actions[action];
          if (!spec) throw new Error(`${domain.tool} 没有动作 ${action}`);
          const params = (input.params ?? {}) as Record<string, string | undefined>;
          const path = fillPath(spec, params);
          const body = spec.body ? spec.body.parse(input.body ?? {}) : spec.method === "GET" ? undefined : (input.body ?? {});
          const runId = spec.needsRunGrant ? params.runId : undefined;
          return ok(await api.call(spec.method, path, body, runId));
        } catch (e) { return fail(e); }
      },
    );
  }
}
