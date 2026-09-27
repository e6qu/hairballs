/**
 * Boundary parsing helpers: turn untyped outside data (`unknown`) into primitives, with a JSON path.
 *
 * These helpers are the only place where untyped data is inspected. Domain parsers
 * (`X.parse` in domain.ts) build on them and return domain types; nothing past the boundary
 * ever sees `unknown` again.
 */

import { err, ok, type Result } from "./result.ts";

/** Outside data could not be parsed into a domain type. `path` is a JSON path such as `$.limits.max_turns`. */
export class ParseError extends Error {
  override readonly name = "ParseError";
  readonly path: string;
  readonly detail: string;

  constructor(path: string, detail: string) {
    super(`${path}: ${detail}`);
    this.path = path;
    this.detail = detail;
  }
}

export type Parsed<T> = Result<T, ParseError>;

/** A JSON-ish object seen through the boundary: keys are strings, values are still untyped. */
export type UnknownRecord = Readonly<Record<string, unknown>>;

export function fail(path: string, detail: string): Parsed<never> {
  return err(new ParseError(path, detail));
}

/**
 * Write multi-field parsers in direct style: inside `attempt`, `must(result)` unwraps a parse
 * result or aborts with its ParseError, which `attempt` turns back into an `Err`. Other
 * exceptions (bugs) propagate unchanged.
 */
export function attempt<T>(body: () => T): Parsed<T> {
  try {
    return ok(body());
  } catch (error) {
    if (error instanceof ParseError) return err(error);
    throw error;
  }
}

export function must<T>(result: Parsed<T>): T {
  if (result.kind === "ok") return result.value;
  throw result.error;
}

export function typeName(raw: unknown): string {
  if (raw === null) return "null";
  if (Array.isArray(raw)) return "array";
  if (typeof raw === "number") return Number.isInteger(raw) ? "integer" : "number";
  return typeof raw;
}

export function expectObject(raw: unknown, path: string): Parsed<UnknownRecord> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return fail(path, `expected an object, got ${typeName(raw)}`);
  }
  return ok(raw as UnknownRecord);
}

export function expectArray(raw: unknown, path: string): Parsed<readonly unknown[]> {
  if (!Array.isArray(raw)) return fail(path, `expected an array, got ${typeName(raw)}`);
  return ok(raw as readonly unknown[]);
}

export function hasField(fields: UnknownRecord, name: string): boolean {
  return Object.hasOwn(fields, name);
}

/** A required field. Missing → `ParseError("<path>.<name>", "is required")`. */
export function field(fields: UnknownRecord, name: string, path: string): Parsed<unknown> {
  if (!Object.hasOwn(fields, name)) return fail(`${path}.${name}`, "is required");
  return ok(fields[name]);
}

/** An optional field with a default (like Python's `fields.get(name, default)`). */
export function fieldOr(fields: UnknownRecord, name: string, fallback: unknown): unknown {
  return Object.hasOwn(fields, name) ? fields[name] : fallback;
}

export function expectString(raw: unknown, path: string): Parsed<string> {
  if (typeof raw !== "string") return fail(path, `expected a string, got ${typeName(raw)}`);
  return ok(raw);
}

/** Length in characters (code points), as Python's `len(str)`. */
export function charLength(text: string): number {
  let n = 0;
  for (const _ of text) n += 1;
  return n;
}

/** A string, trimmed, non-empty, optionally bounded. Returns the trimmed value. */
export function expectNonEmptyString(
  raw: unknown,
  path: string,
  options: { readonly maxLength?: number } = {},
): Parsed<string> {
  const text = expectString(raw, path);
  if (text.kind === "err") return text;
  const value = text.value.trim();
  if (value.length === 0) return fail(path, "must not be empty");
  if (options.maxLength !== undefined && charLength(value) > options.maxLength) {
    return fail(path, `must be at most ${options.maxLength} characters`);
  }
  return ok(value);
}

