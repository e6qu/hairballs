/**
 * Who is calling: domain types, claim parsing and user resolution (pure).
 *
 * Two identifiers, two jobs:
 *
 * - `PrincipalId` (the Auth0 `sub`) is the **authorization** key: thread ownership, four-eyes
 *   approval, Cedar policies at the Gateway. It never changes for a login.
 * - `UserId` is the org's **stable business identifier** for a person (tickets, records). It is
 *   accepted from a token claim when present (e.g. minted by the Auth0 post-login Action and kept
 *   in `app_metadata`), otherwise created once and remembered, so a user can change their email
 *   address or name without breaking ownership, approvals or history.
 *
 * Profile data (email, names) is refreshed from every token. Email is required for human users;
 * first and last names are optional. Machine-to-machine callers (`<client_id>@clients`) have no
 * profile. Name and email are PII: they may appear in replies to approvers, tool arguments
 * (ticket requester) and the model's context (first name only), never in audit events.
 *
 * Port of the Python `org_agents.identity`; same semantics and error paths.
 */

import { type Brand, PrincipalId } from "./domain.ts";
import {
  attempt,
  charLength,
  expectNonEmptyString,
  expectObject,
  expectString,
  fail,
  field,
  fieldOr,
  must,
  type Parsed,
  type UnknownRecord,
} from "./parsing.ts";
import { assertNever, ok } from "./result.ts";

