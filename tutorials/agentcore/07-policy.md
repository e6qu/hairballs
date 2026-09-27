# 07. Policy

You will: allow or deny helpdesk tool calls on the Gateway with Cedar rules that read Auth0 claims. You need: the `helpdesk-tools` Gateway with Auth0 sign-in ([03](03-tools-and-gateway.md), [06](06-auth0-identity.md)), `jq` for the AWS CLI path. Cost: $0.000025 per checked tool call ($0.025 per 1,000).

The full, checked files are in [`examples/07-policy/`](examples/07-policy/).

## Step 1: Know what a policy sees

On every `tools/call`, the Gateway builds one Cedar request and asks the policy engine. Nothing else is involved.

| Cedar | Comes from | Example |
|---|---|---|
| `principal` | the JWT `sub` | `AgentCore::OAuthUser::"auth0\|6512…"` |
| `principal` tags | **every JWT claim** | `principal.getTag("https://fintech.example/role") == "treasury"` |
| `action` | `<Target>___<tool>` | `AgentCore::Action::"tickets___create_ticket"` |
| `resource` | the Gateway | `AgentCore::Gateway::"arn:aws:bedrock-agentcore:eu-west-1:111122223333:gateway/helpdesk-tools-abc123xyz"` |
| `context.input` | the tool arguments | `context.input.amount` |

Terraform: [`aws_bedrockagentcore_gateway.tools`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/bedrockagentcore_gateway)

Two rules decide the result:

- **Default deny.** A call is allowed only if some policy permits it.
- **Forbid wins.** One matching `forbid` denies the call, whatever else permits it.

## Step 2: Write the policies

One Cedar file per rule. `${gateway_arn}` is filled in when you create the policy: a policy that names a specific tool must also name a specific gateway.

Everyone who signs in may use the ticket tools. `action in …"tickets"` means every tool of the `tickets` target.

```cedar
// Everyone signed in through Auth0 may use the ticket tools.
permit (
  principal is AgentCore::OAuthUser,
  action in AgentCore::Action::"tickets",
  resource == AgentCore::Gateway::"${gateway_arn}"
);
```

Machine clients may not open tickets. Auth0 puts `"gty": "client-credentials"` in every M2M access token (their `sub` is `<client_id>@clients`).

```cedar
// Machine clients (Auth0 client credentials) may read tickets but never open one.
forbid (
  principal,
  action == AgentCore::Action::"tickets___create_ticket",
  resource == AgentCore::Gateway::"${gateway_arn}"
)
when { principal.hasTag("gty") && principal.getTag("gty") == "client-credentials" };
```

Only treasury users may transfer money, and only below 10,000. The `role` claim comes from the post-login Action in [06](06-auth0-identity.md).

```cedar
// Treasury users may transfer below 10,000. Nobody else may call transfer.
permit (
  principal,
  action == AgentCore::Action::"payments___transfer",
  resource == AgentCore::Gateway::"${gateway_arn}"
)
when {
  principal.hasTag("https://fintech.example/role") &&
  principal.getTag("https://fintech.example/role") == "treasury" &&
  context.input.amount < 10000
};
```

Cedar compares whole numbers: declare `amount` as an integer in the tool schema. **[verify]** how a floating-point `amount` is typed in `context.input`.

Terraform: [`aws_bedrockagentcore_policy.helpdesk`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/bedrockagentcore_policy) (one per file, through `templatefile`)

## Step 3: Create the policy engine and the policies

A **policy engine** holds the policies. Creating it changes nothing yet: it only acts once attached to a gateway.

In the `agentcore` project from [03](03-tools-and-gateway.md), `add policy-engine` also attaches the engine to the gateway in `LOG_ONLY` mode (Step 4). `agentcore add policy` also takes `--generate "<plain English>"` to draft a policy from a sentence; review what it writes.

<table><tr><th>agentcore CLI</th><th>AWS CLI</th><th>Terraform</th></tr><tr><td>

