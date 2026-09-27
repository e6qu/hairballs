# 09. Observability, evals and costs

You will: see what the helpdesk agent did, score its answers, count its tokens, cap each run, and track its cost on its own bill line. You need: the helpdesk harness from [01](01-first-agent.md), deployed. Cost: CloudWatch logs about $0.57 per GB in eu-west-1; a built-in evaluation about $0.04 per scored session (≈15K judge tokens at $2.40/M in, $12/M out); inference profiles, tags and cost allocation are free.

The full, checked files are in [`examples/09-observability-evals-costs/`](examples/09-observability-evals-costs/).

## Step 1: Read logs and traces

Every harness invocation writes logs and OpenTelemetry traces to CloudWatch: each model call, tool call and shell command is a span. `agentcore deploy` turns on CloudWatch **Transaction Search** once per account, which traces need.

A harness runs on a Runtime agent that AgentCore creates for it. Its log group is `/aws/bedrock-agentcore/runtimes/<runtime id>-DEFAULT`; `get-harness` returns the runtime id. `traces list` shows one trace per invocation, and `traces get` downloads one as JSON. In the console, open CloudWatch → **GenAI Observability** → Bedrock AgentCore for sessions, traces, latency, tokens and errors per agent.

<table><tr><th>agentcore CLI</th><th>AWS CLI</th><th>Terraform</th></tr><tr><td>

```bash
agentcore logs --since 1h --level error
agentcore traces list --since 1h
agentcore traces get <traceId>
```

</td><td>

```bash
RUNTIME_ID=$(aws bedrock-agentcore-control get-harness --region "$REGION" --harness-id "$HARNESS_ID" \
  --query harness.environment.agentCoreRuntimeEnvironment.agentRuntimeId --output text)
aws logs tail "/aws/bedrock-agentcore/runtimes/$RUNTIME_ID-DEFAULT" --region "$REGION" --since 1h --follow
```

</td><td>

Nothing to create: AgentCore makes the log group. Terraform exposes the runtime id:

```hcl
locals {
  runtime = aws_bedrockagentcore_harness.helpdesk.environment_actual[0].agentcore_runtime_environment[0]
}
```

</td></tr></table>

Terraform: [`aws_bedrockagentcore_harness.helpdesk`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/bedrockagentcore_harness)

`agentcore logs`, `traces`, `run eval` and `add online-eval` select an agent with `--runtime`. This tutorial assumes they pick the harness when it is the only agent in the project. **[verify]** how they select a harness in a project with several agents.

## Step 2: Count the tokens of each call

Model tokens are 80–96% of the bill, so count them where you call the agent. The `InvokeHarness` stream carries `metadata` events with the usage. Add them up.

- `cacheReadInputTokens` are prompt-cache hits, at about 10% of the input price. A low number means the cache isn't working ([05](05-conversations-and-caching.md)).
- `cacheWriteInputTokens` cost 125% of the input price (5-minute cache).
- `inputTokens` are the uncached input tokens.

<table><tr><th>Python</th><th>TypeScript</th></tr><tr><td>

```python
def ask(prompt: str, session_id: str) -> dict[str, int]:
    response = client.invoke_harness(
        harnessArn=HARNESS_ARN,
        runtimeSessionId=session_id,
        messages=[{"role": "user", "content": [{"text": prompt}]}],
    )
    totals = dict.fromkeys(PRICE, 0)
    for event in response["stream"]:
        if "contentBlockDelta" in event:
            delta = event["contentBlockDelta"]["delta"]
            print(delta.get("text", ""), end="", flush=True)
        elif "metadata" in event:  # token usage of the model calls
            usage = event["metadata"]["usage"]
            totals["inputTokens"] += usage["inputTokens"]
            totals["outputTokens"] += usage["outputTokens"]
            totals["cacheReadInputTokens"] += usage.get("cacheReadInputTokens", 0)
            totals["cacheWriteInputTokens"] += usage.get("cacheWriteInputTokens", 0)
        elif "messageStop" in event:
            print(f"\n[stop: {event['messageStop']['stopReason']}]")
    return totals
```

</td><td>

```typescript
async function ask(prompt: string, sessionId: string): Promise<Totals> {
  const response = await client.send(
    new InvokeHarnessCommand({
      harnessArn: HARNESS_ARN,
      runtimeSessionId: sessionId,
      messages: [{ role: "user", content: [{ text: prompt }] }],
    }),
  );
  const totals: Totals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheWriteInputTokens: 0,
  };
  for await (const event of response.stream ?? []) {
    if (event.contentBlockDelta) {
      process.stdout.write(event.contentBlockDelta.delta?.text ?? "");
    } else if (event.metadata) {
      // token usage of the model calls
      const usage = event.metadata.usage;
      totals.inputTokens += usage?.inputTokens ?? 0;
      totals.outputTokens += usage?.outputTokens ?? 0;
      totals.cacheReadInputTokens += usage?.cacheReadInputTokens ?? 0;
      totals.cacheWriteInputTokens += usage?.cacheWriteInputTokens ?? 0;
    } else if (event.messageStop) {
      console.log(`\n[stop: ${event.messageStop.stopReason}]`);
    }
  }
  return totals;
}
```

