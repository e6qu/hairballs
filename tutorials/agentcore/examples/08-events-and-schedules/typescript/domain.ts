// Domain types for running the helpdesk agent from events and schedules.
// Outside data (the Lambda event, environment, Auth0's token response, the agent's reply, the
// agent's payload) is parsed into these types at the boundary. After that, a value is valid.

declare const brand: unique symbol;
type Brand<T, Name extends string> = T & { readonly [brand]: Name };

export class ParseError extends Error {}

type Fields = Readonly<Record<string, unknown>>;

function fields(raw: unknown, path: string): Fields {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ParseError(`${path}: expected an object`);
  }
  return raw as Fields;
}

function text(from: Fields, key: string, path: string): string {
  const value = from[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ParseError(`${path}.${key}: expected a non-empty string`);
  }
  return value;
}

// --- Configuration ------------------------------------------------------------------------

export type AgentArn = Brand<string, "AgentArn">;
const RUNTIME_ARN = /^arn:aws[a-z-]*:bedrock-agentcore:[a-z0-9-]+:\d{12}:runtime\/[\w-]+$/;

export interface Config {
  readonly region: string;
  readonly agent: AgentArn;
  readonly clientId: string; // the Auth0 M2M app "agent-scheduler"
  readonly secretId: string; // the Secrets Manager secret holding its client secret
}

export function parseConfig(env: Readonly<Record<string, string | undefined>>): Config {
  const agent = env.AGENT_ARN ?? "";
  if (!RUNTIME_ARN.test(agent)) throw new ParseError(`not an AgentCore runtime ARN: ${agent}`);
  return {
    region: env.AWS_REGION ?? "eu-west-1",
    agent: agent as AgentArn,
    clientId: text(env, "AUTH0_CLIENT_ID", "$env"),
    secretId: text(env, "AUTH0_SECRET_ID", "$env"),
  };
}

// --- What triggered the run ---------------------------------------------------------------

// Where an event came from, and its id. Retried deliveries carry the same id.
export interface EventRef {
  readonly source: string;
  readonly id: string;
}

export type Trigger =
  | { readonly kind: "dailyDigest"; readonly ref: EventRef }
  | { readonly kind: "ticketEscalated"; readonly ref: EventRef; readonly ticketId: string };

const TICKET_ID = /^TCK-[0-9A-Za-z]+$/;

// An EventBridge event (rule or Scheduler input) -> Trigger.
export function parseTrigger(raw: unknown): Trigger {
  const event = fields(raw, "$");
  const ref = { source: text(event, "source", "$"), id: text(event, "id", "$") };
  if (ref.source === "scheduler.daily-digest") return { kind: "dailyDigest", ref };
  if (ref.source === "fintech.tickets" && event["detail-type"] === "TicketEscalated") {
    const ticketId = text(fields(event.detail, "$.detail"), "ticketId", "$.detail");
    if (!TICKET_ID.test(ticketId)) throw new ParseError(`$.detail.ticketId: ${ticketId}`);
    return { kind: "ticketEscalated", ref, ticketId };
  }
  throw new ParseError(`$: no run for events from ${ref.source}`);
}

// --- Tokens, sessions, tasks --------------------------------------------------------------

// An Auth0 access token and when it expires (epoch milliseconds). Never printed.
export interface CachedToken {
  readonly value: string;
  readonly expiresAt: number;
}

// Auth0's /oauth/token reply -> CachedToken. `now` is passed in: no clock here.
export function parseTokenResponse(raw: unknown, now: number): CachedToken {
  const reply = fields(raw, "$");
  const expiresIn = reply.expires_in;
  if (typeof expiresIn !== "number" || !Number.isInteger(expiresIn) || expiresIn <= 0) {
    throw new ParseError("$.expires_in: expected a positive integer");
  }
  return { value: text(reply, "access_token", "$"), expiresAt: now + expiresIn * 1000 };
}

export type SessionId = Brand<string, "SessionId">; // same id = same session VM

export function parseSessionId(raw: string): SessionId {
  if (raw.length < 33 || raw.length > 256) {
    throw new ParseError("a session id must be 33 to 256 characters");
  }
  return raw as SessionId;
}

// One unit of work for the agent. The id makes a retried delivery recognisable.
export interface Task {
  readonly taskId: string;
  readonly prompt: string;
}

// The agent's /invocations payload -> Task.
export function parseTask(raw: unknown): Task {
  const payload = fields(raw, "$");
  return { taskId: text(payload, "taskId", "$"), prompt: text(payload, "prompt", "$") };
}

export const TASK_STATES = ["running", "done", "failed"] as const;
export type TaskState = (typeof TASK_STATES)[number];

export interface Accepted {
  readonly taskId: string;
  readonly state: TaskState;
}

// The agent's reply -> Accepted. Anything else is an error.
export function parseAgentReply(raw: unknown): Accepted {
  const reply = fields(raw, "$");
  if (reply.status !== "accepted") throw new ParseError("$.status: the agent did not accept");
  const state = TASK_STATES.find((s) => s === reply.state);
  if (state === undefined) throw new ParseError(`$.state: unknown task state`);
  return { taskId: text(reply, "taskId", "$"), state };
}