```bash
agentcore add policy-engine --name helpdesk_policies \
  --attach-to-gateways helpdesk-tools --attach-mode LOG_ONLY

# the ARN of your deployed gateway
GATEWAY_ARN=arn:aws:bedrock-agentcore:eu-west-1:111122223333:gateway/helpdesk-tools-abc123xyz
for p in tickets_for_users no_m2m_create_ticket treasury_transfer; do
  sed "s|\${gateway_arn}|$GATEWAY_ARN|" "policies/$p.cedar" > "policies/$p.resolved.cedar"
  agentcore add policy --engine helpdesk_policies --name "$p" \
    --source "policies/$p.resolved.cedar"
done
agentcore deploy
```

</td><td>

```bash
ENGINE_ID=$(aws bedrock-agentcore-control create-policy-engine --region "$REGION" \
  --name helpdesk_policies --description "Who may call which helpdesk tool" \
  --query policyEngineId --output text)

for name in "${POLICIES[@]}"; do
  statement=$(sed "s|\${gateway_arn}|$GATEWAY_ARN|" "$POLICY_DIR/$name.cedar")
  aws bedrock-agentcore-control create-policy --region "$REGION" \
    --policy-engine-id "$ENGINE_ID" --name "$name" \
    --validation-mode FAIL_ON_ANY_FINDINGS \
    --definition "$(jq -n --arg s "$statement" '{cedar: {statement: $s}}')"
done
```

</td><td>

```hcl
resource "aws_bedrockagentcore_policy_engine" "helpdesk" {
  name        = "helpdesk_policies"
  description = "Who may call which helpdesk tool"
}

resource "aws_bedrockagentcore_policy" "helpdesk" {
  for_each         = local.policies
  name             = each.key
  policy_engine_id = aws_bedrockagentcore_policy_engine.helpdesk.policy_engine_id
  validation_mode  = "FAIL_ON_ANY_FINDINGS"

  definition {
    cedar {
      statement = templatefile("${path.module}/../policies/${each.value}", {
        gateway_arn = aws_bedrockagentcore_gateway.tools.gateway_arn
      })
    }
  }
}
```

</td></tr></table>

Terraform: [`aws_bedrockagentcore_policy_engine.helpdesk`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/bedrockagentcore_policy_engine), [`aws_bedrockagentcore_policy.helpdesk`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/bedrockagentcore_policy)

`FAIL_ON_ANY_FINDINGS` rejects a policy that does not parse or that the validator flags (for example one that allows everything).

## Step 4: Attach the engine in LOG_ONLY mode

In `LOG_ONLY` mode the engine decides every call and logs the decision, but the Gateway lets every call through. Run real traffic like this for a few days and read the decisions before you block anything.

The Terraform gateway resource keeps its settings from [03](03-tools-and-gateway.md) (`# ...`).

<table><tr><th>agentcore CLI</th><th>AWS CLI</th><th>Terraform</th></tr><tr><td>

Done in Step 3 by `--attach-to-gateways helpdesk-tools --attach-mode LOG_ONLY`. It writes this into the gateway in `agentcore/agentcore.json`:

```json
"policyEngineConfiguration": {
  "policyEngineName": "helpdesk_policies",
  "mode": "LOG_ONLY"
}
```

</td><td>

```bash
# UpdateGateway replaces the whole configuration:
# pass every setting the gateway already has.
aws bedrock-agentcore-control update-gateway --region "$REGION" \
  --gateway-identifier "$GATEWAY_ID" \
  --name "$(jq -r .name <<<"$GATEWAY")" \
  --role-arn "$(jq -r .roleArn <<<"$GATEWAY")" \
  --protocol-type MCP \
  --authorizer-type CUSTOM_JWT \
  --authorizer-configuration "$(jq -c .authorizerConfiguration <<<"$GATEWAY")" \
  --policy-engine-configuration "{\"arn\":\"$engine_arn\",\"mode\":\"$1\"}"
```

</td><td>

```hcl
resource "aws_bedrockagentcore_gateway" "tools" {
  name            = "helpdesk-tools"
  # ...

  policy_engine_configuration {
    arn  = aws_bedrockagentcore_policy_engine.helpdesk.policy_engine_arn
    mode = var.policy_mode
  }
}
```

</td></tr></table>

Terraform: [`aws_bedrockagentcore_gateway.tools`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/bedrockagentcore_gateway), [`aws_bedrockagentcore_policy_engine.helpdesk`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/bedrockagentcore_policy_engine)

Where to read the decisions: the Gateway's traces in the CloudWatch **GenAI Observability** view ([09](09-observability-evals-costs.md)), and the Policy metrics in the `AWS/Bedrock-AgentCore` namespace.

