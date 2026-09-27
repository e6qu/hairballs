# 06. Auth0 identity

You will: let only Auth0-authenticated users and services call the helpdesk, read who is calling inside the agent, and let the agent call an API with a token it never stores. You need: [04. Your own code](04-your-own-code.md) deployed, and an Auth0 tenant where you can create APIs, applications and Actions. Cost: nothing extra on AWS (Identity is free through Runtime); Auth0 depends on your plan.

Full source: [`examples/06-auth0-identity/`](examples/06-auth0-identity/). The Auth0 background is in [`AGENT_IDENTITY_AUTH0.md`](../../AGENT_IDENTITY_AUTH0.md).

## Step 1: Set up Auth0

In the Auth0 dashboard of `fintech.eu.auth0.com`, create:

1. **An API for the agents.** *Applications > APIs > Create API*: name `Agents`, identifier `https://agents.fintech.example`, signing algorithm RS256. The identifier is the **audience** every caller asks a token for.
2. **An API for the tickets system** the agent calls: identifier `https://tickets.fintech.example`, with a scope `tickets:write`.
3. **An application for people.** A *Single Page Application* (or a *Regular Web Application* for a server-side portal). Users sign in with Authorization Code + PKCE and ask for the audience `https://agents.fintech.example`.
4. **An application per service** that calls the agent, for example `agent-scheduler`: *Machine to Machine*, authorized for the `Agents` API. Its tokens have `sub = <client id>@clients`.
5. **An application for the agent itself**, `helpdesk-agent`: *Machine to Machine*, authorized for the `Tickets` API with `tickets:write`. Step 6 puts its secret in the AgentCore token vault.

Access tokens carry no email or name by default. This post-login Action adds them as namespaced claims and gives each user a stable id (*Actions > Library > Build Custom*, then add it to the *Login* flow):

```javascript
// Auth0 post-login Action: profile claims for agent APIs (Actions > Library > Build Custom).
const NS = "https://fintech.example/";

exports.onExecutePostLogin = async (event, api) => {
  if (!event.user.email || !event.user.email_verified) {
    api.access.deny("a verified email address is required");
    return;
  }
  let userId = event.user.app_metadata?.user_id;
  if (!userId) {
    userId = `usr_${require("crypto").randomUUID().replaceAll("-", "")}`;
    api.user.setAppMetadata("user_id", userId); // minted once; survives email and name changes
  }
  api.accessToken.setCustomClaim(`${NS}user_id`, userId);
  api.accessToken.setCustomClaim(`${NS}email`, event.user.email);
  if (event.user.given_name) api.accessToken.setCustomClaim(`${NS}given_name`, event.user.given_name);
  if (event.user.family_name) api.accessToken.setCustomClaim(`${NS}family_name`, event.user.family_name);
};
```

## Step 2: Put a JWT authorizer on the runtime

Runtime checks every call's token before your code runs: the signature (keys from the discovery URL), the issuer, the expiry and the audience. With the header allowlist it also passes the token on to your code.

Check the **audience**, not the client. Auth0 puts the client id in `azp`, not in `client_id`, so AgentCore's `allowedClients` never matches an Auth0 token.

<table><tr><th><code>agentcore</code> CLI</th><th>AWS CLI (<code>cli.sh</code>)</th><th>Terraform (<code>terraform/main.tf</code>)</th></tr><tr><td>

Add to the runtime in `agentcore/agentcore.json`:

```json
"authorizerType": "CUSTOM_JWT",
"authorizerConfiguration": {
  "customJwtAuthorizer": {
    "discoveryUrl": "https://fintech.eu.auth0.com/.well-known/openid-configuration",
    "allowedAudience": ["https://agents.fintech.example"]
  }
},
"requestHeaderAllowlist": ["Authorization"]
```

```bash
agentcore validate
agentcore deploy
```

For a new agent, `agentcore add agent` takes `--authorizer-type CUSTOM_JWT --discovery-url ... --allowed-audience ... --request-header-allowlist Authorization`.

