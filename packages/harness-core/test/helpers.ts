/** Poll until `fn` returns truthy, or fail the test with a readable message. */
export async function until<T>(
  fn: () => T | undefined | false,
  what: string,
  timeoutMs = 5000,
  stepMs = 20,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v as T;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

export const isAlive = (pid?: number): boolean => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
