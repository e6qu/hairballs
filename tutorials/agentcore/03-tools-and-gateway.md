# 03. Tools and the Gateway

You will: connect an MCP server to the helpdesk as a tool, then put it and a Lambda tool behind an AgentCore Gateway, and call the gateway from your own code. You need: the harness from [01. Your first agent](01-first-agent.md) (the skill from [02](02-skills.md) is optional). Cost: a few cents (Haiku tokens; Gateway is $0.005 per 1,000 tool calls; the Lambda fits in the free tier).

A **tool** is something the agent can call: a function with a name, a description and an input schema. **MCP** (Model Context Protocol) is the standard way to serve tools over HTTP. The tickets service in these tutorials is an MCP server at `https://tools.fintech.example/mcp`; use one of your own.

Infrastructure steps show three columns: **agentcore CLI** | **AWS CLI** | **Terraform**. The full files for this tutorial are in [`examples/03-tools-and-gateway/`](examples/03-tools-and-gateway/).

## Step 1: Attach an MCP server directly

The simplest way to give the agent tools: point the harness at an MCP server's URL. The harness asks the server for its tools and offers them to the model.

<table><tr><th>agentcore CLI</th><th>AWS CLI</th><th>Terraform</th></tr><tr><td>

```bash
agentcore add tool --harness helpdesk --type remote_mcp \
  --name tickets --url https://tools.fintech.example/mcp
agentcore deploy
agentcore invoke --session-id "$(uuidgen)" "My laptop does not start. Please open a ticket."
```

`add tool` adds this entry to `tools` in `harness.json`: `{"type": "remote_mcp", "name": "tickets", "config": {"remoteMcp": {"url": "..."}}}`.

</td><td>

```bash
aws bedrock-agentcore-control update-harness --harness-id "$(harness_id)" \
  --tools "[{\"type\":\"remote_mcp\",\"name\":\"tickets\",\"config\":{\"remoteMcp\":{\"url\":\"$TICKETS_URL\"}}}]"
```

`--tools` replaces the whole list. This is `./cli.sh direct`; `cli.sh` also defines `harness_id` and `TICKETS_URL`.

</td><td>

A `tool` block on the harness: `type = "remote_mcp"`, `name = "tickets"` and `config { remote_mcp { url = "..." } }`. Step 5 replaces it with the gateway, so [`terraform/main.tf`](examples/03-tools-and-gateway/terraform/main.tf) has only the final form.

</td></tr></table>

Terraform: [`aws_bedrockagentcore_harness.helpdesk`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/bedrockagentcore_harness)

If the server needs a key, add `headers` to `remoteMcp`. Better: put the server behind a gateway, which keeps credentials out of the agent's configuration.

## Step 2: Why a gateway

A direct MCP tool is fine for one agent. With many agents and many tools you want one place that controls them. An **AgentCore Gateway** is a managed MCP endpoint in front of your tools:

- one URL for many tools: MCP servers, Lambda functions, OpenAPI and Smithy APIs, API Gateway stages;
- it checks who calls it (IAM or a JWT) and holds the credentials for the tools;
- it adds Policy, rate limits and logs to every tool call.

Any agent, in any framework, can use the same governed tools. The rest of this tutorial puts the tickets server and a new Lambda tool behind one gateway.

## Step 3: Write and deploy a Lambda tool

A Lambda target turns a function into tools. The gateway sends the tool's arguments as the event, and the tool name as `<target>___<tool>` in the Lambda context.

The code has the same three parts as tutorial 01:

- **`domain`**: `Claim` (a `Category` enum, an amount in `Eur`, a `CityClass` enum), `GatewayToolName`, and the result `Verdict` = `WithinPolicy` | `OverLimit` (which always carries the excess). Money is a `Decimal` in Python and integer cents in TypeScript, never a float. The tool arguments and the Lambda context are parsed into these types at the boundary, or rejected with a `ParseError` that names the field.
- **`core`**: the policy as a pure function, `check_claim(claim) -> Verdict`.
- **shell**: the Lambda handler. It parses, calls the core and turns the verdict into the JSON the model reads.

<table><tr><th>Python</th><th>TypeScript</th></tr><tr><td>

```python
def handler(event: object, context: object) -> dict[str, object]:
    # The gateway passes the tool arguments as the event, and the tool name
    # as "<target>___<tool>" in the client context.
    tool = parse_invoked_tool(context)
    if tool.tool != "check_claim":
        raise ParseError(f"unknown tool: {tool}")
    return to_json(check_claim(parse_claim(event)))
```

