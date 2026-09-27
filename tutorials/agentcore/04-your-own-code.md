# 04. Your own code

You will: write the helpdesk agent as code with Strands, run it locally, host it on AgentCore Runtime and call it from code. You need: [01. Your first agent](01-first-agent.md) (the CLI, AWS credentials), Python 3.12 with uv or Node.js 22. Cost: a few cents (Haiku tokens, plus Runtime at $0.0895 per vCPU-hour and $0.00945 per GB-hour while a session lives).

Full source: [`examples/04-your-own-code/`](examples/04-your-own-code/).

## Step 1: Write the agent

A Runtime agent is an HTTP server with two routes: `POST /invocations` and `GET /ping`. `BedrockAgentCoreApp` is that server; the Strands `Agent` is the loop inside it.

The tool is a plain function. Strands turns its signature and docstring (Python) or its Zod schema (TypeScript) into the tool definition the model sees.

<table><tr><th>Python (<code>python/main.py</code>)</th><th>TypeScript (<code>typescript/main.ts</code>)</th></tr><tr><td>

```python
@tool
def create_ticket(title: str, description: str) -> str:
    """Open an IT helpdesk ticket and return its id.

    Args:
        title: One-line summary of the problem.
        description: What the user needs, in their own words.
    """
    ticket_id = f"TCK-{uuid.uuid4().hex[:8]}"
    print(f"ticket {ticket_id}: {title} ({len(description)} chars)")
    return ticket_id
```

</td><td>

```typescript
const createTicket = tool({
  name: "create_ticket",
  description: "Open an IT helpdesk ticket and return its id.",
  inputSchema: z.object({
    title: z.string().describe("One-line summary of the problem."),
    description: z.string().describe("What the user needs, in their own words."),
  }),
  callback: ({ title, description }) => {
    const ticketId = `TCK-${randomUUID().slice(0, 8)}`;
    console.log(`ticket ${ticketId}: ${title} (${description.length} chars)`);
    return ticketId;
  },
});
```

</td></tr></table>

Each session gets its own `Agent`, so each session is its own conversation. The entrypoint streams the answer's text back as server-sent events.

<table><tr><th>Python</th><th>TypeScript</th></tr><tr><td>

```python
app = BedrockAgentCoreApp()
agents: dict[str, Agent] = {}
...
def agent_for(session_id: str) -> Agent:
    """One agent (and so one conversation) per session."""
    if session_id not in agents:
        agents[session_id] = Agent(
            model=MODEL_ID, system_prompt=SYSTEM_PROMPT, tools=[create_ticket]
        )
    return agents[session_id]


@app.entrypoint
async def invoke(payload: dict[str, str], context: RequestContext) -> AsyncIterator[str]:
    agent = agent_for(context.session_id or "local")
    async for event in agent.stream_async(payload["prompt"]):
        if "data" in event:
            yield event["data"]


if __name__ == "__main__":
    app.run()  # serves /invocations and /ping on port 8080
```

</td><td>

```typescript
const agents = new Map<string, Agent>();
function agentFor(sessionId: string): Agent {
  let agent = agents.get(sessionId);
  if (!agent) {
    agent = new Agent({ model: MODEL_ID, systemPrompt: SYSTEM_PROMPT, tools: [createTicket] });
    agents.set(sessionId, agent);
  }
  return agent;
}

const app = new BedrockAgentCoreApp({
  invocationHandler: {
    requestSchema: z.object({ prompt: z.string() }),
    async *process(payload, context) {
      const agent = agentFor(context.sessionId || "local");
      for await (const event of agent.stream(payload.prompt)) {
        if (
          event.type === "modelStreamUpdateEvent" &&
          event.event.type === "modelContentBlockDeltaEvent" &&
          event.event.delta.type === "textDelta"
        ) {
          yield { data: event.event.delta.text };
        }
      }
    },
  },
});

app.run(); // serves /invocations and /ping on 0.0.0.0:8080
```

</td></tr></table>

On Runtime each session has its own microVM, so the map holds one agent. Locally it holds one per session id you send.

## Step 2: Run it locally

The local server calls Bedrock with your own AWS credentials.

<table><tr><th>Python</th><th>TypeScript</th></tr><tr><td>

```bash
cd examples/04-your-own-code/python
uv run python main.py
```

</td><td>

```bash
cd examples/04-your-own-code/typescript
npm install && npx tsc && npm start
```

</td></tr></table>

In a second terminal, check health, then send a prompt. The session header is how Runtime tells your code which conversation this is.

```bash
curl localhost:8080/ping
# {"status":"Healthy","time_of_last_update":...}

curl -N localhost:8080/invocations \
  -H 'Content-Type: application/json' \
  -H 'Accept: text/event-stream' \
  -H "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id: $(uuidgen)" \
  -d '{"prompt": "Please open a ticket: my VPN drops every hour."}'
# data: "I've"
# data: " opened ticket TCK-..."
```

