# 05. Conversations and caching

You will: keep a conversation going across calls and across session VMs, fork it, and cut token costs with the prompt cache. You need: [04. Your own code](04-your-own-code.md) deployed. Cost: cents. Memory costs $0.25 per 1,000 events (one per message); a cached Haiku 4.5 input token costs $0.10 per million instead of $1.

Full source: [`examples/05-conversations-and-caching/`](examples/05-conversations-and-caching/).

## Step 1: One session id, one conversation

Runtime routes every call with the same session id to the same microVM. The agent from tutorial 04 keeps one `Agent` per session in that VM, so the same id continues the conversation and a new id starts a fresh one.

```bash
cd examples/04-your-own-code/python
uv run python invoke.py "My name is Alice. What is the hotel limit per night?"   # prints the session id
uv run python invoke.py "What is my name?" <session-id>                           # "Alice"
uv run python invoke.py "What is my name?"                                        # a new session: it doesn't know
```

**Terraform:** [`aws_bedrockagentcore_agent_runtime.helpdesk`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/bedrockagentcore_agent_runtime), [`aws_iam_policy.invoke`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/iam_policy) (tutorial 04)

The VM stops after 15 minutes idle (at most 8 hours), and the thread goes with it. There are three places a thread can live:

| Where | How | Survives the VM? |
|---|---|---|
| The session VM | The `Agent`'s message list in memory (tutorial 04) | No |
| Your application | The caller stores the messages and sends them each time (`InvokeHarness` takes a `messages` list) | Yes |
| AgentCore Memory | Each message is an **event**, keyed by user (`actorId`) and session | Yes, until the events expire |

The rest of this tutorial uses Memory.

## Step 2: Create a Memory

A Memory holds events. Short-term memory is just those events; you add long-term strategies (facts, preferences, summaries) later if you need them. The agent's role must be allowed to use the memory, and the agent must know its id.

<table><tr><th><code>agentcore</code> CLI</th><th>AWS CLI (<code>cli.sh</code>)</th><th>Terraform (<code>terraform/main.tf</code>)</th></tr><tr><td>

```bash
# in the project from tutorial 04
agentcore add memory \
  --name helpdesk_memory \
  --expiry 30
agentcore deploy
```

The CLI grants every memory to every agent in the project and passes its id as `MEMORY_HELPDESK_MEMORY_ID`.

For a harness, set `"memory": { "mode": "managed" }` in `harness.json` (or `--memory-mode managed` on `agentcore add harness`) and deploy. No code needed.

</td><td>

```bash
MEMORY_ID=$(aws bedrock-agentcore-control create-memory \
  --name helpdesk_memory \
  --event-expiry-duration 30 \
  --query memory.id --output text)
aws bedrock-agentcore-control wait memory-created --memory-id "$MEMORY_ID"

aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name helpdesk-memory --policy-document "$MEMORY_POLICY"

AGENT_ARN=$(aws bedrock-agentcore-control update-agent-runtime \
  --agent-runtime-id "$AGENT_ID" \
  --role-arn "arn:aws:iam::$ACCOUNT_ID:role/$ROLE_NAME" \
  --agent-runtime-artifact "$ARTIFACT" \
  --network-configuration '{"networkMode": "PUBLIC"}' \
  --environment-variables "MEMORY_HELPDESK_MEMORY_ID=$MEMORY_ID" \
  --query agentRuntimeArn --output text)
```

`update-agent-runtime` replaces the whole configuration, so it repeats the artifact, role and network settings from tutorial 04.

</td><td>

```hcl
resource "aws_bedrockagentcore_memory" "helpdesk" {
  name                  = "helpdesk_memory"
  event_expiry_duration = 30 # days to keep each message event
}

resource "aws_iam_role_policy" "helpdesk_memory" {
  role = aws_iam_role.helpdesk.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "bedrock-agentcore:CreateEvent",
        "bedrock-agentcore:GetEvent",
        "bedrock-agentcore:ListEvents",
        "bedrock-agentcore:RetrieveMemoryRecords",
      ]
      Resource = aws_bedrockagentcore_memory.helpdesk.arn
    }]
  })
}
```

In `aws_bedrockagentcore_agent_runtime.helpdesk`:

```hcl
  # The agent reads the memory id from this variable.
  environment_variables = {
    MEMORY_HELPDESK_MEMORY_ID = aws_bedrockagentcore_memory.helpdesk.id
  }
```

The folder is the complete stack: tutorial 04's runtime plus the memory.

</td></tr></table>

**Terraform:** [`aws_bedrockagentcore_memory.helpdesk`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/bedrockagentcore_memory), [`aws_iam_role_policy.helpdesk_memory`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/iam_role_policy), [`aws_bedrockagentcore_agent_runtime.helpdesk`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/bedrockagentcore_agent_runtime); for a harness, [`aws_bedrockagentcore_harness`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/bedrockagentcore_harness) (`memory { managed_memory_configuration {} }`)

