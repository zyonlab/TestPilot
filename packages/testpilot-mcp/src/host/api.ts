/**
 * 宿主工具唯一的传输层。
 *
 * **它只搬字节，不懂业务。** 所有判断——谁能做什么、什么算合法、哪一步该拒——
 * 都在服务端，和 Web UI 走的是同一套 HTTP 接口。这是「宿主是 UI 的等价入口」
 * 唯一可维护的实现方式：两条入口共用一份实现，接口改了两边同时改，
 * 不会出现「同一件事写两遍、其中一份悄悄落后」——这个仓库已经被那件事咬过好几次。
 */

export interface ApiOptions {
  baseUrl?: string;
  /** 需要运行写入凭证的动作，从这里取。取不到就不带——服务端会如实拒。 */
  tokenFor?: (runId: string) => string | undefined;
  fetchImpl?: typeof fetch;
}

export class HostApi {
  private readonly base: string;
  constructor(private readonly opts: ApiOptions = {}) {
    this.base = (opts.baseUrl ?? process.env.TP_SERVER_URL ?? "http://127.0.0.1:5301").replace(/\/+$/, "");
  }

  /**
   * 一次调用。失败时**把服务端的话原样带回去**，不翻译成自己的错误码：
   * 服务端的拒绝理由是写给人看的（「树没冻结」「出处对不上」），
   * 在这里压成 `host_api_failed` 会让 agent 只知道失败、不知道为什么。
   */
  async call(method: string, path: string, body?: unknown, runId?: string): Promise<unknown> {
    const token = runId ? this.opts.tokenFor?.(runId) : undefined;
    const res = await (this.opts.fetchImpl ?? fetch)(`${this.base}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(Number(process.env.TP_HOST_API_TIMEOUT_MS ?? 120_000)),
    });
    const text = await res.text();
    let value: unknown;
    try { value = text ? JSON.parse(text) : {}; } catch { value = { raw: text.slice(0, 2000) }; }
    if (!res.ok) {
      const detail = value as { error?: string; code?: string; reason?: string; message?: string };
      const said = detail.reason ?? detail.error ?? detail.message ?? detail.code ?? `http_${res.status}`;
      throw new Error(`${method} ${path} → ${res.status}: ${said}`);
    }
    return value;
  }
}