</td></tr></table>

`usage.py` and `usage.ts` also turn the totals into dollars with the Haiku 4.5 prices. Ask the same question twice in one session: the second call should show cache reads. **[verify]** whether the stream sends one `metadata` event per model call or one per invocation; adding them up is right in both cases.

Terraform: [`aws_bedrockagentcore_harness.helpdesk`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/bedrockagentcore_harness), [`aws_iam_policy.helpdesk_caller`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/iam_policy) (the caller needs `InvokeHarness` and `InvokeAgentRuntime` on the harness)

## Step 3: Cap every run

A looping agent keeps calling the model. The harness stops an invocation at the first limit it reaches:

| Limit | Default | Stop reason in `messageStop` |
|---|---|---|
| `maxIterations`: model/tool cycles | 75 | `max_iterations_exceeded` |
| `maxTokens`: tokens per invocation | none | `max_output_tokens_exceeded` **[verify]** |
| `timeoutSeconds`: wall clock | 3600 | `timeout_exceeded` |
| `idleRuntimeSessionTimeout`: warm VM after the last call | 900 s | (the session ends) |
| `maxLifetime`: one session VM | 28800 s | (the session ends) |

Override them for one call with `agentcore invoke --max-iterations 5 --harness-timeout 120 "…"`, or with the same fields on `InvokeHarness`.

<table><tr><th>agentcore CLI</th><th>AWS CLI</th><th>Terraform</th></tr><tr><td>

In `app/helpdesk/harness.json`, then `agentcore deploy`:

```json
{
  "maxIterations": 20,
  "maxTokens": 100000,
  "timeoutSeconds": 600,
  "lifecycleConfig": { "idleRuntimeSessionTimeout": 300, "maxLifetime": 3600 }
}
```

</td><td>

```bash
aws bedrock-agentcore-control update-harness --region "$REGION" --harness-id "$HARNESS_ID" \
  --max-iterations 20 --max-tokens 100000 --timeout-seconds 600 \
  --environment '{"agentCoreRuntimeEnvironment":{"lifecycleConfiguration":{"idleRuntimeSessionTimeout":300,"maxLifetime":3600}}}'
```

</td><td>

```hcl
  max_iterations  = 20     # model/tool cycles per invocation (default 75)
  max_tokens      = 100000 # token budget per invocation (default: none)
  timeout_seconds = 600    # wall clock per invocation (default 3600)

  environment {
    agentcore_runtime_environment {
      lifecycle_configuration = [{
        idle_runtime_session_timeout = 300  # stop paying for memory 5 min after the last call
        max_lifetime                 = 3600 # (default 28800)
      }]
    }
  }
```

</td></tr></table>

Terraform: [`aws_bedrockagentcore_harness.helpdesk`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/bedrockagentcore_harness)

A shorter idle timeout matters: the session VM's memory is billed until the session ends, even when nobody is talking to it.

## Step 4: Give the agent its own bill line

Bedrock bills tokens per model, not per agent. An **application inference profile** is a named copy of a model (or of a global profile) that carries your tags. Point the agent at it, and its tokens appear under those tags in Cost Explorer and the Cost and Usage Report.

<table><tr><th>agentcore CLI</th><th>AWS CLI</th><th>Terraform</th></tr><tr><td>

Not in the `agentcore` CLI: it has no inference profiles. Create the profile with the AWS CLI or Terraform, then point `harness.json` at it and `agentcore deploy`:

```json
{
  "model": {
    "provider": "bedrock",
    "modelId": "arn:aws:bedrock:eu-west-1:111122223333:application-inference-profile/abc123"
  },
  "tags": { "agent": "helpdesk", "team": "it-support" }
}
```

</td><td>

```bash
PROFILE_ARN=$(aws bedrock create-inference-profile --region "$REGION" \
  --inference-profile-name helpdesk-haiku \
  --description "Every model call of the helpdesk agent" \
  --model-source "copyFrom=arn:aws:bedrock:$REGION:$ACCOUNT:inference-profile/$MODEL" \
  --tags key=agent,value=helpdesk key=team,value=it-support key=cost-centre,value=cc-1234 \
  --query inferenceProfileArn --output text)
aws bedrock-agentcore-control update-harness --region "$REGION" --harness-id "$HARNESS_ID" \
  --model "{\"bedrockModelConfig\":{\"modelId\":\"$PROFILE_ARN\"}}"
```

