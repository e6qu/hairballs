// Domain types for token usage, cost and evaluations of the helpdesk harness.
// Outside data (arguments, environment, InvokeHarness stream events, GetHarness, Logs and
// Evaluate replies) is parsed into these types at the boundary. After that, a value is valid.
import type {
  EvaluationResultContent,
  HarnessTokenUsage,
  InvokeHarnessStreamOutput,
} from "@aws-sdk/client-bedrock-agentcore";
import type { GetHarnessCommandOutput } from "@aws-sdk/client-bedrock-agentcore-control";
import type { ResultField } from "@aws-sdk/client-cloudwatch-logs";
import type { DocumentType } from "@smithy/types";

declare const brand: unique symbol;
type Brand<T, Name extends string> = T & { readonly [brand]: Name };

export class ParseError extends Error {}

export type HarnessArn = Brand<string, "HarnessArn">;
export type HarnessId = Brand<string, "HarnessId">;
export type SessionId = Brand<string, "SessionId">; // same id = same VM and conversation
export type RuntimeId = Brand<string, "RuntimeId">; // the Runtime agent a harness runs on
export type EvaluatorId = Brand<string, "EvaluatorId">;

const HARNESS_ARN = /^arn:aws[a-z-]*:bedrock-agentcore:[a-z0-9-]+:\d{12}:harness\/[\w-]+$/;
const HARNESS_ID = /^[A-Za-z][A-Za-z0-9_]*-[A-Za-z0-9]+$/;
const EVALUATOR_ID = /^(Builtin\.[A-Za-z]+|arn:aws[a-z-]*:bedrock-agentcore:\S+:evaluator\/\S+)$/;

function matching<T extends string>(pattern: RegExp, what: string, raw: string): T {
  if (!pattern.test(raw)) throw new ParseError(`not ${what}: ${raw}`);
  return raw as T;
}
export const parseHarnessArn = (raw: string) =>
  matching<HarnessArn>(HARNESS_ARN, "a harness ARN", raw);
export const parseHarnessId = (raw: string) => matching<HarnessId>(HARNESS_ID, "a harness id", raw);
export const parseEvaluatorId = (raw: string) =>
  matching<EvaluatorId>(EVALUATOR_ID, "an evaluator id", raw);

export function parseSessionId(raw: string): SessionId {
  if (raw.length < 33 || raw.length > 256) {
    throw new ParseError("a session id must be 33 to 256 characters (use a UUID)");
  }
  return raw as SessionId;
}

// --- Tokens and money -----------------------------------------------------------------------

export type TokenCount = Brand<number, "TokenCount">; // an integer >= 0

// Token counts of one or more model calls.
export interface TokenUsage {
  readonly input: TokenCount; // uncached input
  readonly output: TokenCount;
  readonly cacheRead: TokenCount;
  readonly cacheWrite: TokenCount;
}

function parseCount(raw: number | undefined, name: string): TokenCount {
  const value = raw ?? 0;
  if (!Number.isInteger(value) || value < 0) throw new ParseError(`$.usage.${name}: expected >= 0`);
  return value as TokenCount;
}

export function parseUsage(raw: HarnessTokenUsage | undefined): TokenUsage {
  if (raw === undefined) throw new ParseError("$.usage: missing");
  return {
    input: parseCount(raw.inputTokens, "inputTokens"),
    output: parseCount(raw.outputTokens, "outputTokens"),
    cacheRead: parseCount(raw.cacheReadInputTokens, "cacheReadInputTokens"),
    cacheWrite: parseCount(raw.cacheWriteInputTokens, "cacheWriteInputTokens"),
  };
}

// Money is never a float: integer nano-dollars. $1 per million tokens = 1,000 nano-USD per token.
export type NanoUsd = Brand<number, "NanoUsd">;
export type Prices = { readonly [K in keyof TokenUsage]: NanoUsd }; // per token

export const HAIKU_4_5: Prices = {
  input: 1_000 as NanoUsd, // $1.00 / M
  output: 5_000 as NanoUsd, // $5.00 / M
  cacheRead: 100 as NanoUsd, // $0.10 / M, 10% of input
  cacheWrite: 1_250 as NanoUsd, // $1.25 / M, 125% of input (5-minute cache)
};

// --- The InvokeHarness stream ---------------------------------------------------------------

export type StreamEvent =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "usage"; readonly usage: TokenUsage }
  | { readonly kind: "stopped"; readonly reason: string };

// One InvokeHarness stream event, or undefined for events this client ignores.
export function parseStreamEvent(raw: InvokeHarnessStreamOutput): StreamEvent | undefined {
  if (raw.contentBlockDelta) {
    const text = raw.contentBlockDelta.delta?.text;
    return text ? { kind: "text", text } : undefined;
  }
  if (raw.metadata) return { kind: "usage", usage: parseUsage(raw.metadata.usage) };
  if (raw.messageStop) {
    const reason = raw.messageStop.stopReason;
    if (!reason) throw new ParseError("$.messageStop.stopReason: missing");
    return { kind: "stopped", reason };
  }
  return undefined;
}

// --- Evaluations ----------------------------------------------------------------------------

export function parseRuntimeId(reply: GetHarnessCommandOutput): RuntimeId {
  const id = reply.harness?.environment?.agentCoreRuntimeEnvironment?.agentRuntimeId;
  if (!id) throw new ParseError("$.harness.environment: no runtime id");
  return id as RuntimeId;
}

// A session's spans, exactly as stored in CloudWatch. Opaque here: Evaluate reads them.
export type SessionSpans = Brand<readonly DocumentType[], "SessionSpans">;

export function parseSpanRows(rows: readonly (readonly ResultField[])[]): SessionSpans {
  const spans = rows
    .flat()
    .filter((f) => f.field === "@message" && f.value?.startsWith("{"))
    .map((f) => JSON.parse(f.value ?? "{}") as DocumentType);
  if (spans.length === 0)
    throw new ParseError("no spans for this session yet (wait a few minutes)");
  return spans as readonly DocumentType[] as SessionSpans;
}

export type Evaluation =
  | {
      readonly kind: "scored";
      readonly evaluator: string;
      readonly value: number;
      readonly label: string;
      readonly explanation: string;
    }
  | { readonly kind: "notScored"; readonly evaluator: string; readonly reason: string };

export function parseEvaluation(raw: EvaluationResultContent): Evaluation {
  const evaluator = raw.evaluatorId ?? "unknown evaluator";
  if (raw.value === undefined) {
    return { kind: "notScored", evaluator, reason: raw.errorMessage ?? "no score" };
  }
  return {
    kind: "scored",
    evaluator,
    value: raw.value,
    label: raw.label ?? "",
    explanation: raw.explanation ?? "",
  };
}
