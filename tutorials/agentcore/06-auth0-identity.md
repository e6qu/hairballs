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

The token arrives in the `Authorization` header. Runtime has already verified it, so the agent only decodes the payload and parses the claims into a domain type.

The code has three parts, as in [tutorial 01](01-first-agent.md):

- **`domain`**: `Subject`, `UserId` (`usr_` + 32 hex digits, the id the Action mints), `EmailAddress`, `SessionId`, `Prompt`, `TicketRequest`, `AccessToken`, and a `Caller` union: a `HumanUser` (who must have a user id and an email) or a `ServiceClient` (an M2M token, with no profile). Parsers build them from the JWT claims, the request, the model's tool arguments and the Auth0 and tickets API replies.
- **`core`**: pure decisions over those types: who owns a session, what the first message says, who a ticket is for, the request body for the tickets API, the invocation URL.
- **shell** (`main`, `tickets`, `m2m_token`, `invoke_jwt`): the Runtime entrypoint, the tool, and the HTTP calls.

A caller is one or the other, never "a person with no email":

<table><tr><th>Python (<code>python/domain.py</code>)</th><th>TypeScript (<code>typescript/domain.ts</code>)</th></tr><tr><td>

```python
@dataclass(frozen=True, slots=True)
class HumanUser:
    subject: Subject
    user_id: UserId
    email: EmailAddress
    first_name: str | None


@dataclass(frozen=True, slots=True)
class ServiceClient:
    """An M2M (client credentials) caller: a service, with no profile."""

    subject: Subject


Caller = HumanUser | ServiceClient
```

</td><td>

```typescript
export type Caller =
  | {
      readonly kind: "human";
      readonly subject: Subject;
      readonly userId: UserId;
      readonly email: EmailAddress;
      readonly firstName: string | undefined;
    }
  | { readonly kind: "service"; readonly subject: Subject }; // M2M: a service, no profile
```

</td></tr></table>

The boundary parser: a token whose `sub` ends in `@clients` (or whose `gty` is `client-credentials`) is a service; anything else must be a person with the claims from the Action.

<table><tr><th>Python</th><th>TypeScript</th></tr><tr><td>

```python
def parse_caller(claims: Mapping[str, object]) -> Caller:
    subject = Subject(_text(claims.get("sub"), "$jwt.sub"))
    if subject.value.endswith("@clients") or claims.get("gty") == "client-credentials":
        return ServiceClient(subject)
    first_name = claims.get(f"{NS}given_name")
    return HumanUser(
        subject,
        UserId.parse(claims.get(f"{NS}user_id")),
        EmailAddress.parse(claims.get(f"{NS}email")),
        first_name if isinstance(first_name, str) and first_name.strip() else None,
    )
```

</td><td>

```typescript
export function parseCaller(claims: Record<string, unknown>): Caller {
  const subject = text(claims["sub"], "$jwt.sub") as Subject;
  if (subject.endsWith("@clients") || claims["gty"] === "client-credentials") {
    return { kind: "service", subject };
  }
  const userId = claims[`${NS}user_id`];
  if (typeof userId !== "string" || !USER_ID.test(userId)) throw new ParseError("no user id");
  const email = claims[`${NS}email`];
  if (typeof email !== "string" || !EMAIL.test(email)) {
    throw new ParseError("a person's token must carry an email address");
  }
  const firstName = claims[`${NS}given_name`];
  return {
    kind: "human",
    subject,
    userId: userId as UserId,
    email: email as EmailAddress,
    firstName: typeof firstName === "string" && firstName.trim() ? firstName : undefined,
  };
}
```

</td></tr></table>

The entrypoint (shell) parses the caller, the session and the body, then lets the core decide:

<table><tr><th>Python (<code>python/main.py</code>)</th><th>TypeScript (<code>typescript/main.ts</code>)</th></tr><tr><td>

```python
@app.entrypoint
async def invoke(payload: object, context: RequestContext) -> AsyncIterator[str]:
    headers = context.request_headers or {}
    caller = parse_caller(claims_of(headers.get("Authorization")))  # on the header allowlist
    session = SessionId.parse(context.session_id)
    prompt = parse_invocation(payload)
    if session not in agents:
        agents[session] = (caller.subject, new_agent(caller))
        text = first_message(caller, prompt)
    else:
        text = prompt.text
    owner, agent = agents[session]
    if not owns(owner, caller):
        raise PermissionError("this session belongs to another caller")
    async for event in agent.stream_async(text):
        data = event.get("data")
        if isinstance(data, str):
            yield data
```

