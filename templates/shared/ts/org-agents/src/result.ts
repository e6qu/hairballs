/**
 * Result: expected outcomes as values. Parsers return `Result<T, ParseError>` instead of throwing.
 */

export type Ok<T> = { readonly kind: "ok"; readonly value: T };
export type Err<E> = { readonly kind: "err"; readonly error: E };
export type Result<T, E> = Ok<T> | Err<E>;

export function ok<T>(value: T): Ok<T> {
  return { kind: "ok", value };
}

export function err<E>(error: E): Err<E> {
  return { kind: "err", error };
}

export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.kind === "ok";
}

export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return result.kind === "err";
}

export function map<T, U, E>(result: Result<T, E>, f: (value: T) => U): Result<U, E> {
  return result.kind === "ok" ? ok(f(result.value)) : result;
}

export function mapErr<T, E, F>(result: Result<T, E>, f: (error: E) => F): Result<T, F> {
  return result.kind === "ok" ? result : err(f(result.error));
}

export function andThen<T, U, E>(result: Result<T, E>, f: (value: T) => Result<U, E>): Result<U, E> {
  return result.kind === "ok" ? f(result.value) : result;
}

export function unwrapOr<T, E>(result: Result<T, E>, fallback: T): T {
  return result.kind === "ok" ? result.value : fallback;
}

/**
 * Return the value or throw the error. For trusted inputs (constants, tests) and for shell code
 * that turns a boundary failure into an exception on purpose.
 */
export function unwrap<T, E>(result: Result<T, E>): T {
  if (result.kind === "ok") return result.value;
  throw result.error instanceof Error ? result.error : new Error(String(result.error));
}

/** Parse every item of a list; the first failure wins. */
export function traverse<A, T, E>(
  items: readonly A[],
  f: (item: A, index: number) => Result<T, E>,
): Result<readonly T[], E> {
  const out: T[] = [];
  for (const [index, item] of items.entries()) {
    const r = f(item, index);
    if (r.kind === "err") return r;
    out.push(r.value);
  }
  return ok(out);
}

/** Exhaustiveness check for `switch` over discriminated unions. */
export function assertNever(value: never): never {
  throw new Error(`unreachable: ${JSON.stringify(value)}`);
}
