# 03. Tools and the Gateway

You will: connect an MCP server to the helpdesk as a tool, then put it and a Lambda tool behind an AgentCore Gateway, and call the gateway from your own code. You need: the harness from [01. Your first agent](01-first-agent.md) (the skill from [02](02-skills.md) is optional). Cost: a few cents (Haiku tokens; Gateway is $0.005 per 1,000 tool calls; the Lambda fits in the free tier).

A **tool** is something the agent can call: a function with a name, a description and an input schema. **MCP** (Model Context Protocol) is the standard way to serve tools over HTTP. The tickets service in these tutorials is an MCP server at `https://tools.fintech.example/mcp`; use one of your own.

The full files for this tutorial are in [`examples/03-tools-and-gateway/`](examples/03-tools-and-gateway/).

## Step 1: Attach an MCP server directly

The simplest way to give the agent tools: point the harness at an MCP server's URL. The harness asks the server for its tools and offers them to the model.

```bash
agentcore add tool --harness helpdesk --type remote_mcp --name tickets --url https://tools.fintech.example/mcp
agentcore deploy
agentcore invoke --session-id "$(uuidgen)" "My laptop does not start. Please open a ticket."
```

`app/helpdesk/harness.json` now has:

```json
"tools": [
  {
    "type": "remote_mcp",
    "name": "tickets",
    "config": {
      "remoteMcp": {
        "url": "https://tools.fintech.example/mcp"
      }
    }
  }
]
```

With the AWS CLI it is one call (`direct` in `cli.sh`, which also defines `harness_id` and `TICKETS_URL`). `--tools` replaces the whole list:

```bash
aws bedrock-agentcore-control update-harness --harness-id "$(harness_id)" \
  --tools "[{\"type\":\"remote_mcp\",\"name\":\"tickets\",\"config\":{\"remoteMcp\":{\"url\":\"$TICKETS_URL\"}}}]"
```

In Terraform it is a `tool` block on the harness, with `type = "remote_mcp"` and `config { remote_mcp { url = "..." } }`.

If the server needs a key, add `headers` to `remoteMcp`. Better: put the server behind a gateway, which keeps credentials out of the agent's configuration.

## Step 2: Why a gateway

A direct MCP tool is fine for one agent. With many agents and many tools you want one place that controls them. An **AgentCore Gateway** is a managed MCP endpoint in front of your tools:

- one URL for many tools: MCP servers, Lambda functions, OpenAPI and Smithy APIs, API Gateway stages;
- it checks who calls it (IAM or a JWT) and holds the credentials for the tools;
- it adds Policy, rate limits and logs to every tool call.

Any agent, in any framework, can use the same governed tools. The rest of this tutorial puts the tickets server and a new Lambda tool behind one gateway.

## Step 3: Write a Lambda tool

A Lambda target turns a function into tools. The gateway sends the tool's arguments as the event, and the tool name as `<target>___<tool>` in the Lambda context.

<table><tr><th>Python</th><th>TypeScript</th></tr><tr><td>

```python
def check_claim(category: str, amount_eur: float, city_class: str = "standard") -> ClaimResult:
    limit = LIMITS_EUR[category][city_class]
    return {"within_policy": amount_eur <= limit, "limit_eur": limit}


def handler(event: dict[str, str | float], context: GatewayContext) -> ClaimResult:
    # The gateway passes the tool arguments as the event, and the tool name
    # as "<target>___<tool>" in the client context.
    tool = context.client_context.custom["bedrockAgentCoreToolName"].split("___")[-1]
    if tool != "check_claim":
        raise ValueError(f"unknown tool: {tool}")
    return check_claim(
        category=str(event["category"]),
        amount_eur=float(event["amount_eur"]),
        city_class=str(event.get("city_class", "standard")),
    )
```

</td><td>

```typescript
function checkClaim({ category, amount_eur, city_class = "standard" }: ClaimInput): ClaimResult {
  const limit = LIMITS_EUR[category]?.[city_class];
  if (limit === undefined) throw new Error(`unknown category: ${category}/${city_class}`);
  return { within_policy: amount_eur <= limit, limit_eur: limit };
}

export async function handler(event: ClaimInput, context: GatewayContext): Promise<ClaimResult> {
  // The gateway passes the tool arguments as the event, and the tool name
  // as "<target>___<tool>" in the client context.
  const custom = context.clientContext?.custom ?? context.clientContext?.Custom ?? {};
  const tool = (custom.bedrockAgentCoreToolName ?? "").split("___").pop();
  if (tool !== "check_claim") throw new Error(`unknown tool: ${tool}`);
  return checkClaim(event);
}
```

