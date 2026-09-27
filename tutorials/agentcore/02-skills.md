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

The script does the arithmetic, so the model does not have to. `expense-policy/scripts/per_diem.py`, the essential part:

```python
HOTEL_CAP_EUR = {"major": 180, "standard": 120}
MEALS_PER_DAY_EUR = 60


def allowance(days: int, city_class: str) -> dict[str, int]:
    nights = max(days - 1, 0)
    hotel = nights * HOTEL_CAP_EUR[city_class]
    meals = days * MEALS_PER_DAY_EUR
    return {"nights": nights, "hotel_eur": hotel, "meals_eur": meals, "total_eur": hotel + meals}
```

## Step 2: Test the script locally

The script runs in the agent's VM later. Check it on your machine first; it needs only Python.

```bash
python3 expense-policy/scripts/per_diem.py --days 4 --city-class major
# 4 days, 3 nights (major): hotel 540 EUR + meals 240 EUR = 780 EUR
```

## Step 3: Upload it to S3

The harness fetches skills from S3 with its execution role.

```bash
aws s3api create-bucket --bucket "$BUCKET" \
  --create-bucket-configuration LocationConstraint="$AWS_REGION"
aws s3 sync expense-policy/ "s3://$BUCKET/expense-policy/"
```

Here `BUCKET=fintech-agent-skills` and `AWS_REGION=eu-west-1`. Bucket names are global: pick your own.

## Step 4: Attach it to the harness

In the agentcore project from tutorial 01. The CLI also gives the execution role `s3:GetObject` and `s3:ListBucket` on the bucket.

```bash
agentcore add skill --harness helpdesk --s3 s3://fintech-agent-skills/expense-policy/
agentcore deploy
```

`app/helpdesk/harness.json` now has:

```json
"skills": [
  {
    "s3Uri": "s3://fintech-agent-skills/expense-policy/"
  }
]
```

Without the agentcore CLI, do the same two things yourself: allow the role to read the bucket, and add the skill to the harness.

<table><tr><th>AWS CLI</th><th>Terraform</th></tr><tr><td>

```bash
aws iam put-role-policy --role-name "$ROLE" --policy-name skills \
  --policy-document file://iam/skills-policy.json
aws bedrock-agentcore-control update-harness --harness-id "$(harness_id)" \
  --skills "[{\"s3\":{\"uri\":\"s3://$BUCKET/expense-policy/\"}}]"
```

`--skills` replaces the whole list. `harness_id` looks up the harness id by name (see `cli.sh`). The policy allows `s3:GetObject` and `s3:ListBucket` on the bucket.

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

</td></tr></table>

Full files: [`cli.sh`](examples/02-skills/cli.sh), [`terraform/main.tf`](examples/02-skills/terraform/main.tf). The Terraform file is tutorial 01's plus the four resources above; `# ...` marks the unchanged harness settings.

## Step 5: Ask a question that needs the skill

```bash
agentcore invoke --session-id "$(uuidgen)" "What is my maximum allowance for a 4-day trip to Paris?"
```

The answer should be 780 EUR, taken from the script's output.

**How progressive disclosure works:**

1. On the first call of a session, the harness downloads every skill folder into the session's VM.
2. The system prompt gets only each skill's name and description (about 100 tokens per skill).
3. When a question matches a description, the model calls the `skills` tool with the skill's name. The tool returns the body of `SKILL.md` and a list of the skill's files.
4. The model runs `scripts/per_diem.py` with its built-in `shell` tool, inside the VM, and answers from the output.

So an unused skill costs only its description. The script's code never enters the context; only its output does. You can attach many skills to one agent.

## Step 6: Try a new version of the skill on one call

Every `InvokeHarness` call can add skills. They are added after the harness's own skills, and a skill with the same name replaces the harness's one. So you can test an edited skill without changing the harness.

Edit `expense-policy/SKILL.md`, then upload it to a drafts prefix:

```bash
aws s3 sync expense-policy/ "s3://$BUCKET/drafts/expense-policy/"
```

Call the harness with the draft. The code also prints each tool call, so you can watch step 5 happen.

<table><tr><th>Python</th><th>TypeScript</th></tr><tr><td>

```python
response = client.invoke_harness(
    harnessArn=harness_arn,
    runtimeSessionId=str(uuid.uuid4()),
    skills=[{"s3": {"uri": skill_uri}}],  # this call only; same name wins
    messages=[{"role": "user", "content": [{"text": question}]}],
)
for event in response["stream"]:
    if "contentBlockStart" in event:
        tool_use = event["contentBlockStart"]["start"].get("toolUse")
        if tool_use:
            print(f"\n[tool {tool_use['name']}] ", end="")
    elif "contentBlockDelta" in event:
        delta = event["contentBlockDelta"]["delta"]
        if "toolUse" in delta:
            print(delta["toolUse"]["input"], end="")  # the tool's arguments
        elif "text" in delta:
            print(delta["text"], end="", flush=True)
```

</td><td>

```typescript
const response = await client.send(
  new InvokeHarnessCommand({
    harnessArn,
    runtimeSessionId: randomUUID(),
    skills: [{ s3: { uri: skillUri } }], // this call only; same name wins
    messages: [{ role: "user", content: [{ text: question }] }],
  }),
);
for await (const event of response.stream ?? []) {
  const toolUse = event.contentBlockStart?.start?.toolUse;
  const delta = event.contentBlockDelta?.delta;
  if (toolUse) {
    process.stdout.write(`\n[tool ${toolUse.name}] `);
  } else if (delta?.toolUse) {
    process.stdout.write(delta.toolUse.input ?? ""); // the tool's arguments
  } else if (delta?.text) {
    process.stdout.write(delta.text);
  }
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

Full files: [`python/invoke_with_skill.py`](examples/02-skills/python/invoke_with_skill.py), [`typescript/invoke-with-skill.ts`](examples/02-skills/typescript/invoke-with-skill.ts). `HARNESS_ARN` is set as in tutorial 01, step 6.

You should see a `skills` call with `{"skill_name": "expense-policy"}`, then a `shell` call that runs `per_diem.py`, then the answer. The exact tool arguments depend on the model. **[verify]** the tool names on a live harness: they come from the code that `agentcore export harness` generates.

The agentcore CLI can do the same: `agentcore invoke --skills s3://fintech-agent-skills/drafts/expense-policy/ "..."`.

**Security:** whoever can invoke the harness can point it at any skill the execution role can read, and skills can run scripts. If your application passes user input to `InvokeHarness`, never let users set `skills`.

## What just happened

- The skill is a folder in S3. The harness copied it into each session's VM on the first call.
- The model saw only the skill's description until it needed the skill. Then it loaded the instructions and ran the script in its VM.
- A per-call `skills` list added a draft version without changing the harness.

## Clean up

```bash
agentcore remove skill --harness helpdesk --s3 s3://fintech-agent-skills/expense-policy/
agentcore deploy
aws s3 rm "s3://$BUCKET" --recursive
aws s3api delete-bucket --bucket "$BUCKET"
```

If you used the AWS CLI: `./cli.sh down`. With Terraform: `terraform destroy`.

Next: [03. Tools and the Gateway](03-tools-and-gateway.md)