</td><td>

```typescript
export async function handler(event: unknown, context: unknown): Promise<Record<string, unknown>> {
  // The gateway passes the tool arguments as the event, and the tool name
  // as "<target>___<tool>" in the client context.
  const tool = parseInvokedTool(context);
  if (tool.tool !== "check_claim") throw new ParseError(`unknown tool: ${formatToolName(tool)}`);
  return toJson(checkClaim(parseClaim(event)));
}
```

</td></tr><tr><td>

The boundary parser (`domain.py`):

```python
def parse_claim(raw: object) -> Claim:
    """The check_claim tool's arguments, as the gateway passes them to the Lambda."""
    fields = _fields(raw, "$")
    return Claim(
        category=_enum(Category, fields.get("category"), "$.category"),
        amount=Eur.parse(fields.get("amount_eur"), "$.amount_eur"),
        city=_enum(CityClass, fields.get("city_class", "standard"), "$.city_class"),
    )
```

</td><td>

The boundary parser (`domain.ts`):

```typescript
export function parseClaim(raw: unknown): Claim {
  const f = fields(raw, "$");
  return {
    category: oneOf(CATEGORIES, f.category, "$.category"),
    amount: parseEur(f.amount_eur, "$.amount_eur"),
    city: oneOf(CITY_CLASSES, f.city_class ?? "standard", "$.city_class"),
  };
}
```

</td></tr></table>

Full files: [`python/`](examples/03-tools-and-gateway/python/) (`domain.py`, `core.py`, `expenses_tool.py`), [`typescript/`](examples/03-tools-and-gateway/typescript/) (`domain.ts`, `core.ts`, `expenses-tool.ts`). The commands below deploy the Python version: the zip holds `domain.py`, `core.py` and `expenses_tool.py`, with no dependencies.

The gateway does not read the code, so you describe the tool to it in [`tools/expenses-tools.json`](examples/03-tools-and-gateway/tools/expenses-tools.json): name `check_claim`, a description, and a JSON schema with `category`, `amount_eur` and `city_class`. The schema describes the wire format for the gateway and the model; the code does not mirror it as types, it parses it.

Deploy the function. It needs only a role that can write logs.

<table><tr><th>agentcore CLI</th><th>AWS CLI</th><th>Terraform</th></tr><tr><td>

The agentcore CLI does not deploy an existing Lambda function: use the AWS CLI or Terraform.

</td><td>

```bash
aws iam create-role --role-name helpdesk-expenses-lambda \
  --assume-role-policy-document file://iam/lambda-trust-policy.json
aws iam attach-role-policy --role-name helpdesk-expenses-lambda \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
(cd python && zip -q ../expenses_tool.zip domain.py core.py expenses_tool.py)
aws lambda create-function --function-name helpdesk-expenses \
  --runtime python3.13 --architectures arm64 --handler expenses_tool.handler \
  --zip-file fileb://expenses_tool.zip \
  --role "arn:aws:iam::$ACCOUNT:role/helpdesk-expenses-lambda"
```

</td><td>

```hcl
data "archive_file" "expenses" {
  type        = "zip"
  output_path = "${path.module}/expenses_tool.zip"

  dynamic "source" {
    for_each = ["domain.py", "core.py", "expenses_tool.py"]
    content {
      filename = source.value
      content  = file("${path.module}/../python/${source.value}")
    }
  }
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

Terraform: [`aws_iam_role.expenses_lambda`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/iam_role), [`aws_iam_role_policy_attachment.expenses_logs`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/iam_role_policy_attachment), [`aws_lambda_function.expenses`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/lambda_function)

## Step 4: Create the gateway and its targets

The gateway has its own **service role**: what the gateway may call. Here that is the Lambda function. The tickets server needs no credentials in this example, so its target has none.

Inbound, the gateway uses `AWS_IAM`: callers sign requests with their AWS credentials, and need `bedrock-agentcore:InvokeGateway` on it.

<table><tr><th>agentcore CLI</th><th>AWS CLI</th><th>Terraform</th></tr><tr><td>

```bash
agentcore add gateway --name helpdesk-tools --protocol-type MCP --authorizer-type AWS_IAM
agentcore add gateway-target --gateway helpdesk-tools --name tickets --type mcp-server \
  --endpoint https://tools.fintech.example/mcp
agentcore add gateway-target --gateway helpdesk-tools --name expenses --type lambda-function-arn \
  --lambda-arn arn:aws:lambda:eu-west-1:111122223333:function:helpdesk-expenses \
  --tool-schema-file tools/expenses-tools.json
