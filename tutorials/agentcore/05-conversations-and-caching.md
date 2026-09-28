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

One message is one event: a `conversational` payload with a role and text, stored under a user id and a session id. Key memory by a stable user id (tutorial 06 takes it from the Auth0 token), never by an email address.

The code has three parts, as in [tutorial 01](01-first-agent.md):

- **`domain`**: types that can only hold valid values. `ActorId` follows AgentCore's pattern (letters, digits, `-`, `_`, `/`, `:`; so never an Auth0 `auth0|…` subject), and `MemoryId`, `SessionId`, `EventId`, `BranchName` and `Message` likewise. Two unions describe events: a `Placement` for where a new message goes, and a `ThreadEvent` (`MainEvent` / `BranchEvent`) for what Memory returns.
- **`core`**: pure functions over those types, such as `thread()`, which turns events into ordered messages.
- **shell** (`memory`, `fork`, `main`): the calls to Memory and the model.

Where a message goes is a union, so "a fork point but no branch" can't be written down:

<table><tr><th>Python (<code>python/domain.py</code>)</th><th>TypeScript (<code>typescript/domain.ts</code>)</th></tr><tr><td>

```python
# Where a new message goes. A fork point without a branch can't be expressed.
@dataclass(frozen=True, slots=True)
class OnMain:
    pass


@dataclass(frozen=True, slots=True)
class StartBranch:
    branch: BranchName
    fork_after: EventId  # the last event the branch keeps


@dataclass(frozen=True, slots=True)
class OnBranch:
    branch: BranchName


Placement = OnMain | StartBranch | OnBranch
```

</td><td>

```typescript
// Where a new message goes. A fork point without a branch can't be expressed.
export type Placement =
  | { readonly kind: "main" }
  | { readonly kind: "startBranch"; readonly branch: BranchName; readonly forkAfter: EventId }
  | { readonly kind: "onBranch"; readonly branch: BranchName };
```

</td></tr></table>

Writing turns a message and its placement into one `CreateEvent` call (the shell):

<table><tr><th>Python (<code>python/memory.py</code>)</th><th>TypeScript (<code>typescript/memory.ts</code>)</th></tr><tr><td>

```python
def add_message(
    memory: MemoryId,
    actor: ActorId,
    session: SessionId,
    message: Message,
    placement: Placement,
    at: datetime,
) -> EventId:
    """Store one message; return its event id."""
    request: CreateEventInputTypeDef = {
        "memoryId": memory.value,
        "actorId": actor.value,
        "sessionId": session.value,
        "eventTimestamp": at,
        "payload": [
            {"conversational": {"role": _role(message.role), "content": {"text": message.text}}}
        ],
    }
    branch = _branch(placement)
    if branch:
        request["branch"] = branch
    response = client.create_event(**request)
    return EventId.parse(response["event"]["eventId"])
```

</td><td>

```typescript
export async function addMessage(
  memory: MemoryId,
  actor: ActorId,
  session: SessionId,
  message: Message,
  placement: Placement,
  at: Date,
): Promise<EventId> {
  const branch = branchOf(placement);
  const { event } = await client.send(
    new CreateEventCommand({
      memoryId: memory,
      actorId: actor,
      sessionId: session,
      eventTimestamp: at,
      payload: [{ conversational: { role: message.role, content: { text: message.text } } }],
      ...(branch ? { branch } : {}),
    }),
  );
  return parseEventId(event?.eventId);
}
```

</td></tr></table>

Reading lists the session's events and parses each one at the boundary:

<table><tr><th>Python</th><th>TypeScript</th></tr><tr><td>

```python
def read_events(
    memory: MemoryId, actor: ActorId, session: SessionId, branch: BranchName | None
) -> list[ThreadEvent]:
    """The session's events, or one branch's with the history it grew from."""
    request: ListEventsInputTypeDef = {
        "memoryId": memory.value,
        "actorId": actor.value,
        "sessionId": session.value,
        "includePayloads": True,
        "maxResults": 100,
    }
    if branch:
        request["filter"] = {"branch": {"name": branch.value, "includeParentBranches": True}}
    response = client.list_events(**request)
    return [parse_event(raw) for raw in response["events"]]  # outside data -> domain types
```

</td><td>

```typescript
export async function readEvents(
  memory: MemoryId,
  actor: ActorId,
  session: SessionId,
  branch: BranchName | undefined,
): Promise<ThreadEvent[]> {
  const { events = [] } = await client.send(
    new ListEventsCommand({
      memoryId: memory,
      actorId: actor,
      sessionId: session,
      includePayloads: true,
      maxResults: 100,
      ...(branch ? { filter: { branch: { name: branch, includeParentBranches: true } } } : {}),
    }),
  );
  return events.map(parseEvent); // outside data -> domain types
}
```

