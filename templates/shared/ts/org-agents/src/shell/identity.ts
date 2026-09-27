/**
 * Caller identity (shell): JWT claims from headers, the user directory, and the resolver.
 *
 * AgentCore Runtime has already validated the Auth0 JWT (signature, issuer, audience) before the
 * request reaches the container; here we only decode its claims and parse them into domain types.
 */

import { randomUUID } from "node:crypto";

import { PrincipalId } from "../domain.ts";
import {
  type Caller,
  type ClaimNames,
  type DirectoryEntry,
  EmailAddress,
  humanUser,
  type HumanUser,
  parseClaims,
  PersonName,
  resolveCaller,
  UserId,
} from "../identity.ts";
import { fail, type Parsed } from "../parsing.ts";
import { ok } from "../result.ts";
import type { Env } from "./config.ts";

/** Request headers as Node (`IncomingHttpHeaders`) or a plain record gives them. */
export type HeaderRecord = Readonly<Record<string, string | readonly string[] | undefined>>;

export function headerValue(headers: HeaderRecord | Headers, name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue;
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value[0] as string | undefined;
  }
  return undefined;
}

/** The caller when a request has no token (local development only; see `IdentityResolver`). */
export const LOCAL_USER: HumanUser = humanUser({
  userId: UserId.of("usr_local_dev"),
  subject: PrincipalId.of("local-dev"),
  email: EmailAddress.of("local-dev@example.com"),
  givenName: PersonName.of("Local"),
  familyName: PersonName.of("Developer"),
});

/**
 * The decoded (unverified here, verified upstream) JWT payload of `Authorization: Bearer <jwt>`,
 * or `null` without a bearer token. The scheme is case-insensitive.
 */
export function jwtClaimsFromHeaders(headers: HeaderRecord | Headers): Parsed<unknown> {
  const auth = headerValue(headers, "authorization");
  if (auth === undefined || !auth.toLowerCase().startsWith("bearer ")) return ok(null);
  const parts = auth.slice(7).trim().split(".");
  const payload = parts[1];
  if (parts.length !== 3 || payload === undefined) return fail("$.headers.authorization", "is not a JWT");
  try {
    return ok(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown);
  } catch {
    return fail("$.headers.authorization", "has an undecodable payload");
  }
}

export function newUserId(): UserId {
  return UserId.of(`usr_${randomUUID().replaceAll("-", "")}`);
}

/**
 * What the org remembers per login (Auth0 `sub`). Asynchronous so a shared store (e.g. DynamoDB
 * keyed by `sub`) can implement it.
 */
export interface UserDirectory {
  get(subject: PrincipalId): Promise<DirectoryEntry | null>;
  put(entry: DirectoryEntry): Promise<void>;
}

/**
 * Process-local directory (local runs, tests, one microVM per session). In production use a
 * shared store so the same user id is used across sessions and microVMs, or have the Auth0 Action
 * mint the id (`<ns>user_id` claim), which then always wins. (No SQLite variant here: this
 * library does not use `node:sqlite`, which is still experimental on Node 22.)
 */
export class InMemoryUserDirectory implements UserDirectory {
  readonly #entries = new Map<PrincipalId, DirectoryEntry>();

  async get(subject: PrincipalId): Promise<DirectoryEntry | null> {
    return this.#entries.get(subject) ?? null;
  }

  async put(entry: DirectoryEntry): Promise<void> {
    this.#entries.set(entry.subject, entry);
  }
}

export type IdentityResolverOptions = {
  readonly names: ClaimNames;
  readonly directory: UserDirectory;
  /** Mints a user id for a login seen for the first time (default: `usr_<uuid4 hex>`). */
  readonly mint?: () => UserId;
  /** The caller of requests without a token; `null` refuses them. Default: `LOCAL_USER`. */
  readonly localUser?: Caller | null;
};

export class IdentityResolver {
  readonly #names: ClaimNames;
  readonly #directory: UserDirectory;
  readonly #mint: () => UserId;
  readonly #localUser: Caller | null;

  constructor(options: IdentityResolverOptions) {
    this.#names = options.names;
    this.#directory = options.directory;
    this.#mint = options.mint ?? newUserId;
    this.#localUser = options.localUser === undefined ? LOCAL_USER : options.localUser;
  }

  /**
   * A `ParseError` for malformed claims or a human without an email address. Without a token,
   * the local development user (or an error when `localUser` is `null`).
   */
  async resolve(headers: HeaderRecord | Headers): Promise<Parsed<Caller>> {
    const raw = jwtClaimsFromHeaders(headers);
    if (raw.kind === "err") return raw;
    if (raw.value === null) {
      return this.#localUser === null ? fail("$.headers.authorization", "a bearer token is required") : ok(this.#localUser);
    }
    const claims = parseClaims(raw.value, this.#names);
    if (claims.kind === "err") return claims;
    const known = await this.#directory.get(claims.value.subject);
    const [caller, update] = resolveCaller(claims.value, known, this.#mint());
    if (update !== null) await this.#directory.put(update);
    return ok(caller);
  }
}

/**
 * The resolver a variant uses by default: the configured claim names, a process-local
 * directory, and `REQUIRE_TOKEN=true` to refuse requests without a token (no local user).
 */
export function identityResolverFrom(names: ClaimNames, env: Env, directory: UserDirectory = new InMemoryUserDirectory()): IdentityResolver {
  return new IdentityResolver({ names, directory, ...(env["REQUIRE_TOKEN"] === "true" ? { localUser: null } : {}) });
}