To shadow-test one new policy while the others already enforce, create it with `--enforcement-mode LOG_ONLY` (`agentcore add policy` and `aws bedrock-agentcore-control create-policy` both take it), then promote it with `--enforcement-mode ACTIVE`. The Terraform resource in provider 6.66 has no `enforcement_mode` argument.

## Step 5: Switch to ENFORCE

When the logged decisions match what you expect, enforce them.

<table><tr><th>agentcore CLI</th><th>AWS CLI</th><th>Terraform</th></tr><tr><td>

In `agentcore/agentcore.json`, set the gateway's mode:

```json
"policyEngineConfiguration": {
  "policyEngineName": "helpdesk_policies",
  "mode": "ENFORCE"
}
```

Then run `agentcore deploy`.

</td><td>

Run the `update-gateway` command from Step 4 with mode `ENFORCE`: `attach_engine ENFORCE` in `cli.sh`.

</td><td>

```bash
terraform apply -var policy_mode=ENFORCE
```

</td></tr></table>

Terraform: [`aws_bedrockagentcore_gateway.tools`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/bedrockagentcore_gateway)

Anyone who can call `UpdateGateway` can switch the mode back to `LOG_ONLY` or remove the engine. Grant that permission only to the platform team.

## Step 6: Handle a denied call

A denied call is **not** an HTTP error. The Gateway returns a normal MCP tool result with `isError: true`:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "isError": true,
    "content": [{ "type": "text", "text": "AuthorizeActionException - Tool Execution Denied: Tool call not allowed due to policy enforcement [No policy applies to the request (denied by default).]" }]
  }
}
```

What each caller sees:

- **The model, inside a Strands agent.** The MCP client turns the result into an error tool result, and the model reads the text. Add one line to the system prompt: *"If a tool call is denied by policy, tell the user and do not retry it."*
- **`tools/list`.** A caller never sees a tool that no policy would ever let it call. An M2M agent usually doesn't see `create_ticket` at all.
- **Your own code** that calls tools directly. Tell a denial apart from other errors, and don't retry it:

<table><tr><th>Python</th><th>TypeScript</th></tr><tr><td>

```python
DENIED = "AuthorizeActionException"  # the Gateway's text for a Cedar deny


class PolicyDenied(Exception):
    """The policy engine refused this tool call. Retrying will not help."""


def text_or_raise(result: ToolResult) -> str:
    text = "\n".join(
        c["text"] for c in result.get("content", []) if c["type"] == "text"
    )
    if result.get("isError"):
        if text.startswith(DENIED):
            raise PolicyDenied(text)
        raise RuntimeError(text)
    return text
```

</td><td>

```typescript
const DENIED = "AuthorizeActionException"; // the Gateway's text for a Cedar deny

/** The policy engine refused this tool call. Retrying will not help. */
export class PolicyDenied extends Error {}

export function textOrThrow(result: ToolResult): string {
  const text = (result.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
  if (result.isError) {
    if (text.startsWith(DENIED)) throw new PolicyDenied(text);
    throw new Error(text);
  }
  return text;
}
```

</td></tr></table>

Terraform: [`aws_bedrockagentcore_gateway.tools`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/bedrockagentcore_gateway) (callers authenticate with Auth0 tokens, not IAM)

Try it with an M2M token from [06](06-auth0-identity.md): `ACCESS_TOKEN=<m2m token> uv run python call_tool.py` prints `not allowed: AuthorizeActionException …` and exits with code 2. With a user's token, it prints the new ticket id.

## What just happened

- The Gateway turned each tool call into a Cedar request: the token's `sub` and claims, the tool name, and its arguments.
- The engine logged its decisions in `LOG_ONLY` mode, then enforced them: default deny, forbid wins.
- A denied call came back as a tool result with `isError: true`, which the model reads and your code can detect.

## Clean up

```bash
# agentcore CLI: remove the engine and its policies from agentcore.json, then deploy
agentcore remove policy-engine --name helpdesk_policies --yes && agentcore deploy
# AWS CLI: the clean_up function in examples/07-policy/cli.sh
# Terraform: set policy_mode, then remove the policy resources and apply; or terraform destroy
```

Next: [08. Events and schedules](08-events-and-schedules.md)