</td><td>

```bash
AUTHORIZER=$(cat <<EOF
{"customJWTAuthorizer": {
  "discoveryUrl": "https://$AUTH0_DOMAIN/.well-known/openid-configuration",
  "allowedAudience": ["$AUDIENCE"]}}
EOF
)
AGENT_ARN=$(aws bedrock-agentcore-control update-agent-runtime \
  --agent-runtime-id "$AGENT_ID" \
  --role-arn "arn:aws:iam::$ACCOUNT_ID:role/$ROLE_NAME" \
  --agent-runtime-artifact "$ARTIFACT" \
  --network-configuration '{"networkMode": "PUBLIC"}' \
  --authorizer-configuration "$AUTHORIZER" \
  --request-header-configuration '{"requestHeaderAllowlist": ["Authorization"]}' \
  --query agentRuntimeArn --output text)
```

</td><td>

```hcl
  # Only callers with a valid Auth0 token for the agents API get in.
  authorizer_configuration {
    custom_jwt_authorizer {
      discovery_url    = "https://fintech.eu.auth0.com/.well-known/openid-configuration"
      allowed_audience = ["https://agents.fintech.example"]
    }
  }

  # Pass the (already validated) token on to the agent code.
  request_header_configuration {
    request_header_allowlist = ["Authorization"]
  }
```

These blocks go in `aws_bedrockagentcore_agent_runtime.helpdesk`; the folder is the complete stack.

</td></tr></table>

**Terraform:** [`aws_bedrockagentcore_agent_runtime.helpdesk`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/bedrockagentcore_agent_runtime)

- A runtime accepts **either** IAM (SigV4) **or** JWT callers, not both. After this change, `invoke.py` from tutorial 04 (IAM) is refused.
- You can also require scopes (`allowedScopes`) or claim values (`customClaims`); all configured checks must pass.
- A harness takes the same authorizer: `--authorizer-type CUSTOM_JWT --discovery-url ... --allowed-audience ...` on `agentcore add harness`, or `authorizer_configuration` on [`aws_bedrockagentcore_harness`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/bedrockagentcore_harness).

## Step 3: Read the caller in the agent

The token arrives in the `Authorization` header. Runtime has already verified it, so the agent only decodes the payload. A token whose `sub` ends in `@clients` is a service; anything else is a person with the claims from the Action.

<table><tr><th>Python (<code>python/identity.py</code>)</th><th>TypeScript (<code>typescript/identity.ts</code>)</th></tr><tr><td>

```python
def claims_of(authorization: str) -> dict[str, object]:
    """Decode the token's payload. Runtime has already checked signature, issuer and audience."""
    payload = authorization.removeprefix("Bearer ").split(".")[1]
    claims: dict[str, object] = json.loads(base64.urlsafe_b64decode(payload + "=="))
    return claims


def caller_of(authorization: str) -> Caller:
    claims = claims_of(authorization)
    subject = str(claims["sub"])
    if subject.endswith("@clients"):  # an M2M (client credentials) token: a service, no profile
        return Caller(subject, None, None)
    first_name = claims.get(f"{NS}given_name")
    return Caller(
        subject,
        str(claims[f"{NS}user_id"]),
        str(first_name) if first_name else None,
    )
```

</td><td>

```typescript
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
```

</td></tr></table>

The entrypoint uses the caller three ways:

- it ties each session to the user who started it, because Runtime doesn't;
- it puts the user's first name in the first message, not the system prompt, so the prompt cache stays shared (tutorial 05);
- the ticket tool takes the requester from the token, never from the model.

<table><tr><th>Python (<code>python/main.py</code>)</th><th>TypeScript (<code>typescript/main.ts</code>)</th></tr><tr><td>

