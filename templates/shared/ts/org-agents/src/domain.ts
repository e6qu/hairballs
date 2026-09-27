/**
 * Domain types shared by every agent template.
 *
 * Values with meaning get their own branded type. Each type has a companion object of the same
 * name with:
 *   - `parse(raw: unknown, path)` → `Result<T, ParseError>`: the only way outside data gets in;
 *   - `of(...)`: build from trusted program values (constants, tests); throws on a broken invariant
 *     (the equivalent of a Python constructor raising `ValueError`, i.e. a bug).
 */

import {
  attempt,
  charLength,
  decimalToScale,
  expectArray,
  expectDecimal,
  expectInt,
  expectNonEmptyString,
  expectObject,
  fail,
  field,
  fieldOr,
  must,
  typeName,
  type Parsed,
} from "./parsing.ts";
import { ok, traverse } from "./result.ts";

export type Brand<T, B extends string> = T & { readonly __brand: B };

// ---------------------------------------------------------------- identifiers

const ID_PATTERN = /^[A-Za-z0-9._:@/-]{1,256}$/;
// Auth0 subjects look like "auth0|123", "google-oauth2|123" or "<client_id>@clients".
const PRINCIPAL_PATTERN = /^[A-Za-z0-9._:@/|-]{1,256}$/;
const TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;
const TOOL_PATTERN_PATTERN = /^[A-Za-z0-9_.*?-]{1,128}$/;
const MODEL_ID_PATTERN = /^[A-Za-z0-9._:/-]{3,2048}$/;
const REGION_PATTERN = /^[a-z]{2}(-gov)?-[a-z]+-\d$/;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

export type StringIdCompanion<T> = {
  /** Parse outside data (trimmed, non-empty, bounded, pattern-checked). */
  readonly parse: (raw: unknown, path?: string) => Parsed<T>;
  /** Build from a trusted string; throws `RangeError` if it breaks the invariant. */
  readonly of: (text: string) => T;
  /** True when `text` already satisfies the invariant (no trimming). */
  readonly is: (text: string) => text is string & T;
};

function stringId<T extends string>(spec: {
  readonly label: string;
  readonly pattern: RegExp;
  readonly maxLength: number;
  readonly defaultPath: string;
  readonly invalid: string;
}): StringIdCompanion<T> {
  const is = (text: string): text is string & T => spec.pattern.test(text);
  return {
    is,
    of(text: string): T {
      if (!is(text)) throw new RangeError(`invalid ${spec.label}: ${JSON.stringify(text)}`);
      return text;
    },
    parse(raw: unknown, path: string = spec.defaultPath): Parsed<T> {
      const text = expectNonEmptyString(raw, path, { maxLength: spec.maxLength });
      if (text.kind === "err") return text;
      return is(text.value) ? ok(text.value) : fail(path, spec.invalid);
    },
  };
}

/** An AgentCore runtime session / conversation thread identifier. */
export type SessionId = Brand<string, "SessionId">;
export const SessionId: StringIdCompanion<SessionId> = stringId<SessionId>({
  label: "session id",
  pattern: ID_PATTERN,
  maxLength: 256,
  defaultPath: "$.session_id",
  invalid: "contains characters outside [A-Za-z0-9._:@/-]",
});

/** Who the agent acts for: an Auth0 `sub` (user or `<client>@clients`) or an IAM principal. */
export type PrincipalId = Brand<string, "PrincipalId">;
export const PrincipalId: StringIdCompanion<PrincipalId> = stringId<PrincipalId>({
  label: "principal id",
  pattern: PRINCIPAL_PATTERN,
  maxLength: 256,
  defaultPath: "$.principal",
  invalid: "contains unsupported characters",
});

export type MessageId = Brand<string, "MessageId">;
export const MessageId: StringIdCompanion<MessageId> = stringId<MessageId>({
  label: "message id",
  pattern: ID_PATTERN,
  maxLength: 256,
  defaultPath: "$.message_id",
  invalid: "contains unsupported characters",
});

export type ApprovalId = Brand<string, "ApprovalId">;
export const ApprovalId: StringIdCompanion<ApprovalId> = stringId<ApprovalId>({
  label: "approval id",
  pattern: ID_PATTERN,
  maxLength: 256,
  defaultPath: "$.approval_id",
  invalid: "contains unsupported characters",
});

