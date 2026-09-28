// Get an Auth0 access token for a service (client credentials), e.g. a scheduler (shell).
// Usage: AUTH0_CLIENT_ID=... AUTH0_CLIENT_SECRET=... node dist/m2m-token.js
import { type AccessToken, parseTokenResponse } from "./domain.ts";

const AUTH0_DOMAIN = "fintech.eu.auth0.com";
const AUDIENCE = "https://agents.fintech.example";

export async function m2mToken(clientId: string, clientSecret: string): Promise<AccessToken> {
  const response = await fetch(`https://${AUTH0_DOMAIN}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      audience: AUDIENCE,
    }),
  });
  if (!response.ok) throw new Error(`Auth0: ${response.status}`);
  return parseTokenResponse(await response.json()); // outside data -> domain type
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(
    await m2mToken(process.env.AUTH0_CLIENT_ID ?? "", process.env.AUTH0_CLIENT_SECRET ?? ""),
  );
}
