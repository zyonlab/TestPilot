import { createBirpc, type BirpcReturn } from "birpc";
import type { ChildProcess } from "node:child_process";
import { EVENT_METHODS, type ParentApi } from "./protocol.js";

// Transport: the IPC channel created by child_process.fork (structured JSON messages).
// Our frames are tagged so the channel can carry other traffic without confusing birpc.
interface Frame {
  __rpc: unknown;
}
const isFrame = (m: unknown): m is Frame =>
  typeof m === "object" && m !== null && "__rpc" in (m as Record<string, unknown>);

/**
 * 对面死了的时候，把还悬着的调用结掉。
 *
 * 两个方向都设了 `timeout: -1`，那是对的：一次视觉判断要几十秒，一次完整用例要几分钟，
 * birpc 默认的 60 秒会把健康的工作腰斩。但去掉超时之后留下一个洞——**心跳只负责宣布对面
 * 死了并把它拉起来，它不会把已经发出去、永远等不到回复的那些调用结掉。**
 *
 * 于是：runner 崩在一次 `execCase` 中间，agent 那边的 `await` 永远不返回，`repair.loop`
 * 卡在那条用例上，整次运行永远停在 `running`。反过来也一样。这不是超时该解决的问题——
 * 超时是拿时间猜死活，而这里死活是**知道**的：进程退出了，通道断了。
 *
 * 所以用死讯，不用时限：对面一断，所有在途调用立刻以「对面没了」失败，之后的调用也
 * 立刻失败而不是挂起。慢是允许的，永远等下去不是。
 */
function settleOnDeath<Remote extends object, Local extends object>(
  rpc: BirpcReturn<Remote, Local>,
  onDeath: (die: (reason: Error) => void) => void,
): BirpcReturn<Remote, Local> {
  let died: Error | undefined;
  let reject: ((e: Error) => void) | undefined;
  const dead = new Promise<never>((_, rj) => {
    reject = rj;
  });
  // 没有人 await 这个 promise 时它也会被 reject，加一个空的 catch 免得变成未处理拒绝。
  dead.catch(() => undefined);
  onDeath((reason) => {
    if (died) return;
    died = reason;
    reject?.(reason);
  });

  return new Proxy(rpc, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function" || typeof prop === "symbol") return value;
      return (...args: unknown[]) => {
        // 已经死了就别再发了：发出去也只是加一条永远等不到回复的调用。
        if (died) return Promise.reject(died);
        const call = (value as (...a: unknown[]) => unknown).apply(target, args);
        return call instanceof Promise ? Promise.race([call, dead]) : call;
      };
    },
  }) as BirpcReturn<Remote, Local>;
}

/** Supervisor side: talk to a forked child. */
export function supervisorChannel<Remote extends object, Local extends object>(
  child: ChildProcess,
  local: Local,
): BirpcReturn<Remote, Local> {
  const rpc = createBirpc<Remote, Local>(local, {
    // No RPC deadline: a single vision-model step takes tens of seconds and a full case
    // can run for minutes. Liveness is the heartbeat's job (a hung child stops beating and
    // gets reaped); a 60s RPC timeout would just abort healthy work.
    timeout: -1,
    post: (data) => {
      // `send` 在通道刚断时会同步抛（EPIPE）或异步触发 ChildProcess 的 'error'——两条都不能让网关整个进程死掉。
      // 2026-09-07 实测：一个 runner 断了 IPC，`execOnRunner` 往它 send，未处理的 'error' 事件把网关打死了。
      if (!child.connected) return;
      try {
        child.send({ __rpc: data });
      } catch {
        /* 对面没了：settleOnDeath 会把在途调用以「子进程已退出」结束 */
      }
    },
    on: (fn) => {
      child.on("message", (m) => {
        if (isFrame(m)) fn(m.__rpc);
      });
    },
  });

  // `close` 而不是 `exit`：exit 之后 IPC 还可能有残留消息，close 才是通道真的没了。
  return settleOnDeath(rpc, (die) => {
    child.once("close", (code, signal) =>
      die(new Error(`子进程已退出（code ${code ?? "null"}${signal ? `, ${signal}` : ""}），这次调用不会有回复了`)),
    );
    // 没有这个监听，IPC 写失败会以未处理的 'error' 事件把宿主进程打死。
    child.on("error", (e) => die(new Error(`子进程 IPC 出错：${e.message}`)));
  });
}

/** Child side: talk to whoever forked us. */
export function childChannel<Remote extends ParentApi, Local extends object>(
  local: Local,
): BirpcReturn<Remote, Local> {
  if (!process.send) throw new Error("not a forked process — no IPC channel");
  const rpc = createBirpc<Remote, Local>(local, {
    // Same reasoning as the supervisor side, and it has to be said twice because birpc
    // times out per direction: the deadline that matters here is on calls the child makes
    // UP to its supervisor, and `execCase` is one of them — the agent asks the gateway to
    // run a case, which drives a browser with a vision model and takes minutes. birpc's
    // 60-second default killed it mid-run and reported "[birpc] timeout on calling
    // execCase", which reads like the gateway was unreachable rather than like a ceiling
    // nobody meant to set. Liveness stays the heartbeat's job in both directions.
    timeout: -1,
    post: (data) => process.send?.({ __rpc: data }),
    on: (fn) => {
      process.on("message", (m) => {
        if (isFrame(m)) fn(m.__rpc);
      });
    },
    eventNames: [...EVENT_METHODS],
  });

  // 这个方向上悬着的是 `execCase`：agent 让网关跑一条用例，网关没了就永远不会回。
  return settleOnDeath(rpc, (die) =>
    process.once("disconnect", () =>
      die(new Error("与网关的通道已断开，这次调用不会有回复了")),
    ),
  );
}