export type ToolName = Brand<string, "ToolName">;
export const ToolName: StringIdCompanion<ToolName> = stringId<ToolName>({
  label: "tool name",
  pattern: TOOL_NAME_PATTERN,
  maxLength: 128,
  defaultPath: "$.tool",
  invalid: "is not a valid tool name",
});

/** A glob over tool names, e.g. `gw_*` or `create_ticket` (`*` = any run, `?` = one character). */
export type ToolPattern = Brand<string, "ToolPattern">;
const toolPatternBase = stringId<ToolPattern>({
  label: "tool pattern",
  pattern: TOOL_PATTERN_PATTERN,
  maxLength: 128,
  defaultPath: "$.tool_pattern",
  invalid: "is not a valid tool pattern",
});
const globCache = new Map<string, RegExp>();
function globRegExp(pattern: string): RegExp {
  let compiled = globCache.get(pattern);
  if (compiled === undefined) {
    const body = [...pattern]
      .map((ch) => (ch === "*" ? "[\\s\\S]*" : ch === "?" ? "[\\s\\S]" : ch.replace(/[.\-]/g, "\\$&")))
      .join("");
    compiled = new RegExp(`^${body}$`, "u");
    globCache.set(pattern, compiled);
  }
  return compiled;
}
export const ToolPattern = {
  ...toolPatternBase,
  /** Case-sensitive glob match (Python `fnmatch.fnmatchcase`). */
  matches(pattern: ToolPattern, tool: ToolName): boolean {
    return globRegExp(pattern).test(tool);
  },
} as const;

/** A stable sha256 hex digest of canonical tool arguments (computed in the shell from raw arguments). */
export type Fingerprint = Brand<string, "Fingerprint">;
export const Fingerprint: StringIdCompanion<Fingerprint> = stringId<Fingerprint>({
  label: "fingerprint",
  pattern: FINGERPRINT_PATTERN,
  maxLength: 64,
  defaultPath: "$.fingerprint",
  invalid: "must be a sha256 hex digest",
});

/** A Bedrock model id, cross-region inference profile id, or application inference profile ARN. */
export type ModelId = Brand<string, "ModelId">;
export const ModelId: StringIdCompanion<ModelId> = stringId<ModelId>({
  label: "model id",
  pattern: MODEL_ID_PATTERN,
  maxLength: 2048,
  defaultPath: "$.model_id",
  invalid: "is not a valid Bedrock model id or ARN",
});

export type AwsRegion = Brand<string, "AwsRegion">;
export const AwsRegion: StringIdCompanion<AwsRegion> = stringId<AwsRegion>({
  label: "AWS region",
  pattern: REGION_PATTERN,
  maxLength: 32,
  defaultPath: "$.region",
  invalid: "is not an AWS region",
});

// ---------------------------------------------------------------- quantities

const MICROS_PER_USD = 1_000_000;

/**
 * A non-negative amount of US dollars as an integer number of micro-dollars. Never a float
 * amount: arithmetic is integer arithmetic, and parsing is exact decimal parsing.
 */
export type Usd = Brand<number, "Usd">;
export const Usd = {
  zero: 0 as Usd,

  /** From an integer number of micro-dollars. */
  fromMicros(micros: number): Usd {
    if (!Number.isSafeInteger(micros) || micros < 0) {
      throw new RangeError("Usd must be a non-negative integer number of micro-dollars");
    }
    return micros as Usd;
  },

  /** From a trusted decimal literal such as `"0.50"` or `3`; throws on invalid input. */
  of(amount: string | number): Usd {
    const parsed = Usd.parse(amount, "$");
    if (parsed.kind === "err") throw new RangeError(`invalid Usd: ${parsed.error.message}`);
    return parsed.value;
  },

  /** Parse a number or decimal string exactly, rounding to micro-dollars (half-even). */
  parse(raw: unknown, path: string): Parsed<Usd> {
    if (typeof raw === "boolean") return fail(path, "expected a number, got boolean");
    const decimal = expectDecimal(raw, path);
    if (decimal.kind === "err") return decimal;
    if (decimal.value.units < 0n) return fail(path, "must be >= 0");
    const micros = decimalToScale(decimal.value, 6);
    if (micros > BigInt(Number.MAX_SAFE_INTEGER)) return fail(path, "is out of range");
    return ok(Number(micros) as Usd);
  },

  add(a: Usd, b: Usd): Usd {
    return Usd.fromMicros(a + b);
  },

  micros(amount: Usd): number {
    return amount;
  },

  /** Fixed six decimals, e.g. `"0.105000"` (Python `str(usd.amount)`). */
  toDecimalString(amount: Usd): string {
    const whole = Math.floor(amount / MICROS_PER_USD);
    const fraction = String(amount % MICROS_PER_USD).padStart(6, "0");
    return `${whole}.${fraction}`;
  },

  /** Human form without trailing zeros, e.g. `"$0.105"`, `"$1"` (Python `str(usd)`). */
  format(amount: Usd): string {
    const text = Usd.toDecimalString(amount).replace(/0+$/, "").replace(/\.$/, "");
    return `$${text}`;
  },
} as const;