</td><td>

```typescript
    async *process(payload, context) {
      const caller = parseCaller(claimsOf(context.headers["authorization"])); // on the allowlist
      const session = parseSessionId(context.sessionId);
      const prompt = parseInvocation(payload);
      let text: string = prompt;
      if (!agents.has(session)) {
        agents.set(session, { owner: caller.subject, agent: newAgent(caller) });
        text = firstMessage(caller, prompt);
      }
      const { owner, agent } = agents.get(session)!;
      if (!owns(owner, caller)) throw new Error("this session belongs to another caller");
      for await (const event of agent.stream(text)) {
        ...
```

</td></tr></table>

<table><tr><th>Python (<code>python/core.py</code>)</th><th>TypeScript (<code>typescript/core.ts</code>)</th></tr><tr><td>

```python
def owns(owner: Subject, caller: Caller) -> bool:
    """Runtime doesn't tie sessions to users, so the agent does: only the starter may continue."""
    return caller.subject == owner


def first_message(caller: Caller, prompt: Prompt) -> str:
    """Per-user details go in the first message, never in the system prompt (keeps the cache)."""
    match caller:
        case HumanUser(first_name=str(name)):
            return f"[Context: you are assisting {name}.]\n\n{prompt.text}"
        case _:
            return prompt.text
```

</td><td>

```typescript
// Runtime doesn't tie sessions to users, so the agent does: only the starter may continue.
export const owns = (owner: Subject, caller: Caller): boolean => caller.subject === owner;

// Per-user details go in the first message, never in the system prompt (keeps the cache).
export function firstMessage(caller: Caller, prompt: Prompt): string {
  return caller.kind === "human" && caller.firstName
    ? `[Context: you are assisting ${caller.firstName}.]\n\n${prompt}`
    : prompt;
}
```

</td></tr></table>

- The session belongs to the caller who started it, because Runtime doesn't tie sessions to users.
- The user's first name goes in the first message, not the system prompt, so the prompt cache stays shared (tutorial 05).
- The ticket tool takes the requester from the parsed caller, never from the model.

**Terraform:** [`aws_bedrockagentcore_agent_runtime.helpdesk`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/bedrockagentcore_agent_runtime) (`request_header_configuration` forwards the token)

Use the `UserId` (not `sub`, and never the email) as the Memory actor id from tutorial 05. Auth0 subjects such as `auth0|6512…` contain `|`, which actor ids don't allow; a `UserId` always fits.

## Step 4: Get a token

**People** get their token in the browser: the Auth0 SPA SDK's `getTokenSilently({ authorizationParams: { audience: "https://agents.fintech.example" } })` after login.

**Services** use the client-credentials grant with their own M2M application (here `agent-scheduler`):

<table><tr><th>Python (<code>python/m2m_token.py</code>)</th><th>TypeScript (<code>typescript/m2m-token.ts</code>)</th></tr><tr><td>

```python
def m2m_token(client_id: str, client_secret: str) -> AccessToken:
    response = httpx.post(
        f"https://{AUTH0_DOMAIN}/oauth/token",
        json={
            "grant_type": "client_credentials",
            "client_id": client_id,
            "client_secret": client_secret,
            "audience": AUDIENCE,
        },
        timeout=30,
    )
    response.raise_for_status()
    return parse_token_response(response.json())  # outside data -> domain type
```

</td><td>

```typescript
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
```

</td></tr></table>

The reply is parsed into an `AccessToken` (a JWT) at the boundary:

<table><tr><th>Python (<code>python/domain.py</code>)</th><th>TypeScript (<code>typescript/domain.ts</code>)</th></tr><tr><td>

```python
def parse_token_response(raw: object) -> AccessToken:
    """Auth0's /oauth/token reply: {"access_token": "...", ...}."""
    return AccessToken.parse(_fields(raw, "$").get("access_token"))
```

</td><td>

```typescript
export function parseAccessToken(raw: unknown): AccessToken {
  const token = text(raw, "access token");
  if (token.split(".").length !== 3) throw new ParseError("an access token must be a JWT");
  return token as AccessToken;
}

// Auth0's /oauth/token reply: {"access_token": "...", ...}.
export const parseTokenResponse = (raw: unknown): AccessToken =>
  parseAccessToken(fields(raw, "$")["access_token"]);
```

