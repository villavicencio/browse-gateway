/**
 * A deterministic clock for the search router (VIL-123). Time moves ONLY when a test fires a timer,
 * so every deadline, retry wait and breaker cooldown is asserted to the millisecond instead of
 * being inferred from wall-clock slop.
 *
 * Between timer firings the helper drains pending promise work with real `setImmediate` turns, so an
 * `await` chain inside the router settles before the next timer is considered.
 */
export class FakeClock {
  #now;
  #timers = [];
  #seq = 0;

  constructor(start = 1_000_000) {
    this.#now = start;
  }

  now = () => this.#now;

  setTimeout = (fn, ms) => {
    const id = ++this.#seq;
    this.#timers.push({ id, at: this.#now + Math.max(0, ms), fn });
    return id;
  };

  clearTimeout = (id) => {
    this.#timers = this.#timers.filter((t) => t.id !== id);
  };

  get pendingTimers() {
    return this.#timers.length;
  }

  async flush() {
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
  }

  /** Fire the earliest pending timer (advancing time to it). Returns false when none is pending. */
  async next() {
    await this.flush();
    if (this.#timers.length === 0) return false;
    this.#timers.sort((a, b) => a.at - b.at || a.id - b.id);
    const t = this.#timers.shift();
    this.#now = Math.max(this.#now, t.at);
    t.fn();
    await this.flush();
    return true;
  }

  /** Move time forward by `ms`, firing every timer that falls due on the way. */
  async advance(ms) {
    const target = this.#now + ms;
    await this.flush();
    for (;;) {
      this.#timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const t = this.#timers[0];
      if (!t || t.at > target) break;
      this.#timers.shift();
      this.#now = Math.max(this.#now, t.at);
      t.fn();
      await this.flush();
    }
    this.#now = target;
    await this.flush();
  }

  /** Drive `promise` to settlement, firing timers as needed. Throws if it can never settle. */
  async run(promise, maxSteps = 1000) {
    let done = false;
    let value;
    let error;
    let failed = false;
    promise.then(
      (v) => {
        done = true;
        value = v;
      },
      (e) => {
        done = true;
        failed = true;
        error = e;
      },
    );
    for (let i = 0; i < maxSteps; i++) {
      await this.flush();
      if (done) break;
      if (!(await this.next())) throw new Error("FakeClock.run: the promise is pending and no timer is scheduled (deadlock)");
    }
    if (!done) throw new Error("FakeClock.run: step limit reached");
    if (failed) throw error;
    return value;
  }
}
