// Domain types for conversation threads in AgentCore Memory.
// Outside data (the HTTP payload, the session header, the environment, Memory events, Converse
// usage) is parsed into these types at the boundary. After that, a value that exists is valid.
import type { Event } from "@aws-sdk/client-bedrock-agentcore";
import type { TokenUsage } from "@aws-sdk/client-bedrock-runtime";

declare const brand: unique symbol;
type Brand<T, Name extends string> = T & { readonly [brand]: Name };

export class ParseError extends Error {}

export type MemoryId = Brand<string, "MemoryId">;
export type ActorId = Brand<string, "ActorId">; // a stable user id; never contains "|"
export type SessionId = Brand<string, "SessionId">; // a Runtime and a Memory session
export type EventId = Brand<string, "EventId">;
export type BranchName = Brand<string, "BranchName">;

const MEMORY_ID = /^[a-zA-Z][a-zA-Z0-9_-]{0,99}-[a-zA-Z0-9]{10}$/;
const ACTOR_ID = /^[a-zA-Z0-9][a-zA-Z0-9_/-]*(?::[a-zA-Z0-9_/-]+)*[a-zA-Z0-9_/-]*$/;
const SESSION_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{32,99}$/;
const EVENT_ID = /^[0-9]+#[a-fA-F0-9]+$/;
const BRANCH = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/;

function matching<T>(pattern: RegExp, what: string, raw: unknown): T {
  if (typeof raw !== "string" || !pattern.test(raw)) {
    throw new ParseError(`invalid ${what}: ${String(raw)}`);
  }
  return raw as T;
}

export const parseMemoryId = (raw: unknown): MemoryId => matching(MEMORY_ID, "memory id", raw);
export const parseEventId = (raw: unknown): EventId => matching(EVENT_ID, "event id", raw);
export const parseBranchName = (raw: unknown): BranchName => matching(BRANCH, "branch name", raw);
export function parseActorId(raw: unknown): ActorId {
  if (typeof raw === "string" && raw.length > 255) throw new ParseError("actor id too long");
  return matching(ACTOR_ID, "actor id", raw);
}
export function parseSessionId(raw: unknown): SessionId {
  if (typeof raw !== "string" || !SESSION_ID.test(raw)) {
    throw new ParseError("a session id must be 33 to 100 letters, digits, - or _ (use a UUID)");
  }
  return raw as SessionId;
}

export type Role = "USER" | "ASSISTANT";

export interface Message {
  readonly role: Role;
  readonly text: string;
}

export function message(role: Role, text: string): Message {
  if (text.trim() === "") throw new ParseError("a message needs text");
  return { role, text };
}

// Where a new message goes. A fork point without a branch can't be expressed.
export type Placement =
  | { readonly kind: "main" }
  | { readonly kind: "startBranch"; readonly branch: BranchName; readonly forkAfter: EventId }
  | { readonly kind: "onBranch"; readonly branch: BranchName };

// The two kinds of stored event.
export type ThreadEvent =
  | {
      readonly kind: "main";
      readonly id: EventId;
      readonly at: Date;
      readonly messages: readonly Message[];
    }
  | {
      readonly kind: "branch";
      readonly id: EventId;
      readonly at: Date;
      readonly branch: BranchName;
      readonly messages: readonly Message[];
    };

// One event from ListEvents (the SDK's own type), with its USER/ASSISTANT messages.
export function parseEvent(raw: Event): ThreadEvent {
  const id = parseEventId(raw.eventId);
  if (!(raw.eventTimestamp instanceof Date)) throw new ParseError("eventTimestamp missing");
  const at = raw.eventTimestamp;
  const messages = (raw.payload ?? []).flatMap((item): Message[] => {
    const role = item.conversational?.role;
    const text = item.conversational?.content?.text;
    return (role === "USER" || role === "ASSISTANT") && text ? [{ role, text }] : [];
  });
  return raw.branch
    ? { kind: "branch", id, at, branch: parseBranchName(raw.branch.name), messages }
    : { kind: "main", id, at, messages };
}

export interface Invocation {
  readonly prompt: string;
  readonly actor: ActorId;
}

// The /invocations body: {"prompt": "...", "user_id": "..."} (user_id optional).
export function parseInvocation(raw: unknown): Invocation {
  if (typeof raw !== "object" || raw === null) throw new ParseError("$ must be a JSON object");
  const fields = raw as Record<string, unknown>;
  const prompt = fields["prompt"];
  if (typeof prompt !== "string" || prompt.trim() === "") {
    throw new ParseError("$.prompt must be a non-empty string");
  }
  return { prompt: prompt.trim(), actor: parseActorId(fields["user_id"] ?? "anonymous") };
}

export interface CacheUsage {
  readonly uncached: number;
  readonly cacheWrite: number;
  readonly cacheRead: number;
}

// The `usage` of a Converse response (the SDK's own type).
export function parseUsage(raw: TokenUsage | undefined): CacheUsage {
  if (!raw) throw new ParseError("the response has no usage");
  return {
    uncached: raw.inputTokens ?? 0,
    cacheWrite: raw.cacheWriteInputTokens ?? 0,
    cacheRead: raw.cacheReadInputTokens ?? 0,
  };
}
