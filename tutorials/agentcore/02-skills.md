# 02. Skills

You will: give the helpdesk a skill (instructions plus a script) that it loads only when a question needs it. You need: the harness from [01. Your first agent](01-first-agent.md). Cost: a few cents (Haiku tokens; S3 storage is negligible).

A **skill** is a folder with a `SKILL.md` file: a name and a description in front matter, then instructions. It can also hold `scripts/`, `references/` and `assets/`. This is the open [AgentSkills.io](https://agentskills.io/specification) format, the same one Claude Code uses.

The full files for this tutorial are in [`examples/02-skills/`](examples/02-skills/).

## Step 1: Write the skill

Put the policy in the skill, not in the system prompt. The agent reads it only when a question is about expenses.

```text
expense-policy/
├── SKILL.md
└── scripts/
    └── per_diem.py
```

`expense-policy/SKILL.md`. The `name` must match the folder name. The `description` is what the agent sees before it opens the skill, so say when to use it:

````markdown
---
name: expense-policy
description: Fintech Ltd expense rules (hotels, meals, taxis, claim deadlines) and how to compute a trip allowance. Use for any question about what can be expensed or how much.
---

# Expense policy

## Limits

- Hotels: up to 180 EUR per night in major cities (London, Paris, New York), 120 EUR elsewhere.
- Meals: up to 60 EUR per day, receipts required.
- Taxis: allowed to and from airports and stations, and after 21:00. Otherwise use public transport.
- Claims must be submitted within 30 days of the trip, with itemised receipts.

## Trip allowance

Do not add the numbers yourself. Run the script and quote its output:

```bash
python3 scripts/per_diem.py --days 4 --city-class major
```

`--city-class` is `major` or `standard`. Nights are days minus one.
````

The script does the arithmetic, so the model does not have to. It is one file, because it runs inside the agent's VM, but it has the same three parts as every example: **domain** types that can only hold valid values (`Days` from 1 to 90, a `CityClass` enum, an `Allowance` in whole euros), a pure **core** (`allowance`, `render`), and a small shell (`main`) that parses the arguments. The essential part of `expense-policy/scripts/per_diem.py`:

```python
@dataclass(frozen=True, slots=True)
class Days:
    """Trip length in days: 1 to 90."""

    count: int

    @classmethod
    def parse(cls, raw: str) -> Days:
        if not raw.isdigit() or not 1 <= int(raw) <= 90:
            raise ParseError(f"days must be a whole number from 1 to 90, not {raw!r}")
        return cls(int(raw))


HOTEL_CAP_EUR = {CityClass.MAJOR: 180, CityClass.STANDARD: 120}
MEALS_PER_DAY_EUR = 60


def allowance(days: Days, city: CityClass) -> Allowance:
    nights = days.count - 1
    return Allowance(nights, nights * HOTEL_CAP_EUR[city], days.count * MEALS_PER_DAY_EUR)
```

## Step 2: Test the script locally

The script runs in the agent's VM later. Check it on your machine first; it needs only Python.

```bash
python3 expense-policy/scripts/per_diem.py --days 4 --city-class major
# 4 days, 3 nights (major): hotel 540 EUR + meals 240 EUR = 780 EUR
```

## Step 3: Upload and attach the skill

The harness fetches skills from S3 with its execution role. So: store the folder in S3, let the role read it (`s3:GetObject`, `s3:ListBucket`), and add the skill to the harness. The bucket here is `fintech-agent-skills`; bucket names are global, so pick your own.

<table><tr><th>agentcore CLI</th><th>AWS CLI</th><th>Terraform</th></tr><tr><td>

The agentcore CLI does not create buckets or upload files: run the first two AWS CLI commands (next column). Then, in the project from tutorial 01:

```bash
agentcore add skill --harness helpdesk --s3 s3://fintech-agent-skills/expense-policy/
agentcore deploy
```

`add skill` adds `{"s3Uri": "s3://fintech-agent-skills/expense-policy/"}` to `skills` in `harness.json`. `deploy` also gives the role read access to the bucket.

</td><td>

```bash
aws s3api create-bucket --bucket "$BUCKET" \
  --create-bucket-configuration LocationConstraint="$AWS_REGION"
aws s3 sync expense-policy/ "s3://$BUCKET/expense-policy/"

aws iam put-role-policy --role-name "$ROLE" --policy-name skills \
  --policy-document file://iam/skills-policy.json
aws bedrock-agentcore-control update-harness --harness-id "$(harness_id)" \
  --skills "[{\"s3\":{\"uri\":\"s3://$BUCKET/expense-policy/\"}}]"
```

`--skills` replaces the whole list. Run it all with `./cli.sh up`; `harness_id` looks up the harness id by name.

</td><td>

```hcl
resource "aws_s3_bucket" "skills" {
  bucket = "fintech-agent-skills"
}

resource "aws_s3_object" "expense_policy" {
  for_each = fileset("${path.module}/../expense-policy", "**")

  bucket = aws_s3_bucket.skills.id
  key    = "expense-policy/${each.value}"
  source = "${path.module}/../expense-policy/${each.value}"
  etag   = filemd5("${path.module}/../expense-policy/${each.value}")
}

resource "aws_iam_role_policy" "skills" {
  role   = aws_iam_role.helpdesk.id
  name   = "skills"
  policy = file("${path.module}/../iam/skills-policy.json")
}

resource "aws_bedrockagentcore_harness" "helpdesk" {
  # ...
  skill {
    s3 {
      uri = "s3://${aws_s3_bucket.skills.id}/expense-policy/"
    }
  }
}
```

`# ...` is the harness from tutorial 01, unchanged.

</td></tr></table>

Terraform: [`aws_s3_bucket.skills`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/s3_bucket), [`aws_s3_object.expense_policy`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/s3_object), [`aws_iam_role_policy.skills`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/iam_role_policy), [`aws_bedrockagentcore_harness.helpdesk`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/bedrockagentcore_harness)

Full files: [`cli.sh`](examples/02-skills/cli.sh), [`terraform/main.tf`](examples/02-skills/terraform/main.tf) (tutorial 01's file plus the resources above).

## Step 4: Ask a question that needs the skill

<table><tr><th>agentcore CLI</th><th>AWS CLI</th><th>Terraform</th></tr><tr><td>

```bash
agentcore invoke --session-id "$(uuidgen)" "What is my maximum allowance for a 4-day trip to Paris?"
```

</td><td>

No `invoke-harness` in the AWS CLI. Use `agentcore invoke --harness-arn "$HARNESS_ARN" --region eu-west-1 "..."` or the code in step 5.

</td><td>

Terraform does not invoke. Use `agentcore invoke --harness-arn "$HARNESS_ARN" --region eu-west-1 "..."` or the code in step 5.

</td></tr></table>

Terraform: [`aws_bedrockagentcore_harness.helpdesk`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/bedrockagentcore_harness), [`aws_s3_object.expense_policy`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/s3_object)

The answer should be 780 EUR, taken from the script's output.

**How progressive disclosure works:**

1. On the first call of a session, the harness downloads every skill folder into the session's VM.
2. The system prompt gets only each skill's name and description (about 100 tokens per skill).
3. When a question matches a description, the model calls the `skills` tool with the skill's name. The tool returns the body of `SKILL.md` and a list of the skill's files.
4. The model runs `scripts/per_diem.py` with its built-in `shell` tool, inside the VM, and answers from the output.

So an unused skill costs only its description. The script's code never enters the context; only its output does. You can attach many skills to one agent.

## Step 5: Try a new version of the skill on one call

Every `InvokeHarness` call can add skills. They are added after the harness's own skills, and a skill with the same name replaces the harness's one. So you can test an edited skill without changing the harness.

Edit `expense-policy/SKILL.md`, then upload it to a drafts prefix (`./cli.sh draft`; the agentcore CLI does not upload files):

```bash
aws s3 sync expense-policy/ "s3://$BUCKET/drafts/expense-policy/"
```

Call the harness with the draft. The code is tutorial 01's, with two additions: a `SkillUri` domain type (an `s3://bucket/path/` folder) and two more stream events, `ToolCalled` and `ToolInputDelta`, so you can watch step 4 happen. `core.render` prints them; `core` is still pure.

The shell and the new part of the boundary parser:

<table><tr><th>Python</th><th>TypeScript</th></tr><tr><td>

```python
def ask(harness: HarnessArn, session: SessionId, question: Question, skill: SkillUri) -> int:
    client = boto3.client("bedrock-agentcore", region_name="eu-west-1")
    response = client.invoke_harness(
        harnessArn=harness.value,
        runtimeSessionId=session.value,
        skills=[{"s3": {"uri": skill.value}}],  # this call only; same name wins
        messages=[{"role": "user", "content": [{"text": question.text}]}],
    )
    events: list[StreamEvent] = []
    for raw in response["stream"]:
        event = parse_stream_event(raw)  # outside data -> domain type, right here
        if event is not None:
            events.append(event)
            print(render(event), end="", flush=True)
    return exit_code(events)
```

</td><td>

```typescript
async function ask(
  harness: HarnessArn,
  session: SessionId,
  question: Question,
  skill: SkillUri,
): Promise<number> {
  const client = new BedrockAgentCoreClient({ region: "eu-west-1" });
  const response = await client.send(
    new InvokeHarnessCommand({
      harnessArn: harness,
      runtimeSessionId: session,
      skills: [{ s3: { uri: skill } }], // this call only; same name wins
      messages: [{ role: "user", content: [{ text: question }] }],
    }),
  );
  const events: StreamEvent[] = [];
  for await (const raw of response.stream ?? []) {
    const event = parseStreamEvent(raw); // outside data -> domain type, right here
    if (event) {
      events.push(event);
      process.stdout.write(render(event));
    }
  }
  return exitCode(events);
}
```

</td></tr><tr><td>

`domain.py`:

```python
    if "contentBlockStart" in raw:
        start = _fields(_fields(raw["contentBlockStart"]).get("start", {}))
        name = _nonempty_str(_fields(start.get("toolUse", {})).get("name"))
        return ToolCalled(name) if name else None
    if "contentBlockDelta" in raw:
        delta = _fields(_fields(raw["contentBlockDelta"]).get("delta", {}))
        if "toolUse" in delta:
            text = _nonempty_str(_fields(delta["toolUse"]).get("input"))
            return ToolInputDelta(text) if text else None
        text = _nonempty_str(delta.get("text"))
        return TextDelta(text) if text else None
```

</td><td>

`domain.ts`:

```typescript
  if (raw.contentBlockStart) {
    const name = raw.contentBlockStart.start?.toolUse?.name;
    return name ? { kind: "toolCalled", name } : undefined;
  }
  if (raw.contentBlockDelta) {
    const delta = raw.contentBlockDelta.delta;
    if (delta?.toolUse) {
      const text = delta.toolUse.input;
      return text ? { kind: "toolInput", text } : undefined;
    }
    return delta?.text ? { kind: "text", text: delta.text } : undefined;
  }
```

</td></tr><tr><td>

```bash
cd python && uv sync
uv run python invoke_with_skill.py "Allowance for 4 days in Paris?"
```

</td><td>

```bash
cd typescript && npm install
npm run invoke -- "Allowance for 4 days in Paris?"
```

</td></tr></table>

Terraform: [`aws_s3_bucket.skills`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/s3_bucket), [`aws_bedrockagentcore_harness.helpdesk`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/bedrockagentcore_harness), [`aws_iam_policy.invoke`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/iam_policy)

Full files: [`python/`](examples/02-skills/python/) (`domain.py`, `core.py`, `invoke_with_skill.py`), [`typescript/`](examples/02-skills/typescript/) (`domain.ts`, `core.ts`, `invoke-with-skill.ts`). `HARNESS_ARN` is set as in tutorial 01, step 3. The caller needs the `helpdesk-invoke` policy from tutorial 01.

You should see a `skills` call with `{"skill_name": "expense-policy"}`, then a `shell` call that runs `per_diem.py`, then the answer. The exact tool arguments depend on the model. **[verify]** the tool names on a live harness: they come from the code that `agentcore export harness` generates.

With the agentcore CLI: `agentcore invoke --skills s3://fintech-agent-skills/drafts/expense-policy/ "..."`.

**Security:** whoever can invoke the harness can point it at any skill the execution role can read, and skills can run scripts. If your application passes user input to `InvokeHarness`, never let users set `skills`.

## What just happened

- The skill is a folder in S3. The harness copied it into each session's VM on the first call.
- The model saw only the skill's description until it needed the skill. Then it loaded the instructions and ran the script in its VM.
- A per-call `skills` list added a draft version without changing the harness.

## Clean up

<table><tr><th>agentcore CLI</th><th>AWS CLI</th><th>Terraform</th></tr><tr><td>

```bash
agentcore remove skill --harness helpdesk --s3 s3://fintech-agent-skills/expense-policy/
agentcore deploy
```

Then delete the bucket as in the AWS CLI column (last two commands).

</td><td>

```bash
aws bedrock-agentcore-control update-harness --harness-id "$(harness_id)" --skills '[]'
aws iam delete-role-policy --role-name "$ROLE" --policy-name skills
aws s3 rm "s3://$BUCKET" --recursive
aws s3api delete-bucket --bucket "$BUCKET"
```

Or `./cli.sh down`.

</td><td>

```bash
terraform destroy
```

</td></tr></table>

Next: [03. Tools and the Gateway](03-tools-and-gateway.md)