The TypeScript app streams only when the request says `Accept: text/event-stream`. Inside an `agentcore` project (step 4), `agentcore dev` starts the same local server.

## Step 3: Package the code

The `agentcore` CLI builds the package for you (`agentcore deploy`, or `agentcore package` to build without deploying); skip this step if you use it. For the AWS CLI and Terraform, build a zip with the dependencies for Linux ARM64 and upload it to S3. Python runs on the managed `PYTHON_3_13` runtime, TypeScript on `NODE_22` (compiled to JavaScript first).

<table><tr><th>Python</th><th>TypeScript</th></tr><tr><td>

```bash
uv pip install --target build --python-platform aarch64-manylinux2014 --python-version 3.13 \
  --only-binary=:all: -r python/pyproject.toml
cp python/main.py build/
(cd build && zip -qr ../agent.zip .)
aws s3 cp agent.zip "s3://$BUCKET/$KEY"
```

</td><td>

```bash
(cd typescript && npm install && npx tsc)
cp -r typescript/dist typescript/package.json build/
(cd build && npm install --omit=dev --ignore-scripts)
(cd build && zip -qr ../agent.zip .)
aws s3 cp agent.zip "s3://$BUCKET/$KEY"
```

</td></tr></table>

**Terraform:** [`aws_s3_object`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/s3_object) can upload the zip; the example leaves that to CI and takes the bucket and key as variables.

## Step 4: Deploy it to Runtime

A deployment is two resources: an **execution role** (what the agent may do in AWS: call models, write logs) and the **agent runtime**, which points at the code.

<table><tr><th><code>agentcore</code> CLI</th><th>AWS CLI (<code>cli.sh</code>)</th><th>Terraform (<code>terraform/</code>)</th></tr><tr><td>

```bash
agentcore create \
  --project-name helpdeskcode \
  --name helpdesk \
  --framework Strands \
  --model-provider Bedrock \
  --memory none \
  --build CodeZip
# TypeScript: add --language TypeScript
# and copy main.ts instead
cp examples/04-your-own-code/python/main.py \
  helpdeskcode/app/helpdesk/main.py
cd helpdeskcode
agentcore deploy
```

</td><td>

```bash
aws iam create-role --role-name "$ROLE_NAME" --assume-role-policy-document "$TRUST_POLICY"
aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name helpdesk --policy-document "$ROLE_POLICY"

ARTIFACT=$(cat <<EOF
{"codeConfiguration": {"code": {"s3": {"bucket": "$BUCKET", "prefix": "$KEY"}},
  "runtime": "$RUNTIME", "entryPoint": $ENTRY_POINT}}
EOF
)
AGENT_ARN=$(aws bedrock-agentcore-control create-agent-runtime \
  --agent-runtime-name "$AGENT_NAME" \
  --role-arn "arn:aws:iam::$ACCOUNT_ID:role/$ROLE_NAME" \
  --agent-runtime-artifact "$ARTIFACT" \
  --network-configuration '{"networkMode": "PUBLIC"}' \
  --query agentRuntimeArn --output text)
```

</td><td>

```hcl
resource "aws_bedrockagentcore_agent_runtime" "helpdesk" {
  agent_runtime_name = "helpdesk_code"
  role_arn           = aws_iam_role.helpdesk.arn

  agent_runtime_artifact {
    code_configuration {
      runtime     = var.runtime
      entry_point = var.entry_point
      code {
        s3 {
          bucket = var.code_bucket
          prefix = var.code_key
        }
      }
    }
  }

  network_configuration {
    network_mode = "PUBLIC"
  }

  depends_on = [aws_iam_role_policy.helpdesk]
}
```

</td></tr></table>

**Terraform:** [`aws_bedrockagentcore_agent_runtime.helpdesk`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/bedrockagentcore_agent_runtime), [`aws_iam_role.helpdesk`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/iam_role), [`aws_iam_role_policy.helpdesk`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/iam_role_policy)

- The `agentcore` CLI builds the zip, creates the role and the runtime (as a CloudFormation stack), and records the ARN for `agentcore invoke`.
- The role's trust policy lets `bedrock-agentcore.amazonaws.com` assume it. Its permissions are `bedrock:InvokeModel*` on models and inference profiles, and CloudWatch Logs under `/aws/bedrock-agentcore/runtimes/`. `cli.sh` and `main.tf` have the full policies.
- `entryPoint` is `["main.py"]` for Python and `["dist/main.js"]` for TypeScript.
- To run a container instead of a zip, replace `codeConfiguration` with `containerConfiguration` (`containerUri` of an ARM64 image in ECR). In Terraform, that is `container_configuration { container_uri = ... }`; with the `agentcore` CLI, `--build Container`.
- AgentCore creates version 1, the `DEFAULT` endpoint and the agent's workload identity for you.

