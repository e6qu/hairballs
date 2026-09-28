// Pure logic: no AWS, no I/O.
import type {
  Evaluation,
  NanoUsd,
  Prices,
  SessionId,
  StreamEvent,
  TokenCount,
  TokenUsage,
} from "./domain.ts";

const ZERO = 0 as TokenCount;
export const ZERO_USAGE: TokenUsage = {
  input: ZERO,
  output: ZERO,
  cacheRead: ZERO,
  cacheWrite: ZERO,
};

const plus = (a: TokenCount, b: TokenCount) => (a + b) as TokenCount;

export function add(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: plus(a.input, b.input),
    output: plus(a.output, b.output),
    cacheRead: plus(a.cacheRead, b.cacheRead),
    cacheWrite: plus(a.cacheWrite, b.cacheWrite),
  };
}

// All usage reported in a stream, added up (one report per call or per invocation).
export function total(events: readonly StreamEvent[]): TokenUsage {
  return events.reduce((sum, e) => (e.kind === "usage" ? add(sum, e.usage) : sum), ZERO_USAGE);
}

export function cost(usage: TokenUsage, prices: Prices): NanoUsd {
  return (usage.input * prices.input +
    usage.output * prices.output +
    usage.cacheRead * prices.cacheRead +
    usage.cacheWrite * prices.cacheWrite) as NanoUsd;
}

export const dollars = (amount: NanoUsd) => `$${(amount / 1e9).toFixed(5)}`;

// Share of input tokens served from the prompt cache.
export function cacheHitRatio(usage: TokenUsage): number {
  const allInput = usage.input + usage.cacheRead + usage.cacheWrite;
  return allInput === 0 ? 0 : usage.cacheRead / allInput;
}

export function render(event: StreamEvent): string {
  switch (event.kind) {
    case "text":
      return event.text;
    case "usage":
      return "";
    case "stopped":
      return `\n[stop: ${event.reason}]\n`;
  }
}

// The Logs Insights query for one session's spans.
export function spanQuery(session: SessionId): string {
  return `fields @timestamp, @message
    | filter ispresent(scope.name) and attributes.session.id = "${session}"
    | sort @timestamp asc | limit 10000`;
}

export function renderEvaluation(evaluation: Evaluation): string {
  switch (evaluation.kind) {
    case "scored":
      return `${evaluation.evaluator}: ${evaluation.value.toFixed(2)} ${evaluation.label}\n   ${evaluation.explanation.slice(0, 200)}`;
    case "notScored":
      return `${evaluation.evaluator}: not scored (${evaluation.reason})`;
  }
}