agentcore deploy
```

The gateway is part of the project. The CLI creates the service role and grants it the Lambda.

</td><td>

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

`$gw` is the gateway id. Wait until `get-gateway` shows `READY` before adding targets. `./cli.sh gateway` runs steps 3 to 5.

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

Terraform: [`aws_iam_role.gateway`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/iam_role), [`aws_iam_role_policy.gateway`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/iam_role_policy), [`aws_bedrockagentcore_gateway.tools`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/bedrockagentcore_gateway), [`aws_bedrockagentcore_gateway_target.tickets`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/bedrockagentcore_gateway_target), [`aws_bedrockagentcore_gateway_target.expenses`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/bedrockagentcore_gateway_target)

Full files: [`cli.sh`](examples/03-tools-and-gateway/cli.sh), [`terraform/main.tf`](examples/03-tools-and-gateway/terraform/main.tf), and the policies in [`iam/`](examples/03-tools-and-gateway/iam/).

For an MCP-server target, the gateway lists the server's tools when you create the target. If the server's tools change, run `synchronize-gateway-targets`.

## Step 5: Give the gateway to the harness

Replace the direct `tickets` tool with the gateway. The agent then sees `tickets___...` and `expenses___check_claim`. With `awsIam` outbound auth, the harness signs its calls to the gateway with its execution role, so the role needs `bedrock-agentcore:InvokeGateway`.

<table><tr><th>agentcore CLI</th><th>AWS CLI</th><th>Terraform</th></tr><tr><td>

```bash
agentcore remove tool --harness helpdesk --name tickets
agentcore add tool --harness helpdesk --type agentcore_gateway --name helpdesk-tools --gateway helpdesk-tools
agentcore deploy
agentcore invoke --session-id "$(uuidgen)" "Is 210 EUR for one hotel night in London within policy?"
```

The CLI adds `InvokeGateway` to the role. `--gateway` needs the gateway deployed first (step 4); for a gateway outside the project use `--gateway-arn`.

</td><td>

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

Terraform: [`aws_iam_role_policy.harness_gateway`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/iam_role_policy), [`aws_bedrockagentcore_harness.helpdesk`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/bedrockagentcore_harness), [`aws_bedrockagentcore_gateway.tools`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/bedrockagentcore_gateway)

Ask something that needs the Lambda tool (agentcore CLI column; from the AWS CLI or Terraform path use `agentcore invoke --harness-arn "$HARNESS_ARN" --region eu-west-1 "..."`). The agent calls `expenses___check_claim` through the gateway and answers that the limit is 180 EUR.

## Step 6: Call the gateway from your own code

The gateway is a normal MCP server. Any MCP client can list and call its tools, with no agent involved. That is useful for tests, and for agents written in other frameworks.

Because the gateway uses `AWS_IAM`, every HTTP request must be signed with SigV4 (service `bedrock-agentcore`). Neither MCP SDK does this, so give each one a signing hook: an `httpx2.Auth` in Python (the `mcp` 2.x SDK uses `httpx2`), a custom `fetch` in TypeScript.

The client reuses the same `domain` and `core`. The shell parses `GATEWAY_URL` into a `GatewayUrl`, sends a `Claim` as tool arguments, and parses the tool's text result back into a `Verdict` before `core.render` prints it.

<table><tr><th>Python (<code>mcp</code> 2.2)</th><th>TypeScript (<code>@modelcontextprotocol/sdk</code> 1.30)</th></tr><tr><td>

```python
async def check(gateway: GatewayUrl, claim: Claim) -> None:
    timeout = httpx2.Timeout(30, read=300)  # the server may hold a stream open
    async with httpx2.AsyncClient(auth=SigV4("eu-west-1"), timeout=timeout) as http:
        async with Client(streamable_http_client(gateway.value, http_client=http)) as client:
            listed = await client.list_tools()
            print("tools:", ", ".join(tool.name for tool in listed.tools))

            result = await client.call_tool(str(CHECK_CLAIM), to_arguments(claim))
            texts = [block.text for block in result.content if isinstance(block, TextContent)]
            if result.is_error or not texts:
                raise RuntimeError(f"{CHECK_CLAIM} failed: {texts}")
            print(render(claim, parse_verdict(texts[0])))  # outside data -> domain type
