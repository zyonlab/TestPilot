import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sdkEntry } from "./managed-penguin.js";

export interface NativePenguinInput {
  runId: string; projectId: string; agentId: string; root: string; workspace: string; outDir: string; repoRoot: string;
  nodeBin: string; penguinBin: string; message: string; mcpEnv: Record<string, string>;
}
const live = new Map<string, { child: ChildProcess; state: "running" | "idle" | "gone" }>();
export const nativeRunState = (id: string) => live.get(id)?.state;
export function cancelNativeRun(id: string) {
  const run = live.get(id); if (!run || run.state !== "running") return false;
  run.child.send?.({ type: "cancel" }); setTimeout(() => { if (run.state === "running") run.child.kill("SIGKILL"); }, 5000).unref(); return true;
}
export async function launchNativePenguin(input: NativePenguinInput): Promise<{ sessionId: string }> {
  if (live.get(input.runId)?.state === "running") throw new Error("native_run_already_active");
  const sdkPath = sdkEntry(input.penguinBin);
  const env = { ...process.env, TP_NATIVE_WORKER: "1" };
  const child = spawn(input.nodeBin, ["--import", "tsx", fileURLToPath(new URL("./native-penguin-worker.ts", import.meta.url))],
    { cwd: fileURLToPath(new URL("../..", import.meta.url)), env, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const run = { child, state: "running" as "running" | "idle" | "gone" }; live.set(input.runId, run);
  return new Promise((resolve, reject) => {
    let ready = false;
    const timer = setTimeout(() => { child.kill(); reject(new Error("native_runtime_start_timeout")); }, 60_000); timer.unref();
    child.on("message", raw => { const e = raw as { type: string; sessionId?: string };
      if (e.type === "ready" && e.sessionId) { ready = true; clearTimeout(timer); resolve({ sessionId: e.sessionId }); } });
    child.on("error", () => { clearTimeout(timer); run.state = "gone"; reject(new Error("native_runtime_spawn_failed")); });
    child.on("exit", code => { clearTimeout(timer); run.state = code === 0 ? "idle" : "gone"; if (!ready) reject(new Error("native_runtime_initialization_failed"));
      setTimeout(() => { if (live.get(input.runId) === run) live.delete(input.runId); }, 120_000).unref(); });
    child.send({ ...input, type: "start", sdkPath });
  });
}
