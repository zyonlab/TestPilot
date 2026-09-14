/**
 * 会话池：同一个 key 下的连续运行共用一个浏览器会话。
 *
 * 为什么有它（07 T-28）：二跑缓存命中 95% 之后，每条用例仍有 28 秒地板——起浏览器 9.6 秒、
 * 登录态 18.4 秒——而登录态（dapp 里是 Enable Trading 的 agent 授权）存在浏览器 profile 里，
 * 不在 localStorage，会话注入吸收不了它。一个批次共用一个浏览器，登录态就只做一次。
 *
 * 这个模块不认识浏览器：它只管「同 key 同指纹就复用、指纹变了就换、release 就关」，
 * 创建与关闭由调用方传进来。这样它能在没有浏览器的测试里被逐条验证。
 * 指纹是调用方对「什么算同一个会话」的定义（url、钱包模式、链、视口……）；
 * 变异体运行永远不该进池——那份 DOM 被改过，下一条用例不能接着用。
 */
interface Entry<S> {
  session: S;
  fingerprint: string;
  uses: number;
  close: (s: S) => Promise<void>;
}

const pool = new Map<string, Entry<unknown>>();

export interface Acquired<S> {
  session: S;
  /** true = 这次复用了池里的会话，调用方要自己回到起点（导航、换 agent）。 */
  reused: boolean;
  uses: number;
}

export async function acquireSession<S>(
  key: string,
  fingerprint: string,
  create: () => Promise<S>,
  close: (s: S) => Promise<void>,
): Promise<Acquired<S>> {
  const cur = pool.get(key) as Entry<S> | undefined;
  if (cur && cur.fingerprint === fingerprint) {
    cur.uses += 1;
    return { session: cur.session, reused: true, uses: cur.uses };
  }
  if (cur) {
    // 同一个 key 换了指纹（另一个环境、另一种钱包模式）：旧的关掉，不能让两个浏览器都活着。
    pool.delete(key);
    await cur.close(cur.session).catch(() => {});
  }
  const session = await create();
  pool.set(key, { session, fingerprint, uses: 1, close: close as Entry<unknown>["close"] });
  return { session, reused: false, uses: 1 };
}

/** 关掉并移出。不在池里返回 false——调用方据此知道「没什么可释放的」而不是当成错误。 */
export async function releaseSession(key: string): Promise<boolean> {
  const cur = pool.get(key);
  if (!cur) return false;
  pool.delete(key);
  await cur.close(cur.session).catch(() => {});
  return true;
}

/** 一次运行把会话弄坏了（异常路径）：从池里丢掉，下一条从新浏览器开始，而不是接着用一个坏的。 */
export async function evictSession(key: string): Promise<void> {
  await releaseSession(key);
}

export const pooledSessionKeys = (): string[] => [...pool.keys()];

/** 复用时换了页面/agent：池里存的对象也要跟着换，否则下一条拿到的是关掉的旧页面。 */
export function replaceSession<S>(key: string, session: S): void {
  const cur = pool.get(key);
  if (cur) cur.session = session;
}