## Step 3: Write and read a thread from code

One message is one event: a `conversational` payload with a role and text, stored under a user id and a session id. Key memory by a stable user id (tutorial 06 takes it from the Auth0 token), never by an email address. Actor ids may contain letters, digits, `-`, `_`, `/` and `:`.

<table><tr><th>Python (<code>python/memory.py</code>)</th><th>TypeScript (<code>typescript/memory.ts</code>)</th></tr><tr><td>

```python
request: CreateEventInputTypeDef = {
    "memoryId": MEMORY_ID,
    "actorId": actor_id,
    "sessionId": session_id,
    "eventTimestamp": datetime.now(UTC),
    "payload": [{"conversational": {"role": role, "content": {"text": text}}}],
}
...
return memory.create_event(**request)["event"]["eventId"]
```

</td><td>

```typescript
const input: CreateEventInput = {
  memoryId: MEMORY_ID,
  actorId,
  sessionId,
  eventTimestamp: new Date(),
  payload: [{ conversational: { role, content: { text } } }],
};
...
const { event } = await memory.send(new CreateEventCommand(input));
return event!.eventId!;
```

</td></tr></table>

Reading lists the session's events. The API returns the newest first, so sort them.

<table><tr><th>Python</th><th>TypeScript</th></tr><tr><td>

```python
events = memory.list_events(**request)["events"]
if not branch:
    events = [e for e in events if "branch" not in e]  # main-thread events carry no branch
events.sort(key=lambda e: e["eventTimestamp"])  # the API returns newest first
return [
    (p["conversational"]["role"], p["conversational"]["content"]["text"])
    for e in events
    for p in e["payload"]
    if "conversational" in p
]
```

</td><td>

```typescript
const { events = [] } = await memory.send(new ListEventsCommand(input));
return events
  .filter((e) => branch || !e.branch) // main-thread events carry no branch
  .sort((a, b) => a.eventTimestamp!.getTime() - b.eventTimestamp!.getTime()) // API: newest first
  .flatMap((e) => e.payload ?? [])
  .flatMap((p): [Role, string][] =>
    p.conversational
      ? [[p.conversational.role as Role, p.conversational.content?.text ?? ""]]
      : [],
  );
```

</td></tr></table>

**Terraform:** [`aws_bedrockagentcore_memory.helpdesk`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/bedrockagentcore_memory), [`aws_iam_policy.caller`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/iam_policy) (your own scripts need `CreateEvent` and `ListEvents` on the memory)

## Step 4: Give the agent a thread that survives the VM

The agent loads the thread when a session starts and saves every turn. In Python, the Memory **session manager** from `bedrock-agentcore` does both inside Strands. The TypeScript packages have no such session manager, so the agent uses the two functions from step 3.

<table><tr><th>Python (<code>python/main.py</code>)</th><th>TypeScript (<code>typescript/main.ts</code>)</th></tr><tr><td>

```python
def agent_for(user_id: str, session_id: str) -> Agent:
    """One agent per session. Its messages are loaded from, and saved to, Memory."""
    if session_id not in agents:
        thread = AgentCoreMemorySessionManager(
            AgentCoreMemoryConfig(memory_id=MEMORY_ID, actor_id=user_id, session_id=session_id),
            region_name="eu-west-1",
        )
        model = BedrockModel(model_id=MODEL_ID, cache_config=CacheConfig(strategy="auto"))
        agents[session_id] = Agent(model=model, system_prompt=SYSTEM_PROMPT, session_manager=thread)
    return agents[session_id]
```

</td><td>

```typescript
async function agentFor(userId: string, sessionId: string): Promise<Agent> {
  let agent = agents.get(sessionId);
  if (!agent) {
    const thread = await readThread(userId, sessionId);
    agent = new Agent({
      model: new BedrockModel({
        modelId: MODEL_ID,
        region: "eu-west-1",
        cacheConfig: { strategy: "auto" },
      }),
      systemPrompt: SYSTEM_PROMPT,
      messages: thread.map(([role, text]) => ({
        role: role === "USER" ? "user" : "assistant",
        content: [{ text }],
      })),
    });
    agents.set(sessionId, agent);
  }
  return agent;
}
...
      await addMessage(userId, sessionId, "USER", payload.prompt); // save the turn
      await addMessage(userId, sessionId, "ASSISTANT", answer);
```

</td></tr></table>

- The Python session manager stores each Strands message, tool calls included, as JSON in the event text. The TypeScript version stores only the text of each turn.
- The caller can send `user_id` in the payload; it defaults to `anonymous` so that `agentcore invoke` works. Tutorial 06 takes it from the verified token instead.