export type TokenCount = Brand<number, "TokenCount">;
export const TokenCount = {
  zero: 0 as TokenCount,
  of(value: number): TokenCount {
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("token count must be >= 0");
    return value as TokenCount;
  },
  add(a: TokenCount, b: TokenCount): TokenCount {
    return TokenCount.of(a + b);
  },
  parse(raw: unknown, path: string): Parsed<TokenCount> {
    const value = expectInt(raw, path, { minimum: 0 });
    return value.kind === "err" ? value : ok(value.value as TokenCount);
  },
} as const;

export type PositiveInt = Brand<number, "PositiveInt">;
export const PositiveInt = {
  of(value: number): PositiveInt {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError("must be >= 1");
    return value as PositiveInt;
  },
  parse(raw: unknown, path: string): Parsed<PositiveInt> {
    const value = expectInt(raw, path, { minimum: 1 });
    return value.kind === "err" ? value : ok(value.value as PositiveInt);
  },
} as const;

/** A length of time in milliseconds (non-negative). */
export type DurationMs = Brand<number, "DurationMs">;
export const DurationMs = {
  of(ms: number): DurationMs {
    if (!Number.isFinite(ms) || ms < 0) throw new RangeError("duration must be a finite, non-negative number");
    return ms as DurationMs;
  },
  seconds(seconds: number): DurationMs {
    return DurationMs.of(seconds * 1000);
  },
  minutes(minutes: number): DurationMs {
    return DurationMs.of(minutes * 60_000);
  },
  /** Python `str(timedelta)`: `"0:05:00"`, `"1 day, 2:03:04"`, `"0:00:01.500000"`. */
  format(duration: DurationMs): string {
    const totalMicros = Math.round(duration * 1000);
    const micros = totalMicros % 1_000_000;
    const totalSeconds = Math.floor(totalMicros / 1_000_000);
    const days = Math.floor(totalSeconds / 86_400);
    const hours = Math.floor((totalSeconds % 86_400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const pad = (n: number): string => String(n).padStart(2, "0");
    let text = `${hours}:${pad(minutes)}:${pad(seconds)}`;
    if (micros !== 0) text += `.${String(micros).padStart(6, "0")}`;
    return days === 0 ? text : `${days} day${days === 1 ? "" : "s"}, ${text}`;
  },
} as const;

/** A point in time: milliseconds since the Unix epoch (UTC). Supplied by the shell's clock. */
export type Instant = Brand<number, "Instant">;
export const Instant = {
  of(msSinceEpoch: number): Instant {
    if (!Number.isFinite(msSinceEpoch)) throw new RangeError("Instant must be finite");
    return msSinceEpoch as Instant;
  },
  fromDate(date: Date): Instant {
    return Instant.of(date.getTime());
  },
  /** Parse an ISO-8601 timestamp that carries a timezone (`Z` or `±hh:mm`). */
  parse(raw: unknown, path: string): Parsed<Instant> {
    const text = expectNonEmptyString(raw, path, { maxLength: 64 });
    if (text.kind === "err") return text;
    if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text.value)) return fail(path, "must be timezone-aware");
    const ms = Date.parse(text.value);
    return Number.isNaN(ms) ? fail(path, "is not an ISO-8601 timestamp") : ok(ms as Instant);
  },
  plus(at: Instant, duration: DurationMs): Instant {
    return Instant.of(at + duration);
  },
  /** `later - earlier`, clamped at zero (a clock never runs backwards for the guard). */
  since(later: Instant, earlier: Instant): DurationMs {
    return Math.max(0, later - earlier) as DurationMs;
  },
  /** Python `datetime.isoformat()` of a UTC datetime: `2026-01-01T00:00:00+00:00` (`.ffffff` if any). */
  toIso(at: Instant): string {
    const iso = new Date(at).toISOString(); // 2026-01-01T00:00:00.000Z
    const base = iso.slice(0, 19);
    const ms = iso.slice(20, 23);
    return ms === "000" ? `${base}+00:00` : `${base}.${ms}000+00:00`;
  },
} as const;