/**
 * An integer. Accepts JSON integers and decimal-integer strings (environment variables);
 * rejects booleans (a JSON `true` is never a count) and non-integral numbers.
 */
export function expectInt(
  raw: unknown,
  path: string,
  options: { readonly minimum?: number } = {},
): Parsed<number> {
  let value: number;
  if (typeof raw === "number" && Number.isInteger(raw)) {
    value = raw;
  } else if (typeof raw === "string" && /^-?\d+$/.test(raw.trim())) {
    value = Number(raw.trim());
  } else {
    return fail(path, `expected an integer, got ${typeName(raw)}`);
  }
  if (!Number.isSafeInteger(value)) return fail(path, "is out of range");
  if (options.minimum !== undefined && value < options.minimum) {
    return fail(path, `must be >= ${options.minimum}`);
  }
  return ok(value);
}

export function expectBool(raw: unknown, path: string): Parsed<boolean> {
  if (typeof raw === "boolean") return ok(raw);
  if (typeof raw === "string") {
    const text = raw.trim().toLowerCase();
    if (text === "true" || text === "1") return ok(true);
    if (text === "false" || text === "0") return ok(false);
  }
  return fail(path, `expected a boolean, got ${typeName(raw)}`);
}

// ---------------------------------------------------------------- exact decimals

/** An exact decimal number: `units × 10^-scale`. Never a binary float. */
export type Decimal = { readonly units: bigint; readonly scale: number };

const DECIMAL_PATTERN = /^([+-])?(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;
const NON_FINITE_PATTERN = /^[+-]?(?:inf|infinity|s?nan)$/i;

/**
 * A decimal number from a JSON number or a decimal string, parsed exactly.
 * Numbers go through their shortest round-trip representation (`String(n)`, like Python's
 * `repr(float)`), never through their binary expansion, so `0.1` is exactly one tenth.
 */
export function expectDecimal(raw: unknown, path: string): Parsed<Decimal> {
  let text: string;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return fail(path, "must be finite");
    text = String(raw);
  } else if (typeof raw === "string") {
    text = raw.trim();
  } else if (typeof raw === "bigint") {
    text = raw.toString();
  } else {
    return fail(path, `expected a number, got ${typeName(raw)}`);
  }
  if (NON_FINITE_PATTERN.test(text)) return fail(path, "must be finite");
  const match = DECIMAL_PATTERN.exec(text);
  const whole = match?.[2] ?? "";
  const fraction = match?.[3] ?? "";
  if (match === null || (whole === "" && fraction === "")) {
    return fail(path, "is not a valid decimal number");
  }
  const exponent = match[4] === undefined ? 0 : Number(match[4]);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1000) {
    return fail(path, "is out of range");
  }
  let units = BigInt((whole + fraction).replace(/^0+(?=\d)/, "") || "0");
  if (match[1] === "-") units = -units;
  let scale = fraction.length - exponent;
  if (scale < 0) {
    units *= 10n ** BigInt(-scale);
    scale = 0;
  }
  return ok({ units, scale });
}

/** Divide with round-half-even (Python's default `Decimal` rounding). */
export function divRoundHalfEven(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new RangeError("denominator must be positive");
  const negative = numerator < 0n;
  const n = negative ? -numerator : numerator;
  let quotient = n / denominator;
  const twice = (n % denominator) * 2n;
  if (twice > denominator || (twice === denominator && quotient % 2n === 1n)) quotient += 1n;
  return negative ? -quotient : quotient;
}

/** Rescale a decimal to `targetScale` fractional digits (round-half-even), returning the units. */
export function decimalToScale(value: Decimal, targetScale: number): bigint {
  if (value.scale <= targetScale) return value.units * 10n ** BigInt(targetScale - value.scale);
  return divRoundHalfEven(value.units, 10n ** BigInt(value.scale - targetScale));
}