</td><td>

```hcl
resource "aws_bedrock_inference_profile" "helpdesk" {
  name        = "helpdesk-haiku"
  description = "Every model call of the helpdesk agent"
  model_source {
    copy_from = "arn:aws:bedrock:${var.region}:${local.account}:inference-profile/${local.model}"
  }
  tags = local.tags
}

resource "aws_bedrockagentcore_harness" "helpdesk" {
  harness_name       = "helpdesk"
  execution_role_arn = data.aws_iam_role.helpdesk.arn

  model {
    bedrock_model_config {
      model_id = aws_bedrock_inference_profile.helpdesk.arn
    }
  }
  # ...
  tags = local.tags # propagate to the managed Runtime, endpoint and Memory
}
```

</td></tr></table>

Terraform: [`aws_bedrock_inference_profile.helpdesk`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/bedrock_inference_profile), [`aws_bedrockagentcore_harness.helpdesk`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/bedrockagentcore_harness), [`aws_iam_role_policy.helpdesk_profile`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/iam_role_policy)

- **Permissions.** The agent's execution role needs `bedrock:InvokeModel*` on the profile ARN, the global profile and the underlying model (`aws_iam_role_policy.helpdesk_profile` in `main.tf`).
- **Where it works.** Profiles work with `Converse` and `InvokeModel`, which the harness uses by default (`apiFormat: converse_stream`). The `responses` and `chat_completions` formats reject them. **[verify]** that the harness accepts a profile ARN as `modelId`.
- **One profile per agent and model.** For EU data residency, copy an `eu.` profile instead of `global.`: it costs 10% more.
- **Harness tags** reach the Runtime, endpoint and Memory that AgentCore creates for it; tag your Gateway and storage yourself.

## Step 5: Alert on the agent's spend

Activate the `agent` tag for cost allocation (once, it takes up to 24 hours to show), then budget on it:

<table><tr><th>agentcore CLI</th><th>AWS CLI</th><th>Terraform</th></tr><tr><td>

Not in the `agentcore` CLI: budgets and cost allocation tags are Billing resources. Closest: `tags` in `harness.json` (Step 4) sets the tag the budget filters on.

</td><td>

```bash
aws ce update-cost-allocation-tags-status \
  --cost-allocation-tags-status TagKey=agent,Status=Active
aws budgets create-budget --account-id "$ACCOUNT" \
  --budget '{"BudgetName":"agent-helpdesk","BudgetType":"COST","TimeUnit":"MONTHLY","BudgetLimit":{"Amount":"50","Unit":"USD"},"CostFilters":{"TagKeyValue":["user:agent$helpdesk"]}}' \
  --notifications-with-subscribers "[{\"Notification\":{\"NotificationType\":\"FORECASTED\",\"ComparisonOperator\":\"GREATER_THAN\",\"Threshold\":80,\"ThresholdType\":\"PERCENTAGE\"},\"Subscribers\":[{\"SubscriptionType\":\"EMAIL\",\"Address\":\"$EMAIL\"}]}]"
```

</td><td>

```hcl
resource "aws_ce_cost_allocation_tag" "agent" {
  tag_key = "agent"
  status  = "Active"
}

resource "aws_budgets_budget" "helpdesk" {
  name         = "agent-helpdesk"
  budget_type  = "COST"
  limit_amount = "50"
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  cost_filter {
    name   = "TagKeyValue"
    values = ["user:agent$helpdesk"]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.budget_email]
  }
}
```

</td></tr></table>

Terraform: [`aws_ce_cost_allocation_tag.agent`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/ce_cost_allocation_tag), [`aws_budgets_budget.helpdesk`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/budgets_budget)

A budget only alerts; it does not stop the agent. The limits in Step 3 are what stop a run.

## Step 6: Score a session on demand

AgentCore **Evaluations** reads a session's spans and asks a judge model to score them. Built-in evaluators include `Builtin.GoalSuccessRate` (did the user get what they asked for), `Builtin.Helpfulness`, `Builtin.Correctness` and `Builtin.ToolSelectionAccuracy`. Spans take a few minutes to arrive in CloudWatch.

```bash
agentcore run eval --session-id "$SID" --evaluator Builtin.GoalSuccessRate Builtin.Helpfulness
```

From code, the Python SDK collects the spans for you. In TypeScript, query them from CloudWatch Logs (`sessionSpans` in `evaluate.ts`) and pass them to `Evaluate`:

<table><tr><th>Python</th><th>TypeScript</th></tr><tr><td>

