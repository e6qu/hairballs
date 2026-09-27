# 01. Your first agent

You will: create the helpdesk agent as a harness, deploy it, prompt it, and call it from your own code. You need: the tools in [Before you start](README.md#before-you-start) and AWS credentials for `eu-west-1`. Cost: a few cents (Haiku tokens and a few minutes of session VM; the harness itself is free).

A **harness** is an agent you configure instead of code: model, instructions, tools and skills in one JSON file. AWS runs the agent loop for you.

The full files for this tutorial are in [`examples/01-first-agent/`](examples/01-first-agent/).

## Step 1: Create the project

The CLI writes a project folder. Nothing is created in AWS yet.

```bash
npm install -g @aws/agentcore@0.30.0
agentcore create --project-name helpdesk --defaults
cd helpdesk
```

The agent lives in `app/helpdesk/`: `harness.json` (the configuration) and `system-prompt.md` (the instructions).

## Step 2: Configure the agent

Use Haiku while you learn: it is the cheapest Claude model. The limits stop a runaway loop from spending money.

`app/helpdesk/harness.json`:

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

Both files are also in [`examples/01-first-agent/harness/`](examples/01-first-agent/harness/).

`global.` lets Bedrock serve the request from any region. If data must stay in the EU, use `eu.anthropic.claude-haiku-4-5-20251001-v1:0` (10% more expensive).

`app/helpdesk/system-prompt.md`:

```markdown
You are the internal IT and expenses helpdesk for Fintech Ltd.
Answer questions about expenses and IT policy briefly and precisely.
If you do not know the answer, say so. Never reveal credentials or personal data.
```

Check the files before you deploy:

```bash
agentcore validate
```

## Step 3: Deploy

The CLI turns the project into a CloudFormation stack: the harness and its IAM execution role. It deploys to the region in `AWS_REGION`.

```bash
export AWS_REGION=eu-west-1
agentcore deploy
```

Nothing runs yet. You pay only when someone invokes the agent.

## Step 4: Prompt it

Each session gets its own microVM. The same session id means the same VM and the same conversation. Session ids must be at least 33 characters, so use a UUID.

```bash
SID=$(uuidgen)
agentcore invoke --session-id "$SID" "Can I expense a taxi to the airport?"
agentcore invoke --session-id "$SID" "And what if the flight is at 6 am?"
```

The second answer knows what "the flight" is, because it ran in the same session. A new id starts a fresh conversation in a fresh VM.

## Step 5: Run a command in the session

`--exec` runs a shell command in the session's VM. No model is involved, so it costs no tokens. Use it to prepare files before a prompt or to read results after one.

```bash
agentcore invoke --exec --session-id "$SID" "pwd && ls -la && python3 --version"
```

## Step 6: Call the agent from your application

Your application calls `InvokeHarness` with the harness ARN, a session id and the user's message. The answer streams back as events; print the text deltas.

The CLI saved the ARN when it deployed:

```bash
export HARNESS_ARN=$(jq -r '.targets[].resources.harnesses.helpdesk.harnessArn' agentcore/.cli/deployed-state.json)
```

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

Full files: [`python/invoke.py`](examples/01-first-agent/python/invoke.py), [`typescript/invoke.ts`](examples/01-first-agent/typescript/invoke.ts). Pass a session id as the second argument to continue a conversation.

The caller needs `bedrock-agentcore:InvokeHarness` and `bedrock-agentcore:InvokeAgentRuntime` on the harness ARN.

`stopReason` tells you why the answer ended: `end_turn` is normal; `max_iterations_exceeded` and `timeout_exceeded` mean a limit from step 2 was hit.

## Step 7: The same agent without the agentcore CLI

The CLI only generates CloudFormation. You can create the same two things yourself: an IAM execution role and the harness. Both columns read the role policies from [`iam/`](examples/01-first-agent/iam/) and the instructions from `harness/system-prompt.md`.

The role lets the harness call Bedrock models, pull its runtime image, write logs and traces, and get its workload identity token. See [`iam/harness-policy.json`](examples/01-first-agent/iam/harness-policy.json).

<table><tr><th>AWS CLI</th><th>Terraform</th></tr><tr><td>

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

</td></tr><tr><td>

```bash
./cli.sh up     # prints the harness ARN
```

</td><td>

```bash
terraform init && terraform apply
terraform output harness_arn
```

</td></tr></table>

Full files: [`cli.sh`](examples/01-first-agent/cli.sh) (it sets `ROLE`, `ACCOUNT` and `MODEL` at the top, and waits for the harness to be `READY`), [`terraform/main.tf`](examples/01-first-agent/terraform/main.tf).

- Set memory to `disabled` explicitly. Through the API the default is managed memory, which bills per event and needs more permissions.
- The AWS CLI has **no `invoke-harness` command**: it cannot read the event stream. Invoke with the Python or TypeScript client from step 6, or with the agentcore CLI by ARN:

  ```bash
  agentcore invoke --harness-arn "$HARNESS_ARN" --region eu-west-1 --session-id "$(uuidgen)" "Hello"
  ```

## What just happened

- `agentcore deploy` created a harness and an IAM role. Nothing ran until the first invoke.
- Each session id got its own microVM. The conversation lived in that VM's memory; it stops after 15 minutes idle.
- `invoke_harness` / `InvokeHarnessCommand` is the same call the CLI makes. It streams events.

## Clean up

Remove everything from the project, then deploy. The CLI sees an empty project, asks you to confirm, and deletes the stack:

```bash
agentcore remove all
agentcore deploy
```

If you used step 7: `./cli.sh down` or `terraform destroy`.

Next: [02. Skills](02-skills.md)
