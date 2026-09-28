import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * runner 起的浏览器进程登记簿（docs/v3/15 阶段 5.3）。
 *
 * 2026-09-27：runner 因心跳超时被 SIGKILL，它起的无头 Chrome 不会跟着退出——`finally` 根本没机会跑。
 * 几天下来本机积了 10 个孤儿浏览器，空闲内存只剩约 120MB，新浏览器打开交易页 45 秒超时，
 * 正式执行因此两次停批。
 *
 * 做法：每起一个浏览器，把它的进程号记进 `<目录>/<runner 进程号>.json`，浏览器断开时划掉；
 * 下一个 runner 启动时扫一遍——文件的主人（那个 runner）已经不在，里面还活着的浏览器就是孤儿，关掉。
 * 杀之前再核一次命令行是浏览器，防进程号被系统复用后误杀无关进程。
 */
const dir = () => process.env.TP_BROWSER_REGISTRY_DIR ?? join(tmpdir(), "testpilot-browsers");
const fileOf = (owner: number) => join(dir(), `${owner}.json`);

function read(file: string): number[] {
  try { const v = JSON.parse(readFileSync(file, "utf8")); return Array.isArray(v) ? v.filter((x) => Number.isInteger(x)) : []; } catch { return []; }
}
function write(owner: number, pids: number[]): void {
  try {
    mkdirSync(dir(), { recursive: true });
    if (pids.length) writeFileSync(fileOf(owner), JSON.stringify(pids)); else rmSync(fileOf(owner), { force: true });
  } catch { /* 登记失败不该影响执行；最坏是这个浏览器以后要手工清 */ }
}

/** 起了浏览器就登记，断开时划掉。 */
export function trackBrowser(browser: { process(): { pid?: number } | null; once(event: "disconnected", fn: () => void): unknown }): void {
  const pid = browser.process()?.pid;
  if (!pid) return;
  write(process.pid, [...new Set([...read(fileOf(process.pid)), pid])]);
  browser.once("disconnected", () => write(process.pid, read(fileOf(process.pid)).filter((p) => p !== pid)));
}

export interface SweepIo {
  alive(pid: number): boolean;
  /** 这个进程号现在是不是一个浏览器；判断不了就当不是（宁可漏清，不能误杀）。 */
  isBrowser(pid: number): boolean;
  kill(pid: number): void;
}
const systemIo: SweepIo = {
  alive: (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } },
  isBrowser: (pid) => {
    try { return /chrom/i.test(execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" })); } catch { return false; }
  },
  kill: (pid) => { try { process.kill(pid, "SIGKILL"); } catch { /* 已经没了 */ } },
};

/** 清掉主人已经不在的登记里还活着的浏览器；返回关掉了几个。 */
export function sweepOrphanBrowsers(io: SweepIo = systemIo): number {
  let files: string[];
  try { files = readdirSync(dir()).filter((f) => /^\d+\.json$/.test(f)); } catch { return 0; }
  let killed = 0;
  for (const name of files) {
    const owner = Number(name.slice(0, -5));
    if (owner === process.pid || io.alive(owner)) continue;
    for (const pid of read(join(dir(), name))) if (io.alive(pid) && io.isBrowser(pid)) { io.kill(pid); killed++; }
    try { rmSync(join(dir(), name), { force: true }); } catch { /* 下次再清 */ }
  }
  return killed;
}