</td></tr></table>

## Step 5: Call the agent with the token

The AWS SDKs sign requests with IAM and can't send a bearer token, so callers use plain HTTPS:

- `POST https://bedrock-agentcore.eu-west-1.amazonaws.com/runtimes/<URL-encoded runtime ARN>/invocations?qualifier=DEFAULT`
- `Authorization: Bearer <Auth0 access token>`
- `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id: <session id>` (at least 33 characters)

<table><tr><th>Python (<code>python/invoke_jwt.py</code>)</th><th>TypeScript (<code>typescript/invoke-jwt.ts</code>)</th></tr><tr><td>

```python
def ask(agent: AgentRuntimeArn, token: AccessToken, session: SessionId, prompt: Prompt) -> None:
    headers = {
        "Authorization": f"Bearer {token.value}",
        "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id": session.value,
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
    }
    url = invocation_url(agent, "eu-west-1")
    with httpx.stream("POST", url, headers=headers, json={"prompt": prompt.text}, timeout=300) as r:
        r.raise_for_status()
        for line in r.iter_lines():
            event = parse_sse_line(line)  # outside data -> domain type, right here
            if event is not None:
                print(render(event), end="", flush=True)
    print()
```

</td><td>

```typescript
async function ask(
  agent: AgentRuntimeArn,
  token: AccessToken,
  session: SessionId,
  prompt: Prompt,
): Promise<void> {
  const response = await fetch(invocationUrl(agent, "eu-west-1"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id": session,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify({ prompt }),
  });
  if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
  ...
```

</td></tr></table>

The URL comes from the core; the server-sent events are parsed as in tutorial 04:

<table><tr><th>Python (<code>python/core.py</code>)</th><th>TypeScript (<code>typescript/core.ts</code>)</th></tr><tr><td>

```python
def invocation_url(agent: AgentRuntimeArn, region: str) -> str:
    return (
        f"https://bedrock-agentcore.{region}.amazonaws.com/runtimes/"
        f"{quote(agent.value, safe='')}/invocations?qualifier=DEFAULT"
    )
```

</td><td>

```typescript
export function invocationUrl(agent: AgentRuntimeArn, region: string): string {
  return (
    `https://bedrock-agentcore.${region}.amazonaws.com/runtimes/` +
    `${encodeURIComponent(agent)}/invocations?qualifier=DEFAULT`
  );
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


async def open_ticket(request: TicketRequest, caller: Caller) -> TicketId:
    token = await tickets_token()
    async with httpx.AsyncClient(timeout=30) as http:
        response = await http.post(
            f"{TICKETS_API}/tickets",
            json=ticket_body(request, caller),
            headers={"Authorization": f"Bearer {token}"},
        )
    response.raise_for_status()
    return parse_ticket_created(response.json())  # outside data -> domain type
```

</td><td>

```typescript
const ticketsToken = withAccessToken({
  providerName: "auth0-tickets", // the credential provider in the token vault
  authFlow: "M2M", // client credentials: the agent acts as itself
  scopes: ["tickets:write"],
  customParameters: { audience: TICKETS_API }, // Auth0 needs the API's audience
})(async (accessToken: string) => accessToken); // the agent never holds a client secret

export async function openTicket(request: TicketRequest, caller: Caller): Promise<TicketId> {
  const token = await ticketsToken();
  const response = await fetch(`${TICKETS_API}/tickets`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(ticketBody(request, caller)),
  });
  if (!response.ok) throw new Error(`tickets API: ${response.status}`);
  return parseTicketCreated(await response.json()); // outside data -> domain type
}
```

</td></tr></table>

The request body is built in the core, from the parsed caller:

<table><tr><th>Python (<code>python/core.py</code>)</th><th>TypeScript (<code>typescript/core.ts</code>)</th></tr><tr><td>

```python
def ticket_body(request: TicketRequest, caller: Caller) -> dict[str, str]:
    """The tickets API request. The requester comes from the token, never from the model."""
    return {
        "title": request.title,
        "description": request.description,
        "requester_id": requester(caller),
    }
```

</td><td>

```typescript
// The tickets API request. The requester comes from the token, never from the model.
export function ticketBody(request: TicketRequest, caller: Caller): Record<string, string> {
  return {
    title: request.title,
    description: request.description,
    requester_id: requester(caller),
  };
}
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