</td></tr></table>

Full files: [`python/expenses_tool.py`](examples/03-tools-and-gateway/python/expenses_tool.py), [`typescript/expenses-tool.ts`](examples/03-tools-and-gateway/typescript/expenses-tool.ts). The commands below deploy the Python version.

The gateway does not read the code, so you describe the tool to it in [`tools/expenses-tools.json`](examples/03-tools-and-gateway/tools/expenses-tools.json): name `check_claim`, a description, and a JSON schema with `category`, `amount_eur` and `city_class`.

Deploy the function. It needs only a role that can write logs.

<table><tr><th>AWS CLI</th><th>Terraform</th></tr><tr><td>

```bash
aws iam create-role --role-name helpdesk-expenses-lambda \
  --assume-role-policy-document file://iam/lambda-trust-policy.json
aws iam attach-role-policy --role-name helpdesk-expenses-lambda \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
(cd python && zip -q ../expenses_tool.zip expenses_tool.py)
aws lambda create-function --function-name helpdesk-expenses \
  --runtime python3.13 --architectures arm64 --handler expenses_tool.handler \
  --zip-file fileb://expenses_tool.zip \
  --role "arn:aws:iam::$ACCOUNT:role/helpdesk-expenses-lambda"
```

</td><td>

```hcl
data "archive_file" "expenses" {
  type        = "zip"
  source_file = "${path.module}/../python/expenses_tool.py"
  output_path = "${path.module}/expenses_tool.zip"
}

resource "aws_lambda_function" "expenses" {
  function_name    = "helpdesk-expenses"
  role             = aws_iam_role.expenses_lambda.arn
  runtime          = "python3.13"
  architectures    = ["arm64"]
  handler          = "expenses_tool.handler"
  filename         = data.archive_file.expenses.output_path
  source_code_hash = data.archive_file.expenses.output_base64sha256
}
```

</td></tr></table>

## Step 4: Create the gateway and its targets

The gateway has its own **service role**: what the gateway may call. Here that is the Lambda function. The tickets server needs no credentials in this example, so its target has none.

Inbound, the gateway uses `AWS_IAM`: callers sign requests with their AWS credentials, and need `bedrock-agentcore:InvokeGateway` on it.

<table><tr><th>AWS CLI</th><th>Terraform</th></tr><tr><td>

```bash
aws iam create-role --role-name helpdesk-gateway \
  --assume-role-policy-document file://iam/gateway-trust-policy.json
aws iam put-role-policy --role-name helpdesk-gateway --policy-name invoke-tools \
  --policy-document file://iam/gateway-policy.json

aws bedrock-agentcore-control create-gateway --name helpdesk-tools \
  --role-arn "arn:aws:iam::$ACCOUNT:role/helpdesk-gateway" \
  --protocol-type MCP --authorizer-type AWS_IAM

aws bedrock-agentcore-control create-gateway-target --gateway-identifier "$gw" \
  --name tickets \
  --target-configuration "{\"mcp\":{\"mcpServer\":{\"endpoint\":\"$TICKETS_URL\"}}}"
aws bedrock-agentcore-control create-gateway-target --gateway-identifier "$gw" \
  --name expenses \
  --target-configuration "$(jq -n \
    --arg arn "arn:aws:lambda:$AWS_REGION:$ACCOUNT:function:helpdesk-expenses" \
    --slurpfile tools tools/expenses-tools.json \
    '{mcp: {lambda: {lambdaArn: $arn, toolSchema: {inlinePayload: $tools[0]}}}}')" \
  --credential-provider-configurations '[{"credentialProviderType":"GATEWAY_IAM_ROLE"}]'
```

`$gw` is the gateway id. Wait until `get-gateway` shows `READY` before adding targets.

</td><td>

```hcl
resource "aws_bedrockagentcore_gateway" "tools" {
  name            = "helpdesk-tools"
  role_arn        = aws_iam_role.gateway.arn
  protocol_type   = "MCP"
  authorizer_type = "AWS_IAM"
}

resource "aws_bedrockagentcore_gateway_target" "tickets" {
  gateway_identifier = aws_bedrockagentcore_gateway.tools.gateway_id
  name               = "tickets"

  target_configuration {
    mcp {
      mcp_server {
        endpoint = "https://tools.fintech.example/mcp"
      }
    }
  }
}

resource "aws_bedrockagentcore_gateway_target" "expenses" {
  gateway_identifier = aws_bedrockagentcore_gateway.tools.gateway_id
  name               = "expenses"

  credential_provider_configuration {
    gateway_iam_role {}
  }
  target_configuration {
    mcp {
      lambda {
        lambda_arn = aws_lambda_function.expenses.arn
        tool_schema {
          # ...
        }
      }
    }
  }
}
```

