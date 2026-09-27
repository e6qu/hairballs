/** Clocks: the core never reads time itself; the shell passes `Instant` values in. */

import { type DurationMs, Instant } from "../domain.ts";

export interface Clock {
  now(): Instant;
}

export class SystemClock implements Clock {
  now(): Instant {
    return Instant.of(Date.now());
  }
}

/** A controllable clock for tests. Starts at 2026-01-01T00:00:00Z unless told otherwise. */
export class FakeClock implements Clock {
  #now: Instant;

  constructor(start: Instant = Instant.of(Date.UTC(2026, 0, 1))) {
    this.#now = start;
  }

  now(): Instant {
    return this.#now;
  }

  advance(delta: DurationMs): void {
    this.#now = Instant.plus(this.#now, delta);
  }
}