## Step 5: Invoke it

Wait until the runtime's status is `READY`. Callers with IAM credentials need `bedrock-agentcore:InvokeAgentRuntime` on the runtime; both `cli.sh` and `main.tf` create a policy for that.

<table><tr><th><code>agentcore</code> CLI</th><th>AWS CLI (<code>cli.sh</code>)</th><th>Terraform (<code>terraform/</code>)</th></tr><tr><td>

```bash
agentcore invoke \
  --session-id "$(uuidgen)" \
  "How much can I claim for meals on a 4-day trip?"
```

</td><td>

```bash
aws iam create-policy --policy-name helpdesk-code-invoke --policy-document "$INVOKE_POLICY"

aws bedrock-agentcore invoke-agent-runtime \
  --agent-runtime-arn "$AGENT_ARN" \
  --runtime-session-id "$SESSION_ID" \
  --content-type application/json \
  --accept text/event-stream \
  --payload fileb://prompt.json \
  answer.txt
```

The answer streams into `answer.txt`.

</td><td>

```hcl
resource "aws_iam_policy" "invoke" {
  name = "helpdesk-code-invoke"
  ...
      Action = ["bedrock-agentcore:InvokeAgentRuntime", "bedrock-agentcore:StopRuntimeSession"]
```

Terraform creates resources but doesn't invoke them. `terraform output agent_runtime_arn` prints the ARN for the other tools.

</td></tr></table>

**Terraform:** [`aws_iam_policy.invoke`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/iam_policy), [`aws_bedrockagentcore_agent_runtime.helpdesk`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/bedrockagentcore_agent_runtime)

## Step 6: Call the agent from code

Your application calls `InvokeAgentRuntime` with IAM credentials. Keep the session id to continue the same conversation; it must be at least 33 characters (a UUID is 36).

<table><tr><th>Python (<code>python/invoke.py</code>)</th><th>TypeScript (<code>typescript/invoke.ts</code>)</th></tr><tr><td>

```python
client = boto3.client("bedrock-agentcore", region_name="eu-west-1")


def ask(prompt: str, session_id: str) -> None:
    response = client.invoke_agent_runtime(
        agentRuntimeArn=AGENT_ARN,
        runtimeSessionId=session_id,  # same id = same VM = same conversation
        payload=json.dumps({"prompt": prompt}).encode(),
        contentType="application/json",
        accept="text/event-stream",
        qualifier="DEFAULT",
    )
    for line in response["response"].iter_lines():  # server-sent events: b'data: "..."'
        if line.startswith(b"data: "):
            print(json.loads(line[6:]), end="", flush=True)
    print()
```

</td><td>

```typescript
const client = new BedrockAgentCoreClient({ region: "eu-west-1" });

async function ask(prompt: string, sessionId: string): Promise<void> {
  const response = await client.send(
    new InvokeAgentRuntimeCommand({
      agentRuntimeArn: AGENT_ARN,
      runtimeSessionId: sessionId, // same id = same VM = same conversation
      payload: new TextEncoder().encode(JSON.stringify({ prompt })),
      contentType: "application/json",
      accept: "text/event-stream",
      qualifier: "DEFAULT",
    }),
  );
  let buffer = "";
  for await (const chunk of response.response as Readable) {
    buffer += String(chunk); // server-sent events: 'data: "..."' lines
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.startsWith("data: ")) process.stdout.write(String(JSON.parse(line.slice(6))));
    }
  }
  process.stdout.write("\n");
}
```

</td></tr></table>

**Terraform:** [`aws_iam_policy.invoke`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/iam_policy), [`aws_bedrockagentcore_agent_runtime.helpdesk`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/bedrockagentcore_agent_runtime)

```bash
cd examples/04-your-own-code/python
export AGENT_ARN=arn:aws:bedrock-agentcore:eu-west-1:111122223333:runtime/helpdesk_code-...
uv run python invoke.py "Please open a ticket: my VPN drops every hour."    # prints the session id
uv run python invoke.py "What was the ticket number?" <session-id>          # same conversation
# TypeScript: npx tsc && node dist/invoke.js "..." <session-id>
```

## What just happened

- Your code is the agent: `BedrockAgentCoreApp` serves `/invocations` and `/ping`, and a Strands `Agent` per session runs the loop.
- Runtime ran it from a zip in its own microVM per session id, with the execution role's permissions.
- The CLI, the AWS CLI and Terraform all create the same `AgentRuntime` resource; the CLI also builds the zip.

## Clean up

```bash
cd helpdeskcode && agentcore remove all && agentcore deploy     # the CLI project
./examples/04-your-own-code/cli.sh cleanup                      # the AWS CLI version
terraform -chdir=examples/04-your-own-code/terraform destroy    # the Terraform version
```

Next: [05. Conversations and caching](05-conversations-and-caching.md)
