// Pure logic: no AWS, no I/O. Easy to test and to read.
import type { StopReason, StreamEvent } from "./domain.ts";

const LIMITS: ReadonlySet<StopReason> = new Set([
  "max_iterations_exceeded",
  "max_tokens",
  "max_output_tokens_exceeded",
  "timeout_exceeded",
]);

// What to print for one event.
export function render(event: StreamEvent): string {
  switch (event.kind) {
    case "text":
      return event.text;
    case "stopped":
      return LIMITS.has(event.reason)
        ? `\n[stopped: a limit was hit (${event.reason})]\n`
        : `\n[stop: ${event.reason}]\n`;
    case "failed":
      return `\n[error: ${event.message}]\n`;
  }
}

// 0 if the agent finished normally, 1 otherwise.
export function exitCode(events: readonly StreamEvent[]): number {
  return events.some((e) => e.kind === "stopped" && e.reason === "end_turn") ? 0 : 1;
}
