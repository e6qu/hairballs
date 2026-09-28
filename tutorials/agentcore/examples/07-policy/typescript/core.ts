// Pure logic: no network, no I/O.
import type { Decision, ToolName } from "./domain.ts";

// The JSON-RPC request body for one tool call.
export function toolsCall(
  requestId: number,
  tool: ToolName,
  args: Readonly<Record<string, unknown>>,
) {
  return {
    jsonrpc: "2.0",
    id: requestId,
    method: "tools/call",
    params: { name: tool, arguments: args },
  } as const;
}

// A denial is final; a failed call may be retried.
export function mayRetry(decision: Decision): boolean {
  return decision.kind === "failed";
}

// What to print, and the exit code.
export function render(decision: Decision): { readonly text: string; readonly code: number } {
  switch (decision.kind) {
    case "allowed":
      return { text: decision.text, code: 0 };
    case "denied":
      return { text: `not allowed: ${decision.reason}`, code: 2 };
    case "failed":
      return { text: `tool failed: ${decision.message}`, code: 1 };
  }
}
