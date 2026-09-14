import { readFileSync } from "node:fs";
/** Run capabilities stay inside MCP memory; the model receives public metadata only. */
export class RunGateway {
  private grants = new Map<string, { projectId: string; token: string }>();
  constructor(private base = process.env.TP_SERVER_URL || "http://127.0.0.1:5301", private send: typeof fetch = fetch) {
    if (process.env.TP_RUN_GRANT_FILE) {
      const grant = JSON.parse(readFileSync(process.env.TP_RUN_GRANT_FILE, "utf8"));
      if (typeof grant.runId !== "string" || typeof grant.projectId !== "string" || !/^[a-f0-9]{64}$/.test(grant.token)) throw new Error("invalid_run_grant");
      this.grants.set(grant.runId, { projectId: grant.projectId, token: grant.token });
    }
  }
  private async request(path: string, body?: unknown, token?: string) {
    const res = await this.send(`${this.base}${path}`, { method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60_000) });
    const value = await res.json() as Record<string, any>;
    if (!res.ok) throw new Error(`run_gateway:${String(value.code ?? res.status)}`);
    return value;
  }
  async register(projectId: string, input: Record<string, unknown>) {
    const value = await this.request(`/api/projects/${encodeURIComponent(projectId)}/workflow-runs/register`, input);
    if (typeof value.runId !== "string" || typeof value.writeToken !== "string") throw new Error("invalid_run_registration_response");
    this.grants.set(value.runId, { projectId, token: value.writeToken });
    const { writeToken: _token, ...publicValue } = value; return publicValue;
  }
  async read(projectId: string, runId: string) {
    return this.request(`/api/projects/${encodeURIComponent(projectId)}/workflow-runs/${encodeURIComponent(runId)}`);
  }
  async call(runId: string, action: string, body: unknown) {
    const grant = this.grants.get(runId);
    if (!grant) throw new Error("run_not_registered_in_this_mcp_session");
    return this.request(`/api/projects/${encodeURIComponent(grant.projectId)}/workflow-runs/${encodeURIComponent(runId)}/${action}`, body, grant.token);
  }
  async registeredRun(runId: string) {
    const grant = this.grants.get(runId); if (!grant) throw new Error("run_not_registered_in_this_mcp_session");
    return this.read(grant.projectId, runId);
  }
  async artifact(runId: string, revisionId: string) {
    const grant = this.grants.get(runId); if (!grant) throw new Error("run_not_registered_in_this_mcp_session");
    return this.request(`/api/projects/${encodeURIComponent(grant.projectId)}/workflow-runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(revisionId)}`);
  }
  /**
   * 收下一条**别处注册的** run 的授权。
   *
   * 令牌只能由持有它的一方给进来（本地联调脚本从服务端签发），这个类不去别处取——
   * 它的全部作用就是让授权留在 MCP 进程内存里，不经过模型。
   */
  adoptGrant(projectId: string, runId: string, token: string) {
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("invalid_run_grant");
    this.grants.set(runId, { projectId, token });
  }
  has(runId: string) { return this.grants.has(runId); }
  get registered() { return this.grants.size > 0; }
}
