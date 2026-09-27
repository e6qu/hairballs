// Get an Auth0 access token for a service (client credentials), e.g. a scheduler.
const AUTH0_DOMAIN = "fintech.eu.auth0.com";
const AUDIENCE = "https://agents.fintech.example";

export async function m2mToken(): Promise<string> {
  const response = await fetch(`https://${AUTH0_DOMAIN}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: process.env.AUTH0_CLIENT_ID,
      client_secret: process.env.AUTH0_CLIENT_SECRET,
      audience: AUDIENCE,
    }),
  });
  if (!response.ok) throw new Error(`Auth0: ${response.status}`);
  const body = (await response.json()) as { access_token: string };
  return body.access_token;
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(await m2mToken());