```python
headers = context.request_headers or {}
caller = caller_of(headers["Authorization"])  # forwarded because it is on the allowlist
session_id = context.session_id or "local"
prompt = payload["prompt"]
if session_id not in agents:
    agents[session_id] = (caller.subject, new_agent(caller))
    if caller.first_name:  # per-user details go in the first message, not the system prompt
        prompt = f"[Context: you are assisting {caller.first_name}.]\n\n{prompt}"
owner, agent = agents[session_id]
if owner != caller.subject:  # Runtime doesn't tie sessions to users; the agent does
    raise PermissionError("this session belongs to another user")
```

</td><td>

```typescript
const caller = callerOf(context.headers["authorization"] ?? ""); // on the allowlist
const sessionId = context.sessionId || "local";
let prompt = payload.prompt;
if (!agents.has(sessionId)) {
  agents.set(sessionId, { owner: caller.subject, agent: newAgent(caller) });
  if (caller.firstName) {
    // per-user details go in the first message, not the system prompt
    prompt = `[Context: you are assisting ${caller.firstName}.]\n\n${prompt}`;
  }
}
const { owner, agent } = agents.get(sessionId)!;
if (owner !== caller.subject) {
  // Runtime doesn't tie sessions to users; the agent does
  throw new Error("this session belongs to another user");
}
```

</td></tr></table>

**Terraform:** [`aws_bedrockagentcore_agent_runtime.helpdesk`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/bedrockagentcore_agent_runtime) (`request_header_configuration` forwards the token)

Use `user_id` (not `sub`, and never the email) as the Memory actor id from tutorial 05. Auth0 subjects such as `auth0|6512…` contain `|`, which actor ids don't allow.

## Step 4: Get a token

**People** get their token in the browser: the Auth0 SPA SDK's `getTokenSilently({ authorizationParams: { audience: "https://agents.fintech.example" } })` after login.

**Services** use the client-credentials grant with their own M2M application (here `agent-scheduler`):

<table><tr><th>Python (<code>python/m2m_token.py</code>)</th><th>TypeScript (<code>typescript/m2m-token.ts</code>)</th></tr><tr><td>

```python
def m2m_token() -> str:
    response = httpx.post(
        f"https://{AUTH0_DOMAIN}/oauth/token",
        json={
            "grant_type": "client_credentials",
            "client_id": os.environ["AUTH0_CLIENT_ID"],
            "client_secret": os.environ["AUTH0_CLIENT_SECRET"],
            "audience": AUDIENCE,
        },
        timeout=30,
    )
    response.raise_for_status()
    token: str = response.json()["access_token"]
    return token
```

</td><td>

```typescript
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
```

</td></tr></table>

## Step 5: Call the agent with the token

The AWS SDKs sign requests with IAM and can't send a bearer token, so callers use plain HTTPS:

- `POST https://bedrock-agentcore.eu-west-1.amazonaws.com/runtimes/<URL-encoded runtime ARN>/invocations?qualifier=DEFAULT`
- `Authorization: Bearer <Auth0 access token>`
- `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id: <session id>` (at least 33 characters)

<table><tr><th>Python (<code>python/invoke_jwt.py</code>)</th><th>TypeScript (<code>typescript/invoke-jwt.ts</code>)</th></tr><tr><td>

```python
URL = (
    "https://bedrock-agentcore.eu-west-1.amazonaws.com/runtimes/"
    f"{quote(AGENT_ARN, safe='')}/invocations?qualifier=DEFAULT"
)


def ask(token: str, prompt: str, session_id: str) -> None:
    headers = {
        "Authorization": f"Bearer {token}",
        "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id": session_id,
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
    }
    with httpx.stream(
        "POST", URL, headers=headers, json={"prompt": prompt}, timeout=300
    ) as response:
        response.raise_for_status()
        for line in response.iter_lines():  # server-sent events: 'data: "..."'
            if line.startswith("data: "):
                print(json.loads(line[6:]), end="", flush=True)
    print()
```

</td><td>

```typescript
const URL =
  "https://bedrock-agentcore.eu-west-1.amazonaws.com/runtimes/" +
  `${encodeURIComponent(AGENT_ARN)}/invocations?qualifier=DEFAULT`;

async function ask(token: string, prompt: string, sessionId: string): Promise<void> {
  const response = await fetch(URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id": sessionId,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify({ prompt }),
  });
  if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  ...
}
```

