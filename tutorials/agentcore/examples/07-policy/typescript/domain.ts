// Domain types for calling a Gateway tool.
// Outside data (environment, the Gateway's JSON-RPC reply) is parsed into these types at the
// boundary. After that, a value that exists is valid: no code downstream re-checks it.

declare const brand: unique symbol;
type Brand<T, Name extends string> = T & { readonly [brand]: Name };

export class ParseError extends Error {}

export type GatewayUrl = Brand<string, "GatewayUrl">;
export type AccessToken = Brand<string, "AccessToken">; // an Auth0 JWT; never printed
export type ToolName = Brand<string, "ToolName">; // <target>___<tool>, the Cedar action

const GATEWAY_URL = /^https:\/\/[a-z0-9.-]+\/mcp$/;
const TOOL_NAME = /^[a-z0-9-]+___[A-Za-z0-9_]+$/;
export const DENIED_PREFIX = "AuthorizeActionException"; // how the Gateway words a Cedar deny

export function parseGatewayUrl(raw: string): GatewayUrl {
  if (!GATEWAY_URL.test(raw)) throw new ParseError(`not a Gateway MCP URL: ${raw}`);
  return raw as GatewayUrl;
}

export function parseAccessToken(raw: string): AccessToken {
  if (raw.split(".").length !== 3) throw new ParseError("the access token is not a JWT");
  return raw as AccessToken;
}

export function parseToolName(raw: string): ToolName {
  if (!TOOL_NAME.test(raw)) throw new ParseError(`not a Gateway tool name: ${raw}`);
  return raw as ToolName;
}

// What became of one tool call. A denial is final: retrying will not help.
export type Decision =
  | { readonly kind: "allowed"; readonly text: string }
  | { readonly kind: "denied"; readonly reason: string }
  | { readonly kind: "failed"; readonly message: string };

function fields(raw: unknown, path: string): Readonly<Record<string, unknown>> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ParseError(`${path}: expected an object`);
  }
  return raw as Record<string, unknown>;
}

// A JSON-RPC reply to tools/call -> Decision.
export function parseToolReply(raw: unknown): Decision {
  const reply = fields(raw, "$");
  if (reply.error !== undefined) {
    const message = fields(reply.error, "$.error").message;
    return { kind: "failed", message: typeof message === "string" ? message : "JSON-RPC error" };
  }
  const result = fields(reply.result, "$.result");
  const content: unknown = result.content ?? [];
  if (!Array.isArray(content)) throw new ParseError("$.result.content: expected a list");
  const text = content
    .map((block: unknown) => (typeof block === "object" && block !== null ? block : {}))
    .map((block) => ("text" in block && typeof block.text === "string" ? block.text : ""))
    .filter((t) => t !== "")
    .join("\n");
  if (result.isError !== true) return { kind: "allowed", text };
  if (text.startsWith(DENIED_PREFIX)) return { kind: "denied", reason: text };
  return { kind: "failed", message: text };
}