</td></tr></table>

<table><tr><th>Python (<code>python/domain.py</code>)</th><th>TypeScript (<code>typescript/domain.ts</code>)</th></tr><tr><td>

```python
def parse_event(raw: Mapping[str, object]) -> ThreadEvent:
    """One event from ListEvents."""
    event_id = EventId.parse(raw.get("eventId"))
    at = raw.get("eventTimestamp")
    if not isinstance(at, datetime):
        raise ParseError("$.eventTimestamp must be a timestamp")
    payload = raw.get("payload", [])
    items = payload if isinstance(payload, list) else []
    messages = tuple(m for m in (_message(item) for item in items) if m is not None)
    branch = raw.get("branch")
    if branch is None:
        return MainEvent(event_id, at, messages)
    name = BranchName.parse(_fields(branch, "$.branch").get("name"))
    return BranchEvent(event_id, at, name, messages)
```

</td><td>

```typescript
// One event from ListEvents (the SDK's own type), with its USER/ASSISTANT messages.
export function parseEvent(raw: Event): ThreadEvent {
  const id = parseEventId(raw.eventId);
  if (!(raw.eventTimestamp instanceof Date)) throw new ParseError("eventTimestamp missing");
  const at = raw.eventTimestamp;
  const messages = (raw.payload ?? []).flatMap((item): Message[] => {
    const role = item.conversational?.role;
    const text = item.conversational?.content?.text;
    return (role === "USER" || role === "ASSISTANT") && text ? [{ role, text }] : [];
  });
  return raw.branch
    ? { kind: "branch", id, at, branch: parseBranchName(raw.branch.name), messages }
    : { kind: "main", id, at, messages };
}
```

</td></tr></table>

The API returns the newest events first. The core sorts them and keeps the main thread (events with no branch) unless you asked for a branch:

<table><tr><th>Python (<code>python/core.py</code>)</th><th>TypeScript (<code>typescript/core.ts</code>)</th></tr><tr><td>

```python
def thread(events: Sequence[ThreadEvent], on_branch: bool) -> list[Message]:
    """The messages of one thread, oldest first.

    ListEvents returns every event of the session (newest first), or, when filtered by a branch,
    that branch plus the history it grew from. The main thread is the events with no branch.
    """
    kept = events if on_branch else [e for e in events if isinstance(e, MainEvent)]
    return [m for e in sorted(kept, key=lambda e: e.at) for m in e.messages]
```

</td><td>

```typescript
export function thread(events: readonly ThreadEvent[], onBranch: boolean): Message[] {
  return events
    .filter((e) => onBranch || e.kind === "main") // filter returns a new array, so sort is safe
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .flatMap((e) => e.messages);
}
```

</td></tr></table>

**Terraform:** [`aws_bedrockagentcore_memory.helpdesk`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/bedrockagentcore_memory), [`aws_iam_policy.caller`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/iam_policy) (your own scripts need `CreateEvent` and `ListEvents` on the memory)

## Step 4: Give the agent a thread that survives the VM

The agent loads the thread when a session starts and saves every turn. In Python, the Memory **session manager** from `bedrock-agentcore` does both inside Strands. The TypeScript packages have no such session manager, so the agent uses the shell functions and `thread()` from step 3. Either way the entrypoint first parses the body into an `Invocation` (a prompt and an `ActorId`) and the header into a `SessionId`.

<table><tr><th>Python (<code>python/main.py</code>)</th><th>TypeScript (<code>typescript/main.ts</code>)</th></tr><tr><td>

```python
def agent_for(actor: ActorId, session: SessionId) -> Agent:
    """One agent per session. Its messages are loaded from, and saved to, Memory."""
    if session not in agents:
        config = AgentCoreMemoryConfig(
            memory_id=MEMORY.value, actor_id=actor.value, session_id=session.value
        )
        thread = AgentCoreMemorySessionManager(config, region_name="eu-west-1")
        model = BedrockModel(model_id=MODEL_ID, cache_config=CacheConfig(strategy="auto"))
        agents[session] = Agent(model=model, system_prompt=SYSTEM_PROMPT, session_manager=thread)
    return agents[session]


@app.entrypoint
async def invoke(payload: object, context: RequestContext) -> AsyncIterator[str]:
    # Who is calling: user_id defaults to "anonymous" so that `agentcore invoke` works;
    # tutorial 06 takes the verified user id from the Auth0 token instead.
    invocation = parse_invocation(payload)  # outside data -> domain types, right here
    session = SessionId.parse(context.session_id)
    async for event in agent_for(invocation.actor, session).stream_async(invocation.prompt):
        data = event.get("data")
        if isinstance(data, str):
            yield data
```