</td></tr></table>

From the command line:

<table><tr><th><code>agentcore</code> CLI</th><th>AWS CLI</th><th>Terraform</th></tr><tr><td>

```bash
agentcore invoke \
  --bearer-token "$TOKEN" \
  "How much can I claim for meals?"
```

</td><td>

The AWS CLI signs with IAM and can't send a bearer token. `cli.sh` uses `curl` with the same URL and headers as the code above.

</td><td>

Terraform doesn't invoke. JWT callers need no IAM permissions.

</td></tr></table>

```bash
cd examples/06-auth0-identity/python
export AGENT_ARN=arn:aws:bedrock-agentcore:eu-west-1:111122223333:runtime/helpdesk_code-...
export AUTH0_CLIENT_ID=<agent-scheduler client id> AUTH0_CLIENT_SECRET=<its secret>
TOKEN=$(uv run python m2m_token.py) uv run python invoke_jwt.py "How much can I claim for meals?"
```

**Terraform:** [`aws_bedrockagentcore_agent_runtime.helpdesk`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/bedrockagentcore_agent_runtime)

Without a token the call gets `401` with a `WWW-Authenticate` header that points to the runtime's OAuth metadata.

## Step 6: Call an API with a token from the token vault

The agent has its own identity (a **workload identity**, created with the runtime). It gets downstream tokens from the **token vault** through a **credential provider**, so the client secret lives in AWS, not in the agent. Runtime hands the agent a workload access token with each call; the SDK exchanges it for the API token. The AWS CLI and Terraform can use AgentCore's built-in `Auth0Oauth2` vendor.

<table><tr><th><code>agentcore</code> CLI</th><th>AWS CLI (<code>cli.sh</code>)</th><th>Terraform (<code>terraform/main.tf</code>)</th></tr><tr><td>

```bash
agentcore add credential \
  --type oauth \
  --name auth0-tickets \
  --discovery-url https://fintech.eu.auth0.com/.well-known/openid-configuration \
  --client-id "$AGENT_CLIENT_ID" \
  --client-secret "$AGENT_CLIENT_SECRET" \
  --scopes tickets:write
agentcore deploy
```

The CLI creates a generic (`CustomOauth2`) provider from the discovery URL, and grants the agent's role access to it.

</td><td>

```bash
PROVIDER_CONFIG=$(cat <<EOF
{"includedOauth2ProviderConfig": {
  "clientId": "$AGENT_CLIENT_ID", "clientSecret": "$AGENT_CLIENT_SECRET",
  "issuer": "https://$AUTH0_DOMAIN/",
  "authorizationEndpoint": "https://$AUTH0_DOMAIN/authorize",
  "tokenEndpoint": "https://$AUTH0_DOMAIN/oauth/token"}}
EOF
)
SECRET_ARN=$(aws bedrock-agentcore-control create-oauth2-credential-provider \
  --name auth0-tickets \
  --credential-provider-vendor Auth0Oauth2 \
  --oauth2-provider-config-input "$PROVIDER_CONFIG" \
  --query clientSecretArn.secretArn --output text)

aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name helpdesk-tokens --policy-document "$TOKENS_POLICY"
```

</td><td>

```hcl
resource "aws_bedrockagentcore_oauth2_credential_provider" "auth0_tickets" {
  name                       = "auth0-tickets"
  credential_provider_vendor = "Auth0Oauth2"

  oauth2_provider_config {
    included_oauth2_provider_config {
      client_id_wo                  = var.auth0_client_id
      client_secret_wo              = var.auth0_client_secret
      client_credentials_wo_version = 1 # bump to push a new secret
      issuer                        = "https://fintech.eu.auth0.com/"
      authorization_endpoint        = "https://fintech.eu.auth0.com/authorize"
      token_endpoint                = "https://fintech.eu.auth0.com/oauth/token"
    }
  }
}
```

