# 01. Your first agent

You will: create the helpdesk agent as a harness, prompt it, and call it from your own code. You need: the tools in [Before you start](README.md#before-you-start) and AWS credentials for `eu-west-1`. Cost: a few cents (Haiku tokens and a few minutes of session VM; the harness itself is free).

A **harness** is an agent you configure instead of code: model, instructions, tools and skills. AWS runs the agent loop for you.

Every infrastructure step shows three ways to do it: the **agentcore CLI** (simplest), the **AWS CLI**, and **Terraform**. Pick one column and stay with it. The full files are in [`examples/01-first-agent/`](examples/01-first-agent/).

## Step 1: Write the configuration

Use Haiku while you learn: it is the cheapest Claude model. The limits stop a runaway loop from spending money. `global.` lets Bedrock serve the request from any region; if data must stay in the EU, use `eu.anthropic.claude-haiku-4-5-20251001-v1:0` (10% more expensive).

`harness.json`:

```json
{
  "name": "helpdesk",
  "model": {
    "provider": "bedrock",
    "modelId": "global.anthropic.claude-haiku-4-5-20251001-v1:0"
  },
  "tools": [],
  "skills": [],
  "memory": {
    "mode": "disabled"
  },
  "maxIterations": 20,
  "timeoutSeconds": 300
}
```

`system-prompt.md`:

```markdown
You are the internal IT and expenses helpdesk for Fintech Ltd.
Answer questions about expenses and IT policy briefly and precisely.
If you do not know the answer, say so. Never reveal credentials or personal data.
```

Both files are in [`examples/01-first-agent/harness/`](examples/01-first-agent/harness/). The agentcore CLI reads both. The AWS CLI and Terraform read `system-prompt.md` and set the other values as parameters.

## Step 2: Create the agent

A harness needs an **IAM execution role**: what the agent may do in AWS. Here: call Bedrock models, pull its runtime image, write logs and traces, and get its workload identity token ([`iam/harness-policy.json`](examples/01-first-agent/iam/harness-policy.json)). The agentcore CLI creates the role for you.

<table><tr><th>agentcore CLI</th><th>AWS CLI</th><th>Terraform</th></tr><tr><td>

```bash
npm install -g @aws/agentcore@0.30.0
agentcore create --project-name helpdesk --defaults
cd helpdesk
# edit app/helpdesk/harness.json and system-prompt.md as in step 1
agentcore validate

export AWS_REGION=eu-west-1
agentcore deploy
```

`create` writes a project folder; `deploy` turns it into a CloudFormation stack with the harness and its role.

</td><td>

```bash
aws iam create-role --role-name "$ROLE" \
  --assume-role-policy-document file://iam/trust-policy.json
aws iam put-role-policy --role-name "$ROLE" --policy-name harness \
  --policy-document file://iam/harness-policy.json

aws bedrock-agentcore-control create-harness \
  --harness-name helpdesk \
  --execution-role-arn "arn:aws:iam::$ACCOUNT:role/$ROLE" \
  --model "{\"bedrockModelConfig\":{\"modelId\":\"$MODEL\"}}" \
  --system-prompt "$(jq -n --rawfile t harness/system-prompt.md '[{text: $t}]')" \
  --memory '{"disabled":{}}' \
  --max-iterations 20 --timeout-seconds 300
```

Run it all with `./cli.sh up`. It sets `ROLE`, `ACCOUNT` and `MODEL`, and waits until the harness is `READY`.

</td><td>

```hcl
resource "aws_iam_role" "helpdesk" {
  name               = "helpdesk-harness"
  assume_role_policy = file("${path.module}/../iam/trust-policy.json")
}

resource "aws_iam_role_policy" "helpdesk" {
  role   = aws_iam_role.helpdesk.id
  name   = "harness"
  policy = file("${path.module}/../iam/harness-policy.json")
}

resource "aws_bedrockagentcore_harness" "helpdesk" {
  harness_name       = "helpdesk"
  execution_role_arn = aws_iam_role.helpdesk.arn

  model {
    bedrock_model_config {
      model_id = "global.anthropic.claude-haiku-4-5-20251001-v1:0"
    }
  }
  system_prompt {
    text = file("${path.module}/../harness/system-prompt.md")
  }
  memory {
    disabled {}
  }
  max_iterations  = 20
  timeout_seconds = 300

  depends_on = [aws_iam_role_policy.helpdesk]
}
```

Run `terraform init && terraform apply`.

</td></tr></table>

Terraform: [`aws_iam_role.helpdesk`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/iam_role), [`aws_iam_role_policy.helpdesk`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/iam_role_policy), [`aws_bedrockagentcore_harness.helpdesk`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/bedrockagentcore_harness)

- Nothing runs yet. You pay only when someone invokes the agent.
- The AWS CLI and Terraform set memory to `disabled` explicitly. Through the API the default is managed memory, which bills per event and needs more permissions.
- The agentcore CLI names the harness `helpdesk_helpdesk` (project and harness name); the other two name it `helpdesk`.

Full files: [`cli.sh`](examples/01-first-agent/cli.sh), [`terraform/main.tf`](examples/01-first-agent/terraform/main.tf).

## Step 3: Prompt it

Each session gets its own microVM. The same session id means the same VM and the same conversation; session ids must be at least 33 characters, so use a UUID. `--exec` runs a shell command in the session's VM without the model, so it costs no tokens: use it to prepare files before a prompt or to read results after one.

<table><tr><th>agentcore CLI</th><th>AWS CLI</th><th>Terraform</th></tr><tr><td>

```bash
SID=$(uuidgen)
agentcore invoke --session-id "$SID" "Can I expense a taxi to the airport?"
agentcore invoke --session-id "$SID" "And what if the flight is at 6 am?"
agentcore invoke --exec --session-id "$SID" "pwd && ls -la && python3 --version"

export HARNESS_ARN=$(jq -r '.targets[].resources.harnesses.helpdesk.harnessArn' agentcore/.cli/deployed-state.json)
```

</td><td>

The AWS CLI has no `invoke-harness` command (it cannot read the event stream). Use the agentcore CLI by ARN, or the code in step 4:

```bash
export HARNESS_ARN=...   # printed by ./cli.sh up
agentcore invoke --harness-arn "$HARNESS_ARN" --region eu-west-1 --session-id "$(uuidgen)" "Can I expense a taxi to the airport?"
```

</td><td>

Terraform creates resources; it does not invoke them. Use the agentcore CLI by ARN, or the code in step 4:

```bash
export HARNESS_ARN=$(terraform output -raw harness_arn)
agentcore invoke --harness-arn "$HARNESS_ARN" --region eu-west-1 --session-id "$(uuidgen)" "Can I expense a taxi to the airport?"
```

</td></tr></table>

Terraform: [`aws_bedrockagentcore_harness.helpdesk`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/bedrockagentcore_harness)

The second answer knows what "the flight" is, because it ran in the same session. A new id starts a fresh conversation in a fresh VM.

## Step 4: Call the agent from your application

Your application calls `InvokeHarness` with the harness ARN, a session id and the user's message. The answer streams back as events; print the text deltas.

<table><tr><th>Python (<code>boto3</code>)</th><th>TypeScript (<code>@aws-sdk/client-bedrock-agentcore</code>)</th></tr><tr><td>

```python
def ask(harness_arn: str, session_id: str, question: str) -> None:
    client = boto3.client("bedrock-agentcore", region_name="eu-west-1")
    response = client.invoke_harness(
        harnessArn=harness_arn,
        runtimeSessionId=session_id,  # same id = same VM and conversation
        messages=[{"role": "user", "content": [{"text": question}]}],
    )
    for event in response["stream"]:
        if "contentBlockDelta" in event:
            text = event["contentBlockDelta"]["delta"].get("text")
            if text:
                print(text, end="", flush=True)
        elif "messageStop" in event:
            print(f"\n[stop: {event['messageStop']['stopReason']}]")
        elif "runtimeClientError" in event:
            raise RuntimeError(event["runtimeClientError"].get("message"))
```

</td><td>

```typescript
async function ask(harnessArn: string, sessionId: string, question: string): Promise<void> {
  const response = await client.send(
    new InvokeHarnessCommand({
      harnessArn,
      runtimeSessionId: sessionId, // same id = same VM and conversation
      messages: [{ role: "user", content: [{ text: question }] }],
    }),
  );
  for await (const event of response.stream ?? []) {
    if (event.contentBlockDelta?.delta?.text) {
      process.stdout.write(event.contentBlockDelta.delta.text);
    } else if (event.messageStop) {
      console.log(`\n[stop: ${event.messageStop.stopReason}]`);
    } else if (event.runtimeClientError) {
      throw new Error(event.runtimeClientError.message);
    }
  }
}
```

</td></tr><tr><td>

```bash
cd python && uv sync
uv run python invoke.py "Can I expense a taxi?"
```

</td><td>

```bash
cd typescript && npm install
npm run invoke -- "Can I expense a taxi?"
```

</td></tr></table>

Terraform: [`aws_bedrockagentcore_harness.helpdesk`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/bedrockagentcore_harness), [`aws_iam_policy.invoke`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/iam_policy)

Full files: [`python/invoke.py`](examples/01-first-agent/python/invoke.py), [`typescript/invoke.ts`](examples/01-first-agent/typescript/invoke.ts). Pass a session id as the second argument to continue a conversation.

The caller needs `bedrock-agentcore:InvokeHarness` and `bedrock-agentcore:InvokeAgentRuntime` on the harness ARN. In Terraform, attach this policy to your application's role:

```hcl
resource "aws_iam_policy" "invoke" {
  name = "helpdesk-invoke"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["bedrock-agentcore:InvokeHarness", "bedrock-agentcore:InvokeAgentRuntime"]
      Resource = aws_bedrockagentcore_harness.helpdesk.arn
    }]
  })
}
```

`stopReason` tells you why the answer ended: `end_turn` is normal; `max_iterations_exceeded` and `timeout_exceeded` mean a limit from step 1 was hit.

## What just happened

- You created a harness and an IAM execution role. Nothing ran until the first invoke.
- Each session id got its own microVM. The conversation lived in that VM's memory; it stops after 15 minutes idle.
- `invoke_harness` / `InvokeHarnessCommand` is the same call the agentcore CLI makes. It streams events.

## Clean up

<table><tr><th>agentcore CLI</th><th>AWS CLI</th><th>Terraform</th></tr><tr><td>

```bash
agentcore remove all
agentcore deploy
```

The CLI sees an empty project, asks you to confirm, and deletes the stack.

</td><td>

```bash
aws bedrock-agentcore-control delete-harness --harness-id "$(harness_id)"
aws iam delete-role-policy --role-name "$ROLE" --policy-name harness
aws iam delete-role --role-name "$ROLE"
```

Or `./cli.sh down`.

</td><td>

```bash
terraform destroy
```

</td></tr></table>

Next: [02. Skills](02-skills.md)