</td><td>

```typescript
async function agentFor(actor: ActorId, session: SessionId): Promise<Agent> {
  let agent = agents.get(session);
  if (!agent) {
    const history = thread(await readEvents(MEMORY, actor, session, undefined), false);
    agent = new Agent({
      model: new BedrockModel({
        modelId: MODEL_ID,
        region: "eu-west-1",
        cacheConfig: { strategy: "auto" },
      }),
      systemPrompt: SYSTEM_PROMPT,
      messages: history.map((m) => ({
        role: m.role === "USER" ? "user" : "assistant",
        content: [{ text: m.text }],
      })),
    });
    agents.set(session, agent);
  }
  return agent;
}
...
      const { prompt, actor } = parseInvocation(payload); // outside data -> domain types
      const session = parseSessionId(context.sessionId);
...
      const main = { kind: "main" } as const; // save the turn
      await addMessage(MEMORY, actor, session, message("USER", prompt), main, new Date());
      await addMessage(MEMORY, actor, session, message("ASSISTANT", answer), main, new Date());
```

</td></tr></table>

<table><tr><th>Python (<code>python/domain.py</code>)</th><th>TypeScript (<code>typescript/domain.ts</code>)</th></tr><tr><td>

```python
def parse_invocation(raw: object) -> Invocation:
    """The /invocations body: {"prompt": "...", "user_id": "..."} (user_id optional)."""
    fields = _fields(raw, "$")
    prompt = fields.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        raise ParseError("$.prompt must be a non-empty string")
    return Invocation(prompt.strip(), ActorId.parse(fields.get("user_id", "anonymous")))
```

</td><td>

```typescript
// The /invocations body: {"prompt": "...", "user_id": "..."} (user_id optional).
export function parseInvocation(raw: unknown): Invocation {
  if (typeof raw !== "object" || raw === null) throw new ParseError("$ must be a JSON object");
  const fields = raw as Record<string, unknown>;
  const prompt = fields["prompt"];
  if (typeof prompt !== "string" || prompt.trim() === "") {
    throw new ParseError("$.prompt must be a non-empty string");
  }
  return { prompt: prompt.trim(), actor: parseActorId(fields["user_id"] ?? "anonymous") };
}
```

</td></tr></table>

- The Python session manager stores each Strands message, tool calls included, as JSON in the event text. The TypeScript version stores only the text of each turn.
- The memory id comes from the environment and is parsed once, at startup: a runtime without it fails to start rather than on the first call.

**Terraform:** [`aws_bedrockagentcore_memory.helpdesk`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/bedrockagentcore_memory), [`aws_iam_role_policy.helpdesk_memory`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/iam_role_policy), [`aws_bedrockagentcore_agent_runtime.helpdesk`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/bedrockagentcore_agent_runtime)

Deploy it, then prove the thread outlives the VM: two turns, stop the session, one more turn in the same session.

<table><tr><th><code>agentcore</code> CLI</th><th>AWS CLI (<code>cli.sh</code>)</th><th>Terraform (<code>terraform/</code>)</th></tr><tr><td>

```bash
# TypeScript: copy main.ts, memory.ts, domain.ts, core.ts
cp examples/05-conversations-and-caching/python/{main,domain,core}.py \
  helpdeskcode/app/helpdesk/
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

A fork continues a conversation from an earlier point without losing the original, for example when the user edits a question. The first message of the fork gets a `StartBranch` placement: a new branch name, plus the id of the last event to keep. Later messages go `OnBranch`.

<table><tr><th>Python (<code>python/fork.py</code>)</th><th>TypeScript (<code>typescript/fork.ts</code>)</th></tr><tr><td>

```python
def say(role: Role, text: str, where: Placement = OnMain()) -> EventId:
    return add_message(memory, user, session, Message.of(role, text), where, datetime.now(UTC))


say(Role.USER, "What is the hotel limit per night?")
answer = say(Role.ASSISTANT, "Up to 180 EUR in major cities.")
say(Role.USER, "Is Paris a major city?")
say(Role.ASSISTANT, "Yes.")