/** Token usage reported by one model call. */
export type Usage = {
  readonly inputTokens: TokenCount;
  readonly outputTokens: TokenCount;
  readonly cacheReadTokens: TokenCount;
  readonly cacheWriteTokens: TokenCount;
};
export const Usage = {
  of(
    inputTokens: TokenCount,
    outputTokens: TokenCount,
    cacheReadTokens: TokenCount = TokenCount.zero,
    cacheWriteTokens: TokenCount = TokenCount.zero,
  ): Usage {
    return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
  },
  total(usage: Usage): TokenCount {
    return TokenCount.of(
      usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens,
    );
  },
} as const;

/** USD price per one million tokens for a model (or application inference profile). */
export type ModelPrice = {
  readonly inputPerMtok: Usd;
  readonly outputPerMtok: Usd;
  readonly cacheReadPerMtok: Usd;
  readonly cacheWritePerMtok: Usd;
};
export const ModelPrice = {
  parse(raw: unknown, path = "$.price"): Parsed<ModelPrice> {
    return attempt(() => {
      const fields = must(expectObject(raw, path));
      const usd = (name: string): Usd => must(Usd.parse(must(field(fields, name, path)), `${path}.${name}`));
      return {
        inputPerMtok: usd("input_per_mtok"),
        outputPerMtok: usd("output_per_mtok"),
        cacheReadPerMtok: usd("cache_read_per_mtok"),
        cacheWritePerMtok: usd("cache_write_per_mtok"),
      };
    });
  },
} as const;

// ---------------------------------------------------------------- limits and policy

/** Per-run limits enforced by the guard. Every agent run has all of them. */
export type Limits = {
  readonly maxTurns: PositiveInt;
  readonly maxTotalTokens: PositiveInt;
  readonly maxUsd: Usd;
  readonly maxWallTime: DurationMs;
  readonly maxToolCalls: PositiveInt;
  readonly repeatThreshold: PositiveInt;
};
export const Limits = {
  of(limits: Limits): Limits {
    if (!(limits.maxWallTime > 0)) throw new RangeError("maxWallTime must be positive");
    if (limits.repeatThreshold < 2) throw new RangeError("repeatThreshold must be >= 2");
    return limits;
  },
  parse(raw: unknown, path = "$.limits"): Parsed<Limits> {
    return attempt(() => {
      const fields = must(expectObject(raw, path));
      const positive = (name: string): PositiveInt =>
        must(PositiveInt.parse(must(field(fields, name, path)), `${path}.${name}`));
      const repeatThreshold = positive("repeat_threshold");
      if (repeatThreshold < 2) must(fail(`${path}.repeat_threshold`, "must be >= 2"));
      return {
        maxTurns: positive("max_turns"),
        maxTotalTokens: positive("max_total_tokens"),
        maxUsd: must(Usd.parse(must(field(fields, "max_usd", path)), `${path}.max_usd`)),
        maxWallTime: DurationMs.seconds(positive("max_wall_seconds")),
        maxToolCalls: positive("max_tool_calls"),
        repeatThreshold,
      };
    });
  },
} as const;

/** Which tools may run, and which need human approval first. Unlisted tools are denied. */
export type ToolPolicy = {
  readonly allowed: readonly ToolPattern[];
  readonly approvalRequired: readonly ToolPattern[];
};
export const ToolPolicy = {
  parse(raw: unknown, path = "$.tools"): Parsed<ToolPolicy> {
    return attempt(() => {
      const fields = must(expectObject(raw, path));
      const patterns = (items: readonly unknown[], at: string): readonly ToolPattern[] =>
        must(traverse(items, (item, i) => ToolPattern.parse(item, `${at}[${i}]`)));
      const allowedRaw = must(expectArray(must(field(fields, "allowed", path)), `${path}.allowed`));
      const approvalRaw = must(
        expectArray(fieldOr(fields, "approval_required", []), `${path}.approval_required`),
      );
      return {
        allowed: patterns(allowedRaw, `${path}.allowed`),
        approvalRequired: patterns(approvalRaw, `${path}.approval_required`),
      };
    });
  },
} as const;

