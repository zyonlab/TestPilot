/**
 * A FIFO admission gate.
 *
 * The self-hosted VL model is the scarcest resource in the system: it serves one request
 * at a time acceptably and degrades (or returns 502) under concurrency. Browsers can run
 * in parallel, the model cannot — so admission is gated separately from execution
 * concurrency, and the gate has to span processes (the gateway generates code while a
 * runner drives a case; both hit the same endpoint).
 */
export class Gate {
  private active = 0;
  private waiting: Array<() => void> = [];

  constructor(private limit = 1) {
    if (limit < 1) throw new Error("gate limit must be >= 1");
  }

  /** Wait for a slot. The returned function gives it back — call it in a finally. */
  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active += 1;
    } else {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    let released = false;
    return () => {
      if (released) return; // releasing twice would hand out a slot that does not exist
      released = true;
      const next = this.waiting.shift();
      if (next) next(); // hand the slot straight over, keeping the count stable
      else this.active -= 1;
    };
  }

  /** Run `fn` inside a slot, releasing it even if `fn` throws. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  stats(): { limit: number; active: number; waiting: number } {
    return { limit: this.limit, active: this.active, waiting: this.waiting.length };
  }
}
