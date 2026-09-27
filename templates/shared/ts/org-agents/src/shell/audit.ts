/** Audit events: domain types, and a sink that renders them as JSON lines for CloudWatch. */

import { Instant, type SessionId, type ToolName, type Usage, Usd } from "../domain.ts";
import type { StopRun } from "../core/guard.ts";
import { assertNever } from "../result.ts";
import { dumps } from "./json.ts";

export type RunStartedEvent = { readonly kind: "run_started"; readonly session: SessionId; readonly at: Instant };

export type ToolDecisionOutcome = "allowed" | "denied" | "needs_approval" | "stopped";

export type ToolDecisionEvent = {
  readonly kind: "tool_decision";
  readonly session: SessionId;
  readonly tool: ToolName;
  readonly outcome: ToolDecisionOutcome;
  readonly reason: string;
  readonly at: Instant;
};

export type UsageEvent = {
  readonly kind: "usage";
  readonly session: SessionId;
  readonly usage: Usage;
  readonly runTotal: Usd;
  readonly at: Instant;
};

export type RunStoppedEvent = {
  readonly kind: "run_stopped";
  readonly session: SessionId;
  readonly stop: StopRun;
  readonly at: Instant;
};

export type RunFinishedEvent = {
  readonly kind: "run_finished";
  readonly session: SessionId;
  readonly turns: number;
  readonly spent: Usd;
  readonly at: Instant;
};

export type RunFailedEvent = {
  readonly kind: "run_failed";
  readonly session: SessionId;
  readonly error: string;
  readonly at: Instant;
};

/** History was trimmed or summarized (keep the pre-compaction transcript elsewhere). */
export type ContextCompactedEvent = {
  readonly kind: "context_compacted";
  readonly session: SessionId;
  readonly messagesBefore: number;
  readonly messagesAfter: number;
  readonly at: Instant;
};

export type AuditEvent =
  | RunStartedEvent
  | ToolDecisionEvent
  | UsageEvent
  | RunStoppedEvent
  | RunFinishedEvent
  | RunFailedEvent
  | ContextCompactedEvent;

/** Render an audit event as a JSON-compatible record (outbound serialization lives here). */
export function render(event: AuditEvent): Record<string, unknown> {
  const base = { audit: true, session: event.session, at: Instant.toIso(event.at) };
  switch (event.kind) {
    case "run_started":
      return { ...base, type: "run_started" };
    case "tool_decision":
      return { ...base, type: "tool_decision", tool: event.tool, outcome: event.outcome, reason: event.reason };
    case "usage":
      return {
        ...base,
        type: "usage",
        input_tokens: event.usage.inputTokens,
        output_tokens: event.usage.outputTokens,
        cache_read_tokens: event.usage.cacheReadTokens,
        cache_write_tokens: event.usage.cacheWriteTokens,
        run_usd: Usd.toDecimalString(event.runTotal),
      };
    case "run_stopped":
      return { ...base, type: "run_stopped", reason: event.stop.reason, detail: event.stop.detail };
    case "run_finished":
      return { ...base, type: "run_finished", turns: event.turns, run_usd: Usd.toDecimalString(event.spent) };
    case "run_failed":
      return { ...base, type: "run_failed", error: event.error };
    case "context_compacted":
      return {
        ...base,
        type: "context_compacted",
        messages_before: event.messagesBefore,
        messages_after: event.messagesAfter,
      };
    default:
      return assertNever(event);
  }
}

export interface AuditSink {
  emit(event: AuditEvent): void;
}

export type TextStream = { write(chunk: string): unknown };

/** Writes one JSON object per line (stdout is shipped to CloudWatch by AgentCore Runtime). */
export class JsonLinesAuditSink implements AuditSink {
  readonly #stream: TextStream;

  constructor(stream: TextStream = process.stdout) {
    this.#stream = stream;
  }

  emit(event: AuditEvent): void {
    this.#stream.write(`${dumps(render(event))}\n`);
  }
}

/** Collects events in memory (tests). */
export class MemoryAuditSink implements AuditSink {
  readonly events: AuditEvent[] = [];

  emit(event: AuditEvent): void {
    this.events.push(event);
  }
}
