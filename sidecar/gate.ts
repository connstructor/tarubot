/**
 * Process-wide Lodestone admission for the sidecar: request-start spacing (NODE-08), plus one shared
 * cooldown after the Lodestone throttles us (2.17.0). Before 2.17.0 a 429 only failed the request
 * that received it, so every queued request kept hitting a Lodestone that was already refusing.
 * Now the first 429 closes the gate for everyone: new starts are refused locally with the remaining
 * cooldown as retryAfter, without touching the Lodestone, and the cooldown doubles on each
 * consecutive 429 until any other Lodestone answer resets the escalation.
 */

/** The first cooldown after a Lodestone 429 when it sends no usable Retry-After. */
export const COOLDOWN_BASE_MS = 15_000;
/** Consecutive 429s double the cooldown up to this bound. */
export const COOLDOWN_MAX_MS = 300_000;
/** A Lodestone Retry-After is honored up to this bound, even above the backoff ceiling. */
export const RETRY_AFTER_MAX_MS = 900_000;

/** Monotonic milliseconds; injectable so tests control time without real sleeps. */
export type Clock = () => number;

export class LodestoneGate {
  private lastStart = Number.NEGATIVE_INFINITY;
  private coolUntil = Number.NEGATIVE_INFINITY;
  private strikes = 0;
  // A promise mutex serializes start reservations, not whole requests: starts overlap requests.
  private startLock: Promise<void> = Promise.resolve();

  constructor(
    private readonly spacingMs: number,
    private readonly clock: Clock = () => performance.now(),
    private readonly sleep: (ms: number) => Promise<unknown> = (ms) => Bun.sleep(ms),
  ) {}

  /** Whole seconds until the cooldown ends; 0 while the Lodestone may be asked. */
  cooldownSeconds(): number {
    return Math.max(0, Math.ceil((this.coolUntil - this.clock()) / 1000));
  }

  /**
   * Reserve this request's start slot. Resolves 0 once the request may start, or the remaining
   * cooldown in seconds while the Lodestone is throttling us, so the caller refuses without a
   * network request. Throws the signal's reason if it aborts while waiting for a slot.
   */
  async admit(signal: AbortSignal): Promise<number> {
    const previous = this.startLock;
    let release = (): void => {};
    this.startLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const cooling = this.cooldownSeconds();
      if (cooling > 0) return cooling;
      // Monotonic time and a recheck prevent early timer wakeups from violating start spacing.
      while (this.clock() < this.lastStart + this.spacingMs) {
        signal.throwIfAborted();
        await this.sleep(Math.ceil(this.lastStart + this.spacingMs - this.clock()));
      }
      signal.throwIfAborted();
      // A request already in flight may have been throttled while this one waited for its slot.
      const late = this.cooldownSeconds();
      if (late > 0) return late;
      this.lastStart = this.clock();
      return 0;
    } finally {
      release();
    }
  }

  /**
   * The Lodestone answered 429: start or extend the shared cooldown and return it in seconds. A
   * usable Retry-After wins when it is longer than the backoff, within RETRY_AFTER_MAX_MS.
   */
  throttled(retryAfterSeconds: number): number {
    this.strikes++;
    const backoff = Math.min(COOLDOWN_MAX_MS, COOLDOWN_BASE_MS * 2 ** (this.strikes - 1));
    const requested = Math.min(Math.max(0, retryAfterSeconds) * 1000, RETRY_AFTER_MAX_MS);
    this.coolUntil = Math.max(this.coolUntil, this.clock() + Math.max(backoff, requested));
    return this.cooldownSeconds();
  }

  /** Any other Lodestone answer ends the escalation; a running cooldown still runs out. */
  answered(): void {
    this.strikes = 0;
  }

  /** For /health: whether the gate is cooling down, and how many 429s in a row it has seen. */
  status(): { cooldownSeconds: number; strikes: number } {
    return { cooldownSeconds: this.cooldownSeconds(), strikes: this.strikes };
  }
}