# Fork after the first answer: the second question becomes "Is Lyon a major city?".
say(Role.USER, "Is Lyon a major city?", StartBranch(lyon, fork_after=answer))
say(Role.ASSISTANT, "Yes.", OnBranch(lyon))

print("main:", thread(read_events(memory, user, session, None), on_branch=False))
print("lyon:", thread(read_events(memory, user, session, lyon), on_branch=True))
```

</td><td>

```typescript
const say = (role: Role, text: string, where: Placement = { kind: "main" }): Promise<EventId> =>
  addMessage(memory, user, session, message(role, text), where, new Date());

await say("USER", "What is the hotel limit per night?");
const answer = await say("ASSISTANT", "Up to 180 EUR in major cities.");
await say("USER", "Is Paris a major city?");
await say("ASSISTANT", "Yes.");

// Fork after the first answer: the second question becomes "Is Lyon a major city?".
await say("USER", "Is Lyon a major city?", {
  kind: "startBranch",
  branch: lyon,
  forkAfter: answer,
});
await say("ASSISTANT", "Yes.", { kind: "onBranch", branch: lyon });

console.log("main:", thread(await readEvents(memory, user, session, undefined), false));
console.log("lyon:", thread(await readEvents(memory, user, session, lyon), true));
```

</td></tr></table>

In `CreateEvent`, a `StartBranch` becomes `{"name": ..., "rootEventId": ...}` and `OnBranch` only the name (step 3). To read a branch, `ListEvents` filters on it with `includeParentBranches: true`, which adds the history the branch grew from. **[verify]** that this stops at the root event; the API reference doesn't say.

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

`"auto"` caches only for Claude model ids; use `"anthropic"` for an application inference profile, whose id doesn't say which model it is. `ttl="1h"` (Python) or `ttl: "1h"` (TypeScript) keeps the cache for an hour.

In the raw `Converse` API you place the `cachePoint` blocks yourself, and `usage` shows whether the cache was written or read. The shell calls the model; `domain` parses `usage` into a `CacheUsage`, and `core` describes it:

<table><tr><th>Python (<code>python/converse_cache.py</code>)</th><th>TypeScript (<code>typescript/converse-cache.ts</code>)</th></tr><tr><td>

```python
def ask(handbook: str, question: str) -> None:
    response = bedrock.converse(
        modelId=MODEL_ID,
        system=[
            {"text": "Answer from this expenses handbook:\n\n" + handbook},
            {"cachePoint": {"type": "default"}},  # cache everything above; "ttl": "1h" for longer
        ],
        messages=[{"role": "user", "content": [{"text": question}]}],
    )
    print(describe(parse_usage(response["usage"])))  # outside data -> domain type -> text
```

</td><td>

```typescript
async function ask(handbook: string, question: string): Promise<void> {
  const response = await bedrock.send(
    new ConverseCommand({
      modelId: MODEL_ID,
      system: [
        { text: "Answer from this expenses handbook:\n\n" + handbook },
        { cachePoint: { type: "default" } }, // cache everything above; ttl: "1h" for longer
      ],
      messages: [{ role: "user", content: [{ text: question }] }],
    }),
  );
  console.log(describe(parseUsage(response.usage))); // outside data -> domain type -> text
}
```

</td></tr></table>

<table><tr><th>Python (<code>python/domain.py</code>)</th><th>TypeScript (<code>typescript/domain.ts</code>)</th></tr><tr><td>

```python
def parse_usage(raw: Mapping[str, object]) -> CacheUsage:
    """The `usage` of a Converse response."""

    def count(key: str) -> int:
        value = raw.get(key, 0)
        if not isinstance(value, int) or value < 0:
            raise ParseError(f"$.usage.{key} must be a count")
        return value

    return CacheUsage(
```

</td><td>

```typescript
// The `usage` of a Converse response (the SDK's own type).
export function parseUsage(raw: TokenUsage | undefined): CacheUsage {
  if (!raw) throw new ParseError("the response has no usage");
  return {
    uncached: raw.inputTokens ?? 0,
    cacheWrite: raw.cacheWriteInputTokens ?? 0,
    cacheRead: raw.cacheReadInputTokens ?? 0,
  };
}
```

</td></tr></table>

**Terraform:** [`aws_iam_policy.caller`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/iam_policy) (`bedrock:InvokeModel` for your own scripts; the agent's role already has it)

```bash
uv run python converse_cache.py handbook.md
# example output:
# input=12 cache_write=5210 cache_read=0 (0% read from cache)
# input=14 cache_write=0 cache_read=5210 (99% read from cache)
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