**Terraform:** [`aws_bedrockagentcore_memory.helpdesk`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/bedrockagentcore_memory), [`aws_iam_role_policy.helpdesk_memory`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/iam_role_policy), [`aws_bedrockagentcore_agent_runtime.helpdesk`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/bedrockagentcore_agent_runtime)

Deploy it, then prove the thread outlives the VM: two turns, stop the session, one more turn in the same session.

<table><tr><th><code>agentcore</code> CLI</th><th>AWS CLI (<code>cli.sh</code>)</th><th>Terraform (<code>terraform/</code>)</th></tr><tr><td>

```bash
# TypeScript: copy main.ts and memory.ts
cp examples/05-conversations-and-caching/python/main.py \
  helpdeskcode/app/helpdesk/main.py
cd helpdeskcode && agentcore deploy
SID=$(uuidgen)
agentcore invoke --session-id "$SID" "My name is Alice."
agentcore invoke --session-id "$SID" "And the meal limit?"
```

The CLI can't stop a session. Wait 15 minutes (the idle timeout), or use the AWS CLI command. Then:

```bash
agentcore invoke --session-id "$SID" "What is my name?"
```

</td><td>

`cli.sh` packages this folder like tutorial 04 and updates the runtime (step 2). Then:

```bash
ask "My name is Alice. What is the hotel limit per night?"
ask "And for meals?"
aws bedrock-agentcore stop-runtime-session --agent-runtime-arn "$AGENT_ARN" --runtime-session-id "$SESSION_ID"
ask "What is my name, and what did I ask first?"
```

`ask` wraps `invoke-agent-runtime` with a fixed session id.

</td><td>

`terraform apply` with the zip of this folder deploys it. Terraform doesn't invoke; use either of the other two.

</td></tr></table>

The last answer still knows the user's name: the new VM reloaded the thread from Memory. Stopping a session needs `bedrock-agentcore:StopRuntimeSession`, which is in the callers' policy.

**Terraform:** [`aws_iam_policy.caller`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/iam_policy)

## Step 5: Fork a thread

A fork continues a conversation from an earlier point without losing the original, for example when the user edits a question. Write the next event with a `branch`: a new name, plus `rootEventId`, the id of the last event to keep.

<table><tr><th>Python (<code>python/fork.py</code>)</th><th>TypeScript (<code>typescript/fork.ts</code>)</th></tr><tr><td>

```python
add_message(user_id, session_id, "USER", "What is the hotel limit per night?")
answer = add_message(user_id, session_id, "ASSISTANT", "Up to 180 EUR in major cities.")
add_message(user_id, session_id, "USER", "Is Paris a major city?")
add_message(user_id, session_id, "ASSISTANT", "Yes.")

# Fork after the first answer: the second question becomes "Is Lyon a major city?".
add_message(user_id, session_id, "USER", "Is Lyon a major city?", branch="lyon", fork_from=answer)
add_message(user_id, session_id, "ASSISTANT", "Yes.", branch="lyon")

print("main:", read_thread(user_id, session_id))
print("lyon:", read_thread(user_id, session_id, branch="lyon"))
```

</td><td>

```typescript
await addMessage(userId, sessionId, "USER", "What is the hotel limit per night?");
const answer = await addMessage(userId, sessionId, "ASSISTANT", "Up to 180 EUR in major cities.");
await addMessage(userId, sessionId, "USER", "Is Paris a major city?");
await addMessage(userId, sessionId, "ASSISTANT", "Yes.");

// Fork after the first answer: the second question becomes "Is Lyon a major city?".
await addMessage(userId, sessionId, "USER", "Is Lyon a major city?", "lyon", answer);
await addMessage(userId, sessionId, "ASSISTANT", "Yes.", "lyon");

console.log("main:", await readThread(userId, sessionId));
console.log("lyon:", await readThread(userId, sessionId, "lyon"));
```

</td></tr></table>

In `add_message`, the first event of a branch sends `{"name": branch, "rootEventId": fork_from}`; later events send only the name. To read a branch, `ListEvents` filters on it with `includeParentBranches: true`, which adds the history the branch grew from. **[verify]** that this stops at the root event; the API reference doesn't say.

<table><tr><th><code>agentcore</code> CLI</th><th>AWS CLI (<code>cli.sh</code>)</th><th>Terraform</th></tr><tr><td>

The CLI has no command for Memory events. The closest is `agentcore invoke --session-id`, which adds events through the agent.

</td><td>