`# ...` is the tool schema, written as HCL blocks.

</td></tr></table>

Full files: [`cli.sh`](examples/03-tools-and-gateway/cli.sh), [`terraform/main.tf`](examples/03-tools-and-gateway/terraform/main.tf), and the policies in [`iam/`](examples/03-tools-and-gateway/iam/).

With the agentcore CLI, the gateway is part of the project. The CLI creates the service role and grants it the Lambda:

```bash
agentcore add gateway --name helpdesk-tools --protocol-type MCP --authorizer-type AWS_IAM
agentcore add gateway-target --gateway helpdesk-tools --name tickets --type mcp-server \
  --endpoint https://tools.fintech.example/mcp
agentcore add gateway-target --gateway helpdesk-tools --name expenses --type lambda-function-arn \
  --lambda-arn arn:aws:lambda:eu-west-1:111122223333:function:helpdesk-expenses \
  --tool-schema-file tools/expenses-tools.json
agentcore deploy
```

For an MCP-server target, the gateway lists the server's tools when you create the target. If the server's tools change, run `synchronize-gateway-targets`.

## Step 5: Give the gateway to the harness

Replace the direct `tickets` tool with the gateway. The agent then sees `tickets___...` and `expenses___check_claim`. With `awsIam` outbound auth, the harness signs its calls to the gateway with its execution role, so the role needs `bedrock-agentcore:InvokeGateway`.

```bash
agentcore remove tool --harness helpdesk --name tickets
agentcore add tool --harness helpdesk --type agentcore_gateway --name helpdesk-tools --gateway helpdesk-tools
agentcore deploy
```

The CLI adds `InvokeGateway` to the role. `--gateway` needs the gateway deployed first (step 4); for a gateway outside the project use `--gateway-arn`.

<table><tr><th>AWS CLI</th><th>Terraform</th></tr><tr><td>

```bash
aws iam put-role-policy --role-name "$HARNESS_ROLE" --policy-name gateway \
  --policy-document file://iam/harness-gateway-policy.json
aws bedrock-agentcore-control update-harness --harness-id "$(harness_id)" \
  --tools "[{\"type\":\"agentcore_gateway\",\"name\":\"helpdesk-tools\",\"config\":{\"agentCoreGateway\":{\"gatewayArn\":\"$gw_arn\",\"outboundAuth\":{\"awsIam\":{}}}}}]"
```

</td><td>

```hcl
resource "aws_iam_role_policy" "harness_gateway" {
  role   = aws_iam_role.helpdesk.id
  name   = "gateway"
  policy = file("${local.iam}/harness-gateway-policy.json")
}

resource "aws_bedrockagentcore_harness" "helpdesk" {
  # ...
  tool {
    type = "agentcore_gateway"
    name = "helpdesk-tools"
    config {
      agentcore_gateway {
        gateway_arn = aws_bedrockagentcore_gateway.tools.gateway_arn
        outbound_auth {
          aws_iam = true
        }
      }
    }
  }
}
```

</td></tr></table>

Ask something that needs the Lambda tool:

```bash
agentcore invoke --session-id "$(uuidgen)" "Is 210 EUR for one hotel night in London within policy?"
```

The agent calls `expenses___check_claim` through the gateway and answers that the limit is 180 EUR.

## Step 6: Call the gateway from your own code

The gateway is a normal MCP server. Any MCP client can list and call its tools, with no agent involved. That is useful for tests, and for agents written in other frameworks.

Because the gateway uses `AWS_IAM`, every HTTP request must be signed with SigV4 (service `bedrock-agentcore`). Neither MCP SDK does this, so give each one a signing hook: an `httpx2.Auth` in Python (the `mcp` 2.x SDK uses `httpx2`), a custom `fetch` in TypeScript.

<table><tr><th>Python (<code>mcp</code> 2.2)</th><th>TypeScript (<code>@modelcontextprotocol/sdk</code> 1.30)</th></tr><tr><td>

