// Domain types for the expenses tool and its callers.
// Data from outside the program (tool arguments, the Lambda context, environment, MCP results) is
// parsed into these types at the boundary. After that, a value that exists is valid: no code
// downstream re-checks it.

declare const brand: unique symbol;
type Brand<T, Name extends string> = T & { readonly [brand]: Name };

export class ParseError extends Error {}

export const CATEGORIES = ["hotel", "meals"] as const; // hotel per night, meals per day
export type Category = (typeof CATEGORIES)[number];
export const CITY_CLASSES = ["major", "standard"] as const;
export type CityClass = (typeof CITY_CLASSES)[number];

// A non-negative amount in euro cents. Money is an integer, never a float.
export type Cents = Brand<number, "Cents">;

export interface Claim {
  readonly category: Category;
  readonly amount: Cents;
  readonly city: CityClass;
}

// How a gateway names a tool: <target>___<tool>, e.g. expenses___check_claim.
export interface GatewayToolName {
  readonly target: string;
  readonly tool: string;
}

export type Verdict =
  | { readonly kind: "within"; readonly limit: Cents }
  | { readonly kind: "over"; readonly limit: Cents; readonly excess: Cents };

// The gateway's MCP endpoint.
export type GatewayUrl = Brand<string, "GatewayUrl">;

const GATEWAY_URL =
  /^https:\/\/[a-z0-9-]+\.gateway\.bedrock-agentcore\.[a-z0-9-]+\.amazonaws\.com\/mcp$/;

function fields(raw: unknown, path: string): Readonly<Record<string, unknown>> {
  if (typeof raw !== "object" || raw === null) {
    throw new ParseError(`${path}: expected an object, got ${JSON.stringify(raw)}`);
  }
  return raw as Readonly<Record<string, unknown>>;
}

function oneOf<T extends string>(allowed: readonly T[], raw: unknown, path: string): T {
  const value = allowed.find((a) => a === raw);
  if (value === undefined) {
    throw new ParseError(
      `${path}: expected one of ${allowed.join(", ")}, got ${JSON.stringify(raw)}`,
    );
  }
  return value;
}

export function parseEur(raw: unknown, path = "$"): Cents {
  const n = typeof raw === "number" || typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n < 0) {
    throw new ParseError(
      `${path}: expected a non-negative amount in EUR, got ${JSON.stringify(raw)}`,
    );
  }
  return Math.round(n * 100) as Cents;
}

// The check_claim tool's arguments, as the gateway passes them to the Lambda.
export function parseClaim(raw: unknown): Claim {
  const f = fields(raw, "$");
  return {
    category: oneOf(CATEGORIES, f.category, "$.category"),
    amount: parseEur(f.amount_eur, "$.amount_eur"),
    city: oneOf(CITY_CLASSES, f.city_class ?? "standard", "$.city_class"),
  };
}

export function parseGatewayToolName(raw: string): GatewayToolName {
  const at = raw.indexOf("___");
  const target = raw.slice(0, Math.max(at, 0));
  const tool = raw.slice(at + 3);
  if (at <= 0 || tool === "") {
    throw new ParseError(`not a gateway tool name (<target>___<tool>): ${JSON.stringify(raw)}`);
  }
  return { target, tool };
}

export function formatToolName(name: GatewayToolName): string {
  return `${name.target}___${name.tool}`;
}

// The tool the gateway invoked, from the Lambda context. Node passes the client context as sent,
// so accept both spellings of "custom".
export function parseInvokedTool(context: unknown): GatewayToolName {
  const clientContext = fields(fields(context, "context").clientContext, "context.clientContext");
  const custom = fields(
    clientContext.custom ?? clientContext.Custom,
    "context.clientContext.custom",
  );
  const name = custom.bedrockAgentCoreToolName;
  if (typeof name !== "string") {
    throw new ParseError("context.clientContext.custom: no bedrockAgentCoreToolName");
  }
  return parseGatewayToolName(name);
}

// The check_claim result, as the MCP client receives it (JSON text).
export function parseVerdict(text: string): Verdict {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ParseError(`$: not JSON: ${text.slice(0, 80)}`);
  }
  const f = fields(json, "$");
  const limit = parseEur(f.limit_eur, "$.limit_eur");
  if (f.within_policy === true) return { kind: "within", limit };
  if (f.within_policy === false) {
    return { kind: "over", limit, excess: parseEur(f.excess_eur, "$.excess_eur") };
  }
  throw new ParseError(
    `$.within_policy: expected true or false, got ${JSON.stringify(f.within_policy)}`,
  );
}

export function parseGatewayUrl(raw: string): GatewayUrl {
  if (!GATEWAY_URL.test(raw)) throw new ParseError(`not a gateway MCP URL: ${JSON.stringify(raw)}`);
  return raw as GatewayUrl;
}

// For outbound JSON only (tool arguments and results are JSON numbers in EUR).
export function eurToJson(amount: Cents): number {
  return amount / 100;
}
