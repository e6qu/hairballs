// Domain types for the helpdesk agent and its callers.
// Outside data (the HTTP payload, the session header, tool arguments from the model, Strands stream
// events, the environment, server-sent events) is parsed into these types at the boundary. After
// that, a value that exists is valid: no code downstream re-checks it.
declare const brand: unique symbol;
type Brand<T, Name extends string> = T & { readonly [brand]: Name };

export class ParseError extends Error {}

export type AgentRuntimeArn = Brand<string, "AgentRuntimeArn">;
export type SessionId = Brand<string, "SessionId">; // same id = same VM and conversation
export type Prompt = Brand<string, "Prompt">;
export type TicketId = Brand<string, "TicketId">;

const RUNTIME_ARN =
  /^arn:aws[a-z-]*:bedrock-agentcore:[a-z0-9-]+:\d{12}:runtime\/[A-Za-z][A-Za-z0-9_]*-[A-Za-z0-9]+$/;
const TICKET_ID = /^TCK-[0-9a-f]{8}$/;

export function parseAgentRuntimeArn(raw: string): AgentRuntimeArn {
  if (!RUNTIME_ARN.test(raw)) throw new ParseError(`not an agent runtime ARN: ${raw}`);
  return raw as AgentRuntimeArn;
}

export function parseSessionId(raw: string): SessionId {
  if (raw.length < 33 || raw.length > 256) {
    throw new ParseError("a session id must be 33 to 256 characters (use a UUID)");
  }
  return raw as SessionId;
}

export function parsePrompt(raw: unknown): Prompt {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new ParseError("$.prompt must be a non-empty string");
  }
  return raw.trim() as Prompt;
}

// The /invocations body: {"prompt": "..."}.
export function parseInvocation(raw: unknown): Prompt {
  if (typeof raw !== "object" || raw === null) throw new ParseError("$ must be a JSON object");
  return parsePrompt((raw as Record<string, unknown>)["prompt"]);
}

// What the model asked for, once both fields hold text.
export interface TicketRequest {
  readonly title: string;
  readonly description: string;
}

export function parseTicketRequest(title: string, description: string): TicketRequest {
  if (title.trim() === "" || description.trim() === "") {
    throw new ParseError("a ticket needs a title and a description");
  }
  return { title: title.trim(), description: description.trim() };
}

export function parseTicketId(raw: string): TicketId {
  if (!TICKET_ID.test(raw)) throw new ParseError(`not a ticket id: ${raw}`);
  return raw as TicketId;
}

// One server-sent event from the agent.
export type AnswerEvent =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "failed"; readonly message: string };

// A `data: ...` line of the /invocations stream, or undefined for other lines.
export function parseSseLine(line: string): AnswerEvent | undefined {
  if (!line.startsWith("data: ")) return undefined;
  let data: unknown;
  try {
    data = JSON.parse(line.slice("data: ".length));
  } catch {
    throw new ParseError(`not JSON: ${line}`);
  }
  if (typeof data === "string") return { kind: "text", text: data };
  if (typeof data === "object" && data !== null) {
    const error = (data as Record<string, unknown>)["error"];
    if (typeof error === "string") return { kind: "failed", message: error };
  }
  throw new ParseError(`unexpected event: ${line}`);
}