```python
class SigV4(httpx2.Auth):
    """Sign each HTTP request with the default AWS credentials."""

    requires_request_body = True

    def __init__(self, region: str) -> None:
        credentials = boto3.Session().get_credentials()
        if credentials is None:
            raise RuntimeError("no AWS credentials found")
        self.signer = SigV4Auth(credentials, "bedrock-agentcore", region)

    def auth_flow(
        self, request: httpx2.Request
    ) -> Generator[httpx2.Request, httpx2.Response, None]:
        signed = AWSRequest(method=request.method, url=str(request.url), data=request.content)
        self.signer.add_auth(signed)  # adds Authorization and X-Amz-Date headers
        request.headers.update(dict(signed.headers.items()))
        yield request


async def main(gateway_url: str) -> None:
    timeout = httpx2.Timeout(30, read=300)  # the server may hold a stream open
    async with httpx2.AsyncClient(auth=SigV4("eu-west-1"), timeout=timeout) as http:
        async with Client(streamable_http_client(gateway_url, http_client=http)) as client:
            listed = await client.list_tools()
            for tool in listed.tools:
                print(tool.name)  # "<target>___<tool>", e.g. expenses___check_claim

            result = await client.call_tool(
                "expenses___check_claim",
                {"category": "hotel", "amount_eur": 210, "city_class": "major"},
            )
```

</td><td>

```typescript
const signer = new SignatureV4({
  service: "bedrock-agentcore",
  region: "eu-west-1",
  credentials: fromNodeProviderChain(),
  sha256: Sha256,
});

// A fetch that signs each request (adds Authorization and X-Amz-Date headers).
async function signedFetch(url: string | URL, init: RequestInit = {}): Promise<Response> {
  const target = new URL(url);
  const signed = await signer.sign({
    method: init.method ?? "GET",
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port ? Number(target.port) : undefined,
    path: target.pathname,
    query: Object.fromEntries(target.searchParams),
    headers: { host: target.host },
    body: typeof init.body === "string" ? init.body : undefined,
  });
  const headers = new Headers(init.headers);
  for (const [name, value] of Object.entries(signed.headers)) {
    if (name !== "host") headers.set(name, value);
  }
  return fetch(target, { ...init, headers });
}

async function main(gatewayUrl: string): Promise<void> {
  const client = new Client({ name: "helpdesk-app", version: "0.1.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(gatewayUrl), { fetch: signedFetch }),
  );

  const { tools } = await client.listTools();
  for (const tool of tools) {
    console.log(tool.name); // "<target>___<tool>", e.g. expenses___check_claim
  }

  const result = await client.callTool({
    name: "expenses___check_claim",
    arguments: { category: "hotel", amount_eur: 210, city_class: "major" },
  });
```

</td></tr><tr><td>

```bash
cd python && uv sync
GATEWAY_URL=$(terraform -chdir=../terraform output -raw gateway_url) \
  uv run python call_gateway.py
```

</td><td>

```bash
cd typescript && npm install
GATEWAY_URL=$(terraform -chdir=../terraform output -raw gateway_url) \
  npm run call-gateway
```

</td></tr></table>

Full files: [`python/call_gateway.py`](examples/03-tools-and-gateway/python/call_gateway.py), [`typescript/call-gateway.ts`](examples/03-tools-and-gateway/typescript/call-gateway.ts). With the AWS CLI, `get-gateway --query gatewayUrl` prints the URL.

The caller needs `bedrock-agentcore:InvokeGateway` on the gateway. Both clients were checked against a local MCP server that verifies the SigV4 signatures. **[verify]** against a real gateway: no AWS account was used.

A gateway with a **JWT** authorizer (tutorial 06) takes a bearer token instead: `httpx2.AsyncClient(headers={"Authorization": f"Bearer {token}"})` in Python, and ``new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } })`` in TypeScript.

## What just happened

- A `remote_mcp` tool connected the harness straight to one MCP server.
- The gateway put that server and a Lambda function behind one MCP endpoint, named `<target>___<tool>`, with IAM inbound auth and its own service role outbound.
- The harness and your own code used the same gateway: the harness through an `agentcore_gateway` tool, your code through an MCP client that signs with SigV4.

## Clean up

```bash
agentcore remove tool --harness helpdesk --name helpdesk-tools
agentcore remove gateway --name helpdesk-tools
agentcore deploy
aws lambda delete-function --function-name helpdesk-expenses
```

Also delete the Lambda's role `helpdesk-expenses-lambda`. If you used the AWS CLI: `./cli.sh down`. With Terraform: `terraform destroy`.

Next: [04. Your own code](04-your-own-code.md)