```

</td><td>

```typescript
async function check(gateway: GatewayUrl, claim: Claim): Promise<void> {
  const client = new Client({ name: "helpdesk-app", version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(gateway), { fetch: signedFetch }));
  try {
    const { tools } = await client.listTools();
    console.log(`tools: ${tools.map((t) => t.name).join(", ")}`);

    const result = await client.callTool({
      name: formatToolName(CHECK_CLAIM),
      arguments: toArguments(claim),
    });
    const content: unknown[] = Array.isArray(result.content) ? result.content : [];
    const text = content.map(textOf).find((t) => t !== undefined);
    if (result.isError || text === undefined) {
      throw new Error(`${formatToolName(CHECK_CLAIM)} failed`);
    }
    console.log(render(claim, parseVerdict(text))); // outside data -> domain type
  } finally {
    await client.close();
  }
}
```

</td></tr><tr><td>

The boundary parser for the result (`domain.py`):

```python
def parse_verdict(text: str) -> Verdict:
    """The check_claim result, as the MCP client receives it (JSON text)."""
    try:
        fields = _fields(json.loads(text), "$")
    except json.JSONDecodeError as exc:
        raise ParseError(f"$: not JSON: {text[:80]!r}") from exc
    limit = Eur.parse(fields.get("limit_eur"), "$.limit_eur")
    match fields.get("within_policy"):
        case True:
            return WithinPolicy(limit)
        case False:
            return OverLimit(limit, Eur.parse(fields.get("excess_eur"), "$.excess_eur"))
        case other:
            raise ParseError(f"$.within_policy: expected true or false, got {other!r}")
```

</td><td>

The boundary parser for the result (`domain.ts`):

```typescript
export function parseVerdict(text: string): Verdict {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ParseError(`$: not JSON: ${text.slice(0, 80)}`);
  }
  const f = fields(json, "$");
  const limit = parseEur(f.limit_eur, "$.limit_eur");
  if (f.within_policy === true) return { kind: "within", limit };
  if (f.within_policy === false) {
    return { kind: "over", limit, excess: parseEur(f.excess_eur, "$.excess_eur") };
  }
  throw new ParseError(
    `$.within_policy: expected true or false, got ${JSON.stringify(f.within_policy)}`,
  );
}
```

</td></tr><tr><td>

The signing hook:

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
```

</td><td>

The signing hook:

```typescript
const signer = new SignatureV4({
  service: "bedrock-agentcore",
  region: "eu-west-1",
  credentials: fromNodeProviderChain(),
  sha256: Sha256,
});

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

Full files: [`python/call_gateway.py`](examples/03-tools-and-gateway/python/call_gateway.py), [`typescript/call-gateway.ts`](examples/03-tools-and-gateway/typescript/call-gateway.ts), plus `domain` and `core`. With the AWS CLI, `get-gateway --query gatewayUrl` prints the URL.

Terraform: [`aws_bedrockagentcore_gateway.tools`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/bedrockagentcore_gateway), [`aws_iam_policy.invoke_gateway`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/iam_policy)

The caller needs `bedrock-agentcore:InvokeGateway` on the gateway; in Terraform that is the `helpdesk-invoke-gateway` policy (`aws_iam_policy.invoke_gateway`) to attach to your application's role. Both clients were checked against a local MCP server that verifies the SigV4 signatures. **[verify]** against a real gateway: no AWS account was used.

A gateway with a **JWT** authorizer (tutorial 06) takes a bearer token instead: `httpx2.AsyncClient(headers={"Authorization": f"Bearer {token}"})` in Python, and ``new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } })`` in TypeScript.

## What just happened

- A `remote_mcp` tool connected the harness straight to one MCP server.
- The gateway put that server and a Lambda function behind one MCP endpoint, named `<target>___<tool>`, with IAM inbound auth and its own service role outbound.
- The harness and your own code used the same gateway: the harness through an `agentcore_gateway` tool, your code through an MCP client that signs with SigV4.

## Clean up

<table><tr><th>agentcore CLI</th><th>AWS CLI</th><th>Terraform</th></tr><tr><td>

```bash
agentcore remove tool --harness helpdesk --name helpdesk-tools
agentcore remove gateway --name helpdesk-tools
agentcore deploy
```

Then delete the Lambda function and its role with the last three commands in the AWS CLI column.

</td><td>

```bash
./cli.sh down
```

It removes the tools from the harness, the gateway and its targets, and then:

```bash
aws lambda delete-function --function-name helpdesk-expenses
aws iam detach-role-policy --role-name helpdesk-expenses-lambda \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
aws iam delete-role --role-name helpdesk-expenses-lambda
```

</td><td>

```bash
terraform destroy
```

</td></tr></table>

Next: [04. Your own code](04-your-own-code.md)
