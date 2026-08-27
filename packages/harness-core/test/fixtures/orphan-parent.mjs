// A supervisor stand-in that dies the worst way possible: SIGKILL, no handlers, no cleanup.
// Prints its child's pid first so the test can check whether that child outlived it.
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

const child = fork(fileURLToPath(new URL("./child.mjs", import.meta.url)), [], {
  stdio: ["ignore", "ignore", "ignore", "ipc"],
});
console.log(JSON.stringify({ childPid: child.pid }));
setTimeout(() => process.kill(process.pid, "SIGKILL"), 200);
