// Domain types for the helpdesk behind Auth0.
// Outside data (the Authorization header and its JWT claims, the HTTP payload, the session header,
// tool arguments, API and Auth0 responses, the environment, server-sent events) is parsed into
// these types at the boundary. After that, a value that exists is valid.
declare const brand: unique symbol;
type Brand<T, Name extends string> = T & { readonly [brand]: Name };

export class ParseError extends Error {}

export const NS = "https://fintech.example/"; // the claim namespace set by the Auth0 Action

export type Subject = Brand<string, "Subject">; // Auth0 `sub`: for authorization and audit
export type UserId = Brand<string, "UserId">; // our stable id; also a valid Memory actor id
export type EmailAddress = Brand<string, "EmailAddress">;
export type SessionId = Brand<string, "SessionId">;
export type Prompt = Brand<string, "Prompt">;
export type TicketId = Brand<string, "TicketId">;
export type AccessToken = Brand<string, "AccessToken">;
export type AgentRuntimeArn = Brand<string, "AgentRuntimeArn">;

const USER_ID = /^usr_[0-9a-f]{32}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const RUNTIME_ARN =
  /^arn:aws[a-z-]*:bedrock-agentcore:[a-z0-9-]+:\d{12}:runtime\/[A-Za-z][A-Za-z0-9_]*-[A-Za-z0-9]+$/;

function fields(raw: unknown, path: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null) throw new ParseError(`${path} must be an object`);
  return raw as Record<string, unknown>;
}

function text(raw: unknown, path: string): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new ParseError(`${path} must be a non-empty string`);
  }
  return raw.trim();
}

export type Caller =
  | {
      readonly kind: "human";
      readonly subject: Subject;
      readonly userId: UserId;
      readonly email: EmailAddress;
      readonly firstName: string | undefined;
    }
  | { readonly kind: "service"; readonly subject: Subject }; // M2M: a service, no profile

// The claims in a `Bearer <JWT>` header. Runtime has already checked signature, issuer, expiry
// and audience; this only decodes the payload.
export function claimsOf(authorization: string | undefined): Record<string, unknown> {
  const parts = (authorization ?? "").replace(/^Bearer /, "").split(".");
  if (parts.length !== 3) throw new ParseError("the Authorization header must hold a bearer JWT");
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8"));
  } catch {
    throw new ParseError("the JWT payload is not JSON");
  }
  return fields(claims, "$jwt");
}

export function parseCaller(claims: Record<string, unknown>): Caller {
  const subject = text(claims["sub"], "$jwt.sub") as Subject;
  if (subject.endsWith("@clients") || claims["gty"] === "client-credentials") {
    return { kind: "service", subject };
  }
  const userId = claims[`${NS}user_id`];
  if (typeof userId !== "string" || !USER_ID.test(userId)) throw new ParseError("no user id");
  const email = claims[`${NS}email`];
  if (typeof email !== "string" || !EMAIL.test(email)) {
    throw new ParseError("a person's token must carry an email address");
  }
  const firstName = claims[`${NS}given_name`];
  return {
    kind: "human",
    subject,
    userId: userId as UserId,
    email: email as EmailAddress,
    firstName: typeof firstName === "string" && firstName.trim() ? firstName : undefined,
  };
}

export function parseSessionId(raw: string): SessionId {
  if (raw.length < 33 || raw.length > 256) {
    throw new ParseError("a session id must be 33 to 256 characters (use a UUID)");
  }
  return raw as SessionId;
}

export const parsePrompt = (raw: unknown): Prompt => text(raw, "$.prompt") as Prompt;

// The /invocations body: {"prompt": "..."}.
export const parseInvocation = (raw: unknown): Prompt => parsePrompt(fields(raw, "$")["prompt"]);

export interface TicketRequest {
  readonly title: string;
  readonly description: string;
}

export function parseTicketRequest(title: string, description: string): TicketRequest {
  return { title: text(title, "title"), description: text(description, "description") };
}

// The tickets API's reply: {"id": "..."}.
export const parseTicketCreated = (raw: unknown): TicketId =>
  text(fields(raw, "$")["id"], "$.id") as TicketId;

export function parseAccessToken(raw: unknown): AccessToken {
  const token = text(raw, "access token");
  if (token.split(".").length !== 3) throw new ParseError("an access token must be a JWT");
  return token as AccessToken;
}

// Auth0's /oauth/token reply: {"access_token": "...", ...}.
export const parseTokenResponse = (raw: unknown): AccessToken =>
  parseAccessToken(fields(raw, "$")["access_token"]);

export function parseAgentRuntimeArn(raw: string): AgentRuntimeArn {
  if (!RUNTIME_ARN.test(raw)) throw new ParseError(`not an agent runtime ARN: ${raw}`);
  return raw as AgentRuntimeArn;
}

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
  const error = fields(data, "$")["error"];
  if (typeof error === "string") return { kind: "failed", message: error };
  throw new ParseError(`unexpected event: ${line}`);
}