// ---------------------------------------------------------------- conversation

const PROMPT_MAX_CHARS = 32_000;

/** A user prompt: non-empty text with a bounded size. */
export type Prompt = Brand<string, "Prompt">;
export const Prompt = {
  MAX_CHARS: PROMPT_MAX_CHARS,
  of(text: string): Prompt {
    if (text.trim().length === 0) throw new RangeError("prompt must not be empty");
    if (charLength(text) > PROMPT_MAX_CHARS) throw new RangeError("prompt too long");
    return text as Prompt;
  },
  parse(raw: unknown, path = "$.prompt"): Parsed<Prompt> {
    const text = expectNonEmptyString(raw, path, { maxLength: PROMPT_MAX_CHARS });
    return text.kind === "err" ? text : ok(text.value as Prompt);
  },
} as const;

export type ApprovalDecision = "approve" | "reject";
export const ApprovalDecision = {
  APPROVE: "approve",
  REJECT: "reject",
  parse(raw: unknown, path: string): Parsed<ApprovalDecision> {
    const text = expectNonEmptyString(raw, path);
    if (text.kind === "err") return text;
    const value = text.value.toLowerCase();
    return value === "approve" || value === "reject" ? ok(value) : fail(path, "must be 'approve' or 'reject'");
  },
} as const;

// ---------------------------------------------------------------- forwarded credentials
//
// Secrets forwarded by AgentCore Runtime. They are passed on only to the services that need them
// (AgentCore Gateway, AgentCore Identity) and never reach the model, audit events, replies or logs.
// Parse errors never echo the value.

const CREDENTIAL_MAX_CHARS = 16_384;
// A compact JWS: three base64url segments (the signature may be empty for `alg: none` test tokens).
const CALLER_TOKEN_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;
// Opaque to us: visible ASCII only (no whitespace or control characters, so it is header-safe).
const WORKLOAD_TOKEN_PATTERN = /^[\x21-\x7E]+$/;

function credential<T extends string>(label: string, pattern: RegExp, invalid: string) {
  const is = (text: string): boolean => text.length <= CREDENTIAL_MAX_CHARS && pattern.test(text);
  return {
    /** Build from a trusted string (tests); throws without echoing the value. */
    of(text: string): T {
      if (!is(text)) throw new RangeError(`invalid ${label}`);
      return text as T;
    },
    parse(raw: unknown, path: string): Parsed<T> {
      if (typeof raw !== "string") return fail(path, `expected a string, got ${typeName(raw)}`);
      const text = raw.trim();
      if (text.length === 0) return fail(path, "must not be empty");
      if (text.length > CREDENTIAL_MAX_CHARS) return fail(path, `must be at most ${CREDENTIAL_MAX_CHARS} characters`);
      return pattern.test(text) ? ok(text as T) : fail(path, invalid);
    },
  } as const;
}

/**
 * The caller's Auth0 access token (the raw JWT from `Authorization: Bearer …`), already validated
 * by AgentCore Runtime's `customJWTAuthorizer`. Forward it to AgentCore Gateway so tool calls
 * carry the user's identity. A secret: never log, audit, render or show it to the model.
 */
export type CallerToken = Brand<string, "CallerToken">;
export const CallerToken = credential<CallerToken>("caller token", CALLER_TOKEN_PATTERN, "is not a JWT");

/**
 * The Workload Access Token AgentCore Runtime issues for (workload, user) and passes in the
 * `WorkloadAccessToken` header; exchange it with AgentCore Identity for outbound credentials
 * (Token Vault). A secret: never log, audit, render or show it to the model.
 */
export type WorkloadAccessToken = Brand<string, "WorkloadAccessToken">;
export const WorkloadAccessToken = credential<WorkloadAccessToken>(
  "workload access token",
  WORKLOAD_TOKEN_PATTERN,
  "must be visible ASCII without spaces",
);