```python
evaluations = EvaluationClient(region_name="eu-west-1")
results = evaluations.run(
    evaluator_ids=EVALUATORS,
    session_id=sys.argv[1],
    # Spans come from aws/spans and /aws/bedrock-agentcore/runtimes/<id>-DEFAULT.
    agent_id=runtime_id(HARNESS_ID),
)
for result in results:
    print(result["evaluatorId"], result.get("value"), result.get("label"))
    print("  ", result.get("explanation", "")[:200])
```

</td><td>

```typescript
const spans = await sessionSpans(await runtimeId(HARNESS_ID), sessionId);
for (const evaluatorId of EVALUATORS) {
  const { evaluationResults } = await agentcore.send(
    new EvaluateCommand({ evaluatorId, evaluationInput: { sessionSpans: spans } }),
  );
  for (const result of evaluationResults ?? []) {
    console.log(result.evaluatorId, result.value, result.label);
    console.log("  ", (result.explanation ?? "").slice(0, 200));
  }
}
```

</td></tr></table>

Terraform: [`aws_iam_policy.helpdesk_evaluator`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/iam_policy) (what the code above needs: `GetHarness`, `Evaluate`, and the Logs query)

Each result has a score (`value`), a `label` and the judge's `explanation`. Add ground truth when you have it: `agentcore run eval --assertion "…" --expected-trajectory tickets___create_ticket`.

## Step 7: Score sessions continuously

An **online evaluation** samples finished sessions and scores them as they happen. Results go to CloudWatch next to the traces. Sample a few percent: every scored session costs judge tokens.

The service needs a role it can assume to read the spans and write results. Its trust and permissions are in `cli.sh` and `main.tf`.

<table><tr><th>agentcore CLI</th><th>AWS CLI</th><th>Terraform</th></tr><tr><td>

```bash
agentcore add online-eval --name helpdesk_online --evaluator Builtin.GoalSuccessRate Builtin.Helpfulness \
  --sampling-rate 5 --enable-on-create
agentcore deploy
```

The CLI creates the role on deploy.

</td><td>

```bash
aws bedrock-agentcore-control create-online-evaluation-config --region "$REGION" \
  --online-evaluation-config-name helpdesk_online \
  --rule '{"samplingConfig":{"samplingPercentage":5}}' \
  --data-source-config "{\"cloudWatchLogs\":{\"logGroupNames\":[\"/aws/bedrock-agentcore/runtimes/$RUNTIME_ID-DEFAULT\"],\"serviceNames\":[\"$RUNTIME_NAME.DEFAULT\"]}}" \
  --evaluators '[{"evaluatorId":"Builtin.GoalSuccessRate"},{"evaluatorId":"Builtin.Helpfulness"}]' \
  --evaluation-execution-role-arn "arn:aws:iam::$ACCOUNT:role/helpdesk-evaluations" \
  --enable-on-create
```

</td><td>

```hcl
resource "aws_bedrockagentcore_online_evaluation_config" "helpdesk" {
  online_evaluation_config_name = "helpdesk_online"
  evaluation_execution_role_arn = aws_iam_role.evaluations.arn
  enable_on_create              = true

  rule {
    sampling_config {
      sampling_percentage = 5
    }
  }

  data_source_config {
    cloudwatch_logs {
      log_group_names = ["/aws/bedrock-agentcore/runtimes/${local.runtime.agent_runtime_id}-DEFAULT"]
      service_names   = ["${local.runtime.agent_runtime_name}.DEFAULT"]
    }
  }

  evaluator {
    evaluator_id = "Builtin.GoalSuccessRate"
  }
  evaluator {
    evaluator_id = "Builtin.Helpfulness"
  }
}
```

</td></tr></table>

Terraform: [`aws_bedrockagentcore_online_evaluation_config.helpdesk`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/bedrockagentcore_online_evaluation_config), [`aws_iam_role.evaluations`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/iam_role), [`aws_iam_role_policy.evaluations`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/iam_role_policy)

The service name is `<runtime name>.<endpoint>`. **[verify]** that this holds for the runtime behind a harness. Follow the scores with `agentcore logs evals`.

## What just happened

- Logs, traces and token counts showed what each invocation did and what it cost, cache hits included.
- Limits capped every invocation; a tagged inference profile and a budget put the agent on its own bill line.
- Evaluations scored sessions: one on demand, and a sample of all sessions continuously.

## Clean up

```bash
agentcore remove online-eval --name helpdesk_online --yes && agentcore deploy
# AWS CLI: the clean_up function in examples/09-observability-evals-costs/cli.sh
# Terraform: terraform destroy (it also removes the harness it manages)
```

Next: [10. A coding agent](10-coding-agent.md)