const USER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
// Deliberately conservative: one @, no spaces/quotes/angle brackets, a dotted domain with a letter TLD.
const EMAIL_PATTERN = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@(?=.{1,253}$)([A-Za-z0-9-]+\.)+[A-Za-z]{2,63}$/;
const NAME_FORBIDDEN = /[\x00-\x1f\x7f<>{}[\]\\]/;
// The characters Python's `str.split()` treats as whitespace (so names collapse the same way).
const NAME_WHITESPACE = /[\t\n\v\f\r \x1c-\x1f\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/;

export const DEFAULT_CLAIM_NAMESPACE = "https://fintech.example/";

// ---------------------------------------------------------------- value types

/** The org's stable user id: 1-128 of `[A-Za-z0-9._:-]`, starting alphanumeric. */
export type UserId = Brand<string, "UserId">;
export const UserId = {
  is(text: string): text is UserId {
    return USER_ID_PATTERN.test(text);
  },
  of(text: string): UserId {
    if (!UserId.is(text)) throw new RangeError("invalid user id");
    return text;
  },
  parse(raw: unknown, path: string): Parsed<UserId> {
    const text = expectNonEmptyString(raw, path, { maxLength: 128 });
    if (text.kind === "err") return text;
    return UserId.is(text.value) ? ok(text.value) : fail(path, "must be 1-128 of [A-Za-z0-9._:-], starting alphanumeric");
  },
} as const;

/** An email address; the domain part is lower-cased (the local part is kept as given). */
export type EmailAddress = Brand<string, "EmailAddress">;
export const EmailAddress = {
  is(text: string): text is EmailAddress {
    return charLength(text) <= 254 && EMAIL_PATTERN.test(text);
  },
  of(text: string): EmailAddress {
    if (!EmailAddress.is(text)) throw new RangeError("invalid email address");
    return text;
  },
  parse(raw: unknown, path: string): Parsed<EmailAddress> {
    const text = expectNonEmptyString(raw, path, { maxLength: 254 });
    if (text.kind === "err") return text;
    const at = text.value.lastIndexOf("@");
    if (at < 0) return fail(path, "is not a valid email address");
    const candidate = `${text.value.slice(0, at)}@${text.value.slice(at + 1).toLowerCase()}`;
    return EmailAddress.is(candidate) ? ok(candidate) : fail(path, "is not a valid email address");
  },
} as const;

/** A given or family name: 1-100 printable characters, no markup or control characters. */
export type PersonName = Brand<string, "PersonName">;
export const PersonName = {
  is(text: string): text is PersonName {
    const length = charLength(text);
    return length >= 1 && length <= 100 && !NAME_FORBIDDEN.test(text);
  },
  of(text: string): PersonName {
    if (!PersonName.is(text)) throw new RangeError("invalid name");
    return text;
  },
  /** Runs of whitespace collapse to one space. */
  parse(raw: unknown, path: string): Parsed<PersonName> {
    const text = expectNonEmptyString(raw, path, { maxLength: 100 });
    if (text.kind === "err") return text;
    const cleaned = text.value.split(NAME_WHITESPACE).filter((part) => part !== "").join(" ");
    if (NAME_FORBIDDEN.test(cleaned)) return fail(path, "contains characters that are not allowed in a name");
    return PersonName.is(cleaned) ? ok(cleaned) : fail(path, "must not be empty");
  },
} as const;

// ---------------------------------------------------------------- callers

export type HumanUser = {
  readonly kind: "human";
  readonly userId: UserId;
  readonly subject: PrincipalId;
  readonly email: EmailAddress;
  readonly givenName: PersonName | null;
  readonly familyName: PersonName | null;
};

/** A machine-to-machine caller (Auth0 client credentials); `subject` is `<client_id>@clients`. */
export type ServiceClient = { readonly kind: "service"; readonly subject: PrincipalId };

export type Caller = HumanUser | ServiceClient;

export function humanUser(fields: Omit<HumanUser, "kind">): HumanUser {
  return { kind: "human", ...fields };
}

export function serviceClient(subject: PrincipalId): ServiceClient {
  return { kind: "service", subject };
}

/** Given + family name, else the email address; services: `service <sub>`. PII for humans. */
export function displayName(caller: Caller): string {
  switch (caller.kind) {
    case "human": {
      const parts = [caller.givenName, caller.familyName].filter((p): p is PersonName => p !== null);
      return parts.length > 0 ? parts.join(" ") : caller.email;
    }
    case "service":
      return `service ${caller.subject}`;
    default:
      return assertNever(caller);
  }
}

// ---------------------------------------------------------------- claims

/**
 * Which JWT claims carry the profile. Auth0 access tokens need namespaced custom claims added by
 * a post-login Action; ID-token style standard claims (`email`, `given_name`...) are fallbacks.
 */
export type ClaimNames = {
  readonly email: string;
  readonly givenName: string;
  readonly familyName: string;
  readonly userId: string;
};

export const ClaimNames = {
  namespaced(namespace: string): ClaimNames {
    return {
      email: `${namespace}email`,
      givenName: `${namespace}given_name`,
      familyName: `${namespace}family_name`,
      userId: `${namespace}user_id`,
    };
  },
  /** The `[identity]` table of `config/agent.toml`: `claim_namespace` (default `https://fintech.example/`). */
  parse(raw: unknown, path = "$.identity"): Parsed<ClaimNames> {
    return attempt(() => {
      const fields = must(expectObject(raw, path));
      const where = `${path}.claim_namespace`;
      const namespace = must(expectString(fieldOr(fields, "claim_namespace", DEFAULT_CLAIM_NAMESPACE), where));
      if (namespace !== "" && !namespace.startsWith("https://") && !namespace.startsWith("http://")) {
        return must(fail(where, "must be a URL (Auth0 requires namespaced custom claims)"));
      }
      return ClaimNames.namespaced(namespace);
    });
  },
} as const;

export const DEFAULT_CLAIMS: ClaimNames = ClaimNames.namespaced(DEFAULT_CLAIM_NAMESPACE);

export type HumanClaims = {
  readonly kind: "human";
  readonly subject: PrincipalId;
  readonly email: EmailAddress;
  readonly givenName: PersonName | null;
  readonly familyName: PersonName | null;
  /** Present when the IdP already assigns the org user id. */
  readonly userId: UserId | null;
};

export type ServiceClaims = { readonly kind: "service"; readonly subject: PrincipalId };

export type CallerClaims = HumanClaims | ServiceClaims;

/** The first of `names` with a value that is neither null nor the empty string. */
function firstPresent(claims: UnknownRecord, ...names: readonly string[]): readonly [string, unknown] | null {
  for (const name of names) {
    const value = Object.hasOwn(claims, name) ? claims[name] : undefined;
    if (value !== undefined && value !== null && value !== "") return [name, value];
  }
  return null;
}

/** Parse already-validated JWT claims (AgentCore Runtime verified signature, issuer and audience). */
export function parseClaims(raw: unknown, names: ClaimNames): Parsed<CallerClaims> {
  return attempt((): CallerClaims => {
    const claims = must(expectObject(raw, "$.jwt"));
    const subject = must(PrincipalId.parse(must(field(claims, "sub", "$.jwt")), "$.jwt.sub"));
    if (subject.endsWith("@clients") || claims["gty"] === "client-credentials") return { kind: "service", subject };

    const email = firstPresent(claims, names.email, "email");
    if (email === null) {
      return must(fail(`$.jwt.${names.email}`, "is required for human users (add it in the Auth0 Action)"));
    }
    const given = firstPresent(claims, names.givenName, "given_name");
    const family = firstPresent(claims, names.familyName, "family_name");
    const userId = firstPresent(claims, names.userId);
    return {
      kind: "human",
      subject,
      email: must(EmailAddress.parse(email[1], `$.jwt.${email[0]}`)),
      givenName: given === null ? null : must(PersonName.parse(given[1], `$.jwt.${given[0]}`)),
      familyName: family === null ? null : must(PersonName.parse(family[1], `$.jwt.${family[0]}`)),
      userId: userId === null ? null : must(UserId.parse(userId[1], `$.jwt.${userId[0]}`)),
    };
  });
}

// ---------------------------------------------------------------- resolution

/** What the org remembers about a login: its stable user id and last-seen profile. */
export type DirectoryEntry = {
  readonly subject: PrincipalId;
  readonly userId: UserId;
  readonly email: EmailAddress;
  readonly givenName: PersonName | null;
  readonly familyName: PersonName | null;
};

function sameEntry(a: DirectoryEntry, b: DirectoryEntry | null): boolean {
  return (
    b !== null &&
    a.subject === b.subject &&
    a.userId === b.userId &&
    a.email === b.email &&
    a.givenName === b.givenName &&
    a.familyName === b.familyName
  );
}

/**
 * Decide the caller and the directory entry to store (`null` = nothing to write).
 *
 * User id precedence: token claim > remembered id > newly `minted` id (supplied by the shell,
 * which owns randomness). The profile always comes from the latest token, so email and name
 * changes are picked up while the user id stays the same.
 */
export function resolveCaller(
  claims: CallerClaims,
  known: DirectoryEntry | null,
  minted: UserId,
): readonly [Caller, DirectoryEntry | null] {
  switch (claims.kind) {
    case "service":
      return [serviceClient(claims.subject), null];
    case "human": {
      const { subject, email, givenName, familyName } = claims;
      const userId = claims.userId ?? known?.userId ?? minted;
      const entry: DirectoryEntry = { subject, userId, email, givenName, familyName };
      return [humanUser(entry), sameEntry(entry, known) ? null : entry];
    }
    default:
      return assertNever(claims);
  }
}

/**
 * Context for the model at the start of a thread (and when the speaker changes). Only the first
 * name is shared with the model, and never in the system prompt, so the prompt cache stays shared
 * across users. `null` when there is nothing to say (no given name, or a service).
 */
export function firstPromptPreamble(caller: Caller): string | null {
  return caller.kind === "human" && caller.givenName !== null ? `[Context: you are assisting ${caller.givenName}.]` : null;
}
