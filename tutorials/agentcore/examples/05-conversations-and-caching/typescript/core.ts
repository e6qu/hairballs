// Pure logic: no AWS, no I/O, no clock. Easy to test and to read.
import type { CacheUsage, Message, ThreadEvent } from "./domain.ts";

// The messages of one thread, oldest first. ListEvents returns every event of the session (newest
// first), or, filtered by a branch, that branch plus the history it grew from. The main thread is
// the events with no branch.
export function thread(events: readonly ThreadEvent[], onBranch: boolean): Message[] {
  return events
    .filter((e) => onBranch || e.kind === "main") // filter returns a new array, so sort is safe
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .flatMap((e) => e.messages);
}

// One line on how much of the prompt came from the cache.
export function describe(usage: CacheUsage): string {
  const total = usage.uncached + usage.cacheWrite + usage.cacheRead;
  const share = total ? Math.floor((100 * usage.cacheRead) / total) : 0;
  return (
    `input=${usage.uncached} cache_write=${usage.cacheWrite} ` +
    `cache_read=${usage.cacheRead} (${share}% read from cache)`
  );
}
