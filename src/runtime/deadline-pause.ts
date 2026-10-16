/**
 * Pauses a runtime's wall-clock program deadline while host calls that wait
 * for a person (`executor.humanWaitRefs`) are in flight. Guest work before and
 * after the wait spends the same budget; the wait itself does not. Cancellation
 * is unaffected because it never goes through the deadline.
 */
export interface PausableDeadlineClock {
  /** Milliseconds left before the running deadline expires. */
  remainingMs(): number;
  /** Stop the deadline timer and treat the deadline as unbounded. */
  suspend(): void;
  /** Restart the deadline with this budget, measured from now. */
  resume(remainingMs: number): void;
}

export class HumanWaitDeadlinePause {
  #active = 0;
  #remainingMs = 0;
  readonly #clock: PausableDeadlineClock;

  constructor(clock: PausableDeadlineClock) {
    this.#clock = clock;
  }

  get paused(): boolean {
    return this.#active > 0;
  }

  /** A human-wait call started. The first one suspends the deadline. */
  enter(): void {
    if (this.#active++ > 0) return;
    this.#remainingMs = Math.max(0, this.#clock.remainingMs());
    this.#clock.suspend();
  }

  /** A human-wait call settled. The last one resumes the saved budget. */
  leave(): void {
    if (this.#active === 0) return;
    if (--this.#active > 0) return;
    this.#clock.resume(this.#remainingMs);
  }

  /** Pause for the duration of one host-side wait, such as an approval prompt. */
  async run<T>(wait: () => Promise<T>): Promise<T> {
    this.enter();
    try {
      return await wait();
    } finally {
      this.leave();
    }
  }

  /** While paused, a host-call floor raises the budget left after the wait. */
  raise(floorMs: number): void {
    this.#remainingMs = Math.max(this.#remainingMs, Math.max(1, Math.floor(floorMs)));
  }
}
