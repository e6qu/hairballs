// Pure logic: no AWS, no I/O. Easy to test and to read.
import type { StopReason, StreamEvent } from "./domain.ts";

const LIMITS: ReadonlySet<StopReason> = new Set([
  "max_iterations_exceeded",
  "max_tokens",
  "max_output_tokens_exceeded",
  "timeout_exceeded",
]);

// What to print for one event. Tool calls are shown, so you can watch the skill load.
export function render(event: StreamEvent): string {
  switch (event.kind) {
    case "text":
    case "toolInput":
      return event.text;
    case "toolCalled":
      return `\n[tool ${event.name}] `;
    case "stopped":
      if (event.reason === "tool_use" || event.reason === "tool_result") return "";
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