</td></tr></table>

**Terraform:** [`aws_bedrockagentcore_oauth2_credential_provider.auth0_tickets`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/bedrockagentcore_oauth2_credential_provider), [`aws_iam_role_policy.helpdesk_tokens`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/iam_role_policy)

- The agent's role needs `bedrock-agentcore:GetResourceOauth2Token` on the workload identity directory and the token vault, and `secretsmanager:GetSecretValue` on the provider's secret. `cli.sh` and `main.tf` grant exactly that; the `agentcore` CLI does it for you.
- Auth0's issuer ends with `/`; AWS's Auth0 example omits it. **[verify]** which one the provider accepts.
- The `_wo` (write-only) arguments keep the Auth0 credentials out of the Terraform state.
- For flows where the user signs in to the downstream app, register the provider's `callbackUrl` in the Auth0 application.

In the code, a wrapper fetches the token just before use. Auth0 needs the API's `audience`, passed as a custom parameter, as in AWS's Auth0 M2M sample.

<table><tr><th>Python (<code>python/tickets.py</code>)</th><th>TypeScript (<code>typescript/tickets.ts</code>)</th></tr><tr><td>

```python
@requires_access_token(
    provider_name="auth0-tickets",  # the credential provider in the token vault
    auth_flow="M2M",  # client credentials: the agent acts as itself
    scopes=["tickets:write"],
    custom_parameters={"audience": TICKETS_API},  # Auth0 needs the API's audience
)
async def tickets_token(*, access_token: str) -> str:
    return access_token  # injected by the decorator; the agent never holds a client secret


async def open_ticket(title: str, description: str, requester_id: str) -> str:
    token = await tickets_token()
    async with httpx.AsyncClient(timeout=30) as http:
        response = await http.post(
            f"{TICKETS_API}/tickets",
            json={"title": title, "description": description, "requester_id": requester_id},
            headers={"Authorization": f"Bearer {token}"},
        )
```

</td><td>

```typescript
const ticketsToken = withAccessToken({
  providerName: "auth0-tickets", // the credential provider in the token vault
  authFlow: "M2M", // client credentials: the agent acts as itself
  scopes: ["tickets:write"],
  customParameters: { audience: TICKETS_API }, // Auth0 needs the API's audience
})(async (accessToken: string) => accessToken); // the agent never holds a client secret
...
  const token = await ticketsToken();
  const response = await fetch(`${TICKETS_API}/tickets`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ title, description, requester_id: requesterId }),
  });
```

</td></tr></table>

**Terraform:** [`aws_bedrockagentcore_oauth2_credential_provider.auth0_tickets`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/bedrockagentcore_oauth2_credential_provider), [`aws_iam_role_policy.helpdesk_tokens`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/iam_role_policy)

- Running locally, the Python decorator creates a local workload identity for you. The TypeScript wrapper needs the workload access token that Runtime sends, so it works only on Runtime. Both need `AWS_REGION`.
- To act **as the user** instead (the tickets API sees Alice, not the agent), use `ON_BEHALF_OF_TOKEN_EXCHANGE` with a `CustomOauth2` provider. **[verify]** that your Auth0 tenant has token exchange enabled; see [`AGENT_IDENTITY_AUTH0.md`](../../AGENT_IDENTITY_AUTH0.md).

## What just happened

- Runtime rejected every call without a valid Auth0 token for `https://agents.fintech.example`, and passed valid tokens to the agent.
- The agent read the caller from the token: it owns the session, its first name goes in the first message, its user id goes on tickets.
- The agent called the tickets API with a token from the vault, using its own identity; no secret ever reached its code.

## Clean up

```bash
./examples/06-auth0-identity/cli.sh cleanup                        # the provider and the role policy
./examples/04-your-own-code/cli.sh cleanup                         # the runtime
terraform -chdir=examples/06-auth0-identity/terraform destroy      # the Terraform version
```

In Auth0, delete the two APIs, the applications and the Action if you don't need them.

Next: [07. Policy](07-policy.md)