```bash
aws bedrock-agentcore create-event \
  --memory-id "$MEMORY_ID" --actor-id "$USER_ID" --session-id "$SESSION_ID" \
  --event-timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --payload '[{"conversational": {"role": "USER", "content": {"text": "Is Lyon a major city?"}}}]' \
  --branch "{\"name\": \"lyon\", \"rootEventId\": \"$ANSWER_ID\"}"
aws bedrock-agentcore list-events \
  --memory-id "$MEMORY_ID" --actor-id "$USER_ID" --session-id "$SESSION_ID" \
  --include-payloads \
  --filter '{"branch": {"name": "lyon", "includeParentBranches": true}}'
```

</td><td>

Events are data, not resources: Terraform only creates the memory they live in.

</td></tr></table>

**Terraform:** [`aws_bedrockagentcore_memory.helpdesk`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/bedrockagentcore_memory), [`aws_iam_policy.caller`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/iam_policy)

To continue the fork in the agent, start a new session and load the branch's messages. Without Memory, copy the messages up to the fork point into a new thread.

## Step 6: Turn on the prompt cache

Every model call resends the whole conversation. Bedrock can cache the start of the request (tools, then system prompt, then earlier messages) so that later calls read it for about 10% of the input price. Writing the cache costs 125% of the input price for 5 minutes, about 200% for 1 hour.

In Strands it is one setting on the model, shown in step 4. It places a cache point after the system prompt (which also covers the tool definitions before it) and one on the last user message.

<table><tr><th>Python</th><th>TypeScript</th></tr><tr><td>

```python
model = BedrockModel(model_id=MODEL_ID, cache_config=CacheConfig(strategy="auto"))
```

</td><td>

```typescript
      model: new BedrockModel({
        modelId: MODEL_ID,
        region: "eu-west-1",
        cacheConfig: { strategy: "auto" },
      }),
```

</td></tr></table>

`"auto"` caches only for Claude model ids; use `"anthropic"` for an application inference profile, whose id doesn't say which model it is. `ttl="1h"` (Python) or `ttl: "1h"` (TypeScript) keeps the cache for an hour. In the raw `Converse` API you place the `cachePoint` blocks yourself, and `usage` shows whether the cache was written or read:

<table><tr><th>Python (<code>python/converse_cache.py</code>)</th><th>TypeScript (<code>typescript/converse-cache.ts</code>)</th></tr><tr><td>

```python
response = bedrock.converse(
    modelId=MODEL_ID,
    system=[
        {"text": "Answer from this expenses handbook:\n\n" + HANDBOOK},
        {"cachePoint": {"type": "default"}},  # cache everything above; "ttl": "1h" for longer
    ],
    messages=[{"role": "user", "content": [{"text": question}]}],
)
usage = response["usage"]
```

</td><td>

```typescript
const response = await bedrock.send(
  new ConverseCommand({
    modelId: MODEL_ID,
    system: [
      { text: "Answer from this expenses handbook:\n\n" + HANDBOOK },
      { cachePoint: { type: "default" } }, // cache everything above; ttl: "1h" for longer
    ],
    messages: [{ role: "user", content: [{ text: question }] }],
  }),
);
const usage = response.usage!;
```

</td></tr></table>

**Terraform:** [`aws_iam_policy.caller`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/iam_policy) (`bedrock:InvokeModel` for your own scripts; the agent's role already has it)

```bash
uv run python converse_cache.py handbook.md
# example output:
# input=12 cache_write=5210 cache_read=0
# input=14 cache_write=0 cache_read=5210
```

What keeps the cache hitting:

1. **Same system prompt and tools for everyone.** Put per-user details, like the user's first name, in the first user message, never in the system prompt.
2. **A stable tool list, in a stable order.** Every tool definition is part of the cached prefix.
3. **Append-only history.** Trimming or summarizing old messages changes the start of the prompt and misses the cache. Trim rarely, in big steps.
4. **A long enough prefix.** Below the model's minimum nothing is cached: 1,024 tokens for Sonnet 4.6, 4,096 for Haiku 4.5. The helpdesk's short prompt only starts caching once the conversation grows.
5. **A 1-hour TTL when the agent pauses** for more than 5 minutes, for example while it waits for an approval.

## What just happened

- The session id picks the VM, and the VM holds the conversation until it stops. Memory keeps it as events, keyed by user and session, beyond that.
- A fork is a named branch that starts after a chosen event; both histories stay readable.
- The prompt cache makes the repeated start of every request cost about a tenth, as long as that start stays identical.

## Clean up

```bash
cd helpdeskcode && agentcore remove memory --name helpdesk_memory && agentcore deploy   # the CLI project
./examples/05-conversations-and-caching/cli.sh cleanup                                  # the AWS CLI version
terraform -chdir=examples/05-conversations-and-caching/terraform destroy                # the Terraform version
```

Next: [06. Auth0 identity](06-auth0-identity.md)
