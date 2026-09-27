// Who is calling: the claims of the caller's Auth0 access token.
const NS = "https://fintech.example/"; // the claim namespace set by the Auth0 post-login Action

export interface Caller {
  subject: string; // Auth0 `sub`: who signed in; use it for authorization and audit
  userId: string | undefined; // our stable user id; undefined for services
  firstName: string | undefined;
}

/** Decode the token's payload. Runtime has already checked signature, issuer and audience. */
export function claimsOf(authorization: string): Record<string, unknown> {
  const payload = authorization.replace(/^Bearer /, "").split(".")[1]!;
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
}

export function callerOf(authorization: string): Caller {
  const claims = claimsOf(authorization);
  const subject = String(claims.sub);
  if (subject.endsWith("@clients")) {
    // an M2M (client credentials) token: a service, no profile
    return { subject, userId: undefined, firstName: undefined };
  }
  const firstName = claims[`${NS}given_name`];
  return {
    subject,
    userId: String(claims[`${NS}user_id`]),
    firstName: firstName ? String(firstName) : undefined,
  };
}
