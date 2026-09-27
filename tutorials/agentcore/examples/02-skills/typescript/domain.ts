// Domain types for calling the helpdesk with a skill override.
// Data from outside the program (arguments, environment, the AgentCore stream) is parsed into these
// types at the boundary. After that, a value that exists is valid: no code downstream re-checks it.
import type { InvokeHarnessStreamOutput } from "@aws-sdk/client-bedrock-agentcore";

declare const brand: unique symbol;
type Brand<T, Name extends string> = T & { readonly [brand]: Name };

export class ParseError extends Error {}

export type HarnessArn = Brand<string, "HarnessArn">;
export type SessionId = Brand<string, "SessionId">; // same id = same VM and conversation
export type Question = Brand<string, "Question">;
export type SkillUri = Brand<string, "SkillUri">; // an S3 folder with SKILL.md at its top

const HARNESS_ARN = /^arn:aws[a-z-]*:bedrock-agentcore:[a-z0-9-]+:\d{12}:harness\/[A-Za-z0-9_-]+$/;
const SKILL_URI = /^s3:\/\/[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]\/(?:[^/]+\/)+$/;

export function parseHarnessArn(raw: string): HarnessArn {
  if (!HARNESS_ARN.test(raw)) throw new ParseError(`not a harness ARN: ${JSON.stringify(raw)}`);
  return raw as HarnessArn;
}

export function parseSessionId(raw: string): SessionId {
  if (raw.length < 33 || raw.length > 256) {
    throw new ParseError("a session id must be 33 to 256 characters (use a UUID)");
  }
  return raw as SessionId;
}

export function parseQuestion(raw: string): Question {
  const text = raw.trim();
  if (text === "") throw new ParseError("the question is empty");
  return text as Question;
}

export function parseSkillUri(raw: string): SkillUri {
  if (!SKILL_URI.test(raw)) {
    throw new ParseError(`not an S3 skill folder (s3://bucket/path/): ${JSON.stringify(raw)}`);
  }
  return raw as SkillUri;
}

export const STOP_REASONS = [
  "end_turn",
  "tool_use",
  "tool_result",
  "max_tokens",
  "stop_sequence",
  "content_filtered",
  "malformed_model_output",
  "malformed_tool_use",
  "interrupted",
  "partial_turn",
  "model_context_window_exceeded",
  "max_iterations_exceeded",
  "max_output_tokens_exceeded",
  "timeout_exceeded",
  "hook_stopped",
] as const;
export type StopReason = (typeof STOP_REASONS)[number];

// The parts of the InvokeHarness stream this client uses.
export type StreamEvent =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "toolCalled"; readonly name: string } // e.g. `skills` or `shell`
  | { readonly kind: "toolInput"; readonly text: string } // a piece of the call's JSON arguments
  | { readonly kind: "stopped"; readonly reason: StopReason }
  | { readonly kind: "failed"; readonly message: string };

function parseStopReason(raw: string | undefined): StopReason {
  const reason = STOP_REASONS.find((r) => r === raw);
  if (reason === undefined) throw new ParseError(`unknown stop reason: ${String(raw)}`);
  return reason;
}

// One event from the InvokeHarness stream, or undefined for events this client ignores.
export function parseStreamEvent(raw: InvokeHarnessStreamOutput): StreamEvent | undefined {
  if (raw.contentBlockStart) {
    const name = raw.contentBlockStart.start?.toolUse?.name;
    return name ? { kind: "toolCalled", name } : undefined;
  }
  if (raw.contentBlockDelta) {
    const delta = raw.contentBlockDelta.delta;
    if (delta?.toolUse) {
      const text = delta.toolUse.input;
      return text ? { kind: "toolInput", text } : undefined;
    }
    return delta?.text ? { kind: "text", text: delta.text } : undefined;
  }
  if (raw.messageStop) {
    return { kind: "stopped", reason: parseStopReason(raw.messageStop.stopReason) };
  }
  if (raw.runtimeClientError) {
    return { kind: "failed", message: raw.runtimeClientError.message ?? "the agent failed" };
  }
  return undefined;
}
