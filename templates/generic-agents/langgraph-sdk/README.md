# generic-agents / langgraph-sdk

A generic, tool-using internal assistant on **LangGraph** using the **LangChain v1 `create_agent`** loop with middleware. It runs on **Amazon Bedrock** (`ChatBedrockConverse`) and is hosted on **AgentCore Runtime**. It mirrors the reference variant [`../strands-sdk`](../strands-sdk): same tools, same request/response contract, and the same test scenarios.

**Tools** (from [`../tools`](../tools)):
- `calculate`: exact decimal arithmetic;
- `search_knowledge`: the local corpus offline, or Bedrock Knowledge Bases once configured;
- `get_ticket`;
- `create_ticket`: side-effecting, so it requires **human approval (four-eyes)** and is **idempotent**.

**Dependencies:** `langgraph`, `langchain` (v1: `create_agent` + middleware), `langchain-aws` (`ChatBedrockConverse`, `BedrockPromptCachingMiddleware`), `bedrock-agentcore`. `langsmith` comes in transitively through `langchain-core`. Tracing is off unless `LANGSMITH_TRACING`/`LANGCHAIN_TRACING_V2` is `true` (`langsmith/utils.py`, `tracing_is_enabled`). The Dockerfile also sets both to `false` explicitly. No LangSmith features are used.

## Behaviour

| Concern | How |
|---|---|
| Limits | Turns, total tokens, **USD budget**, wall clock, tool calls, loop detection (identical call ×3), kill switch. These are enforced by the `org_agents` `RunGuard` through `GuardMiddleware` (`shell/middleware.py`): `before_model` (a stop appends a final `AIMessage` and jumps to `end`), `after_model` (usage), `wrap_tool_call` (policy, loops, approval) |
| Recursion limit | LangGraph's default `recursion_limit` is **10 007** supersteps (`langgraph/_internal/_config.py`). Every run sets an explicit limit, `4 × (max_turns + 1) + 1`, which is 53 for the default 12 turns (`core/recursion.py`). A turn is at most 4 supersteps: `GuardMiddleware.before_model` → `model` → `GuardMiddleware.after_model` → `tools`. The guard always stops first; the limit is a **second line of defence**. `GraphRecursionError` becomes `stopped` / `turn_limit` |
| Tool policy | Allowlist and approval-required globs in `config/agent.toml`. Unlisted tools (including tools the graph does not know about) are blocked in `wrap_tool_call` with an error `ToolMessage` |
| Approval | `wrap_tool_call` calls LangGraph **`interrupt()`**. The `InMemorySaver` checkpointer stores the paused thread (`thread_id` = AgentCore session id). The **interrupt id is the approval id**. The reply is `approval_required` with the approvers. An approver sends `{"approval": {"id", "decision"}}`, which becomes `Command(resume={interrupt_id: decision})`. The tool task re-runs, and `interrupt()` returns the decision. Four-eyes is enforced by the org thread core: the requester cannot self-approve unless `self_approval = true` |
| Usage | `AIMessage.usage_metadata` is parsed into org `Usage` (`core/usage.py`). LangChain's `input_tokens` **includes** cache reads and writes (`langchain_aws` `_extract_usage_metadata`), so `input_token_details.cache_read` / `cache_creation` / `ephemeral_*` are subtracted to avoid double billing |
| Messages mid-run | Pure thread state machine (`org_agents.core.thread`): the run owner **steers**, other users are **queued** as follow-ups, duplicates are ignored, and cancel stops the agent. See "Steering" below |
| Caching | `BedrockPromptCachingMiddleware` (langchain-aws) adds Converse `cachePoint`s. The system prompt is stable, the tool list is fixed, and history is append-only |
| Audit | JSON-lines audit events on stdout (CloudWatch via AgentCore Runtime) |
| Identity | The caller's Auth0 JWT (validated by the AgentCore Runtime `customJWTAuthorizer`) is forwarded in `Authorization`, and `sub` becomes the principal. The principal and session reach tools through a typed LangGraph run context (`RunContext`, injected as `ToolRuntime`), never from the model |

### Steering (OSS LangGraph has no in-process steering)

LangGraph has no API for injecting input into a running graph. This variant therefore does it itself:
1. A message from the run owner while busy is queued in `GuardMiddleware` and acknowledged as `steered`.
2. At the next `before_model` node, the queued text is appended to the checkpointed history as a `HumanMessage` (`[Message from the user while you were working] …`).
3. Bedrock Converse needs strict user/assistant alternation. `ChatBedrockConverse` merges consecutive user-side messages (the tool results plus the steering text) into **one user turn** (`langchain_aws/chat_models/bedrock_converse.py`, `_messages_to_bedrock`). History stays append-only, so the cached prefix is unchanged.

A message that arrives while a model call is already in flight is injected before the *next* model call. If the run ends before another model call, the text stays queued and is injected at the start of the owner's next run.

### Cancellation

A cancel sets a flag in `GuardMiddleware`:
- the next `before_model` ends the run with `Run cancelled by the user.`;
- pending tool calls get an error result.

History therefore stays valid, with every `tool_use` paired with a `tool_result`. LangGraph's `RunControl.request_drain()` was not used: it stops at a superstep boundary, which can leave unanswered tool calls in the checkpoint.

## Code layout (functional core, imperative shell)

Framework-neutral logic lives in the shared library (`templates/shared/python/org_agents`); see the reference README. This variant contains only:

```
src/generic_agent_langgraph/
├── core/
│   ├── usage.py       # LangChain usage_metadata → org Usage (pure parser)
│   └── recursion.py   # recursion_limit(Limits) (pure)
└── shell/
    ├── middleware.py  # GuardMiddleware: RunGuard ↔ before_model / after_model / wrap_tool_call, interrupt(), steering
    ├── tools.py       # LangChain @tool adapters → generic_tools service; RunContext (context_schema)
    ├── runner.py      # one thread = one create_agent graph + InMemorySaver; applies core decisions
    └── app.py         # AgentCore Runtime entrypoint (/invocations, /ping)
```

## Run and test (offline)

```bash
uv sync --locked
uv run pytest            # scripted fake chat model: tools, approval, loop, budget, kill switch, steering…
uv run mypy --strict src tests
uv run ruff check src tests && uv run ruff format --check src tests
```

Running it locally against Bedrock needs AWS credentials with `bedrock:InvokeModel*` (Converse) on the configured model:

```bash
AWS_REGION=eu-west-1 uv run python -m generic_agent_langgraph.shell.app   # serves :8080
curl -s localhost:8080/invocations -H 'Content-Type: application/json' \
  -H 'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id: thread-0000000000000000000000000000001' \
  -d '{"prompt": "What is the hotel limit per night? Also compute 180 * 3."}'
```

The request payloads and replies are identical to the reference variant:
- payloads: `{"prompt", "message_id"?}`, `{"cancel": true}`, `{"approval": {"id", "decision"}}`;
- replies: `completed`, `approval_required`, `stopped`, `steered`, `queued`, `cancelling`, `duplicate`, `refused`, `invalid_request`.

## Deploy (current AgentCore)

Add the runtime `generic_langgraph_sdk` to [`templates/agentcore/agentcore.json`](../../agentcore/agentcore.json). It has the same shape as `generic_strands_sdk`, with `buildContextPath: "."`. Then:

```bash
cd templates
agentcore deploy
agentcore invoke --runtime generic_langgraph_sdk --prompt "What is the hotel limit per night?"
```

**Production checklist:** as for the reference, plus:
- when `[model] id` is an application inference profile ARN, set `BEDROCK_BASE_MODEL_ID` (e.g. `anthropic.claude-sonnet-4-6`) so that `ChatBedrockConverse` and the caching middleware recognise the model family.

**Local image build:**

```bash
docker build -f generic-agents/langgraph-sdk/Dockerfile -t generic-langgraph-sdk .   # from templates/
```

## Exceptions to the standards and framework gaps

- **Test fakes and the shell use `Any`** where LangChain's types force it:
  - `tests/fakes.py`: none of the `langchain_core` fake chat models implement `bind_tools`, so the fake is a small `BaseChatModel` subclass.
  - `AgentMiddleware[AgentState[Any], …]` and `Command[Any]`.
- **Checkpointer is in memory** (`InMemorySaver`). A paused approval survives only as long as the AgentCore session microVM (`idleRuntimeSessionTimeout` 900 s, `maxLifetime` 3600 s), exactly like the reference's in-process Strands interrupt state. For longer approvals, use a durable checkpointer such as `langgraph-checkpoint-postgres` or a DynamoDB saver. That is a new dependency and needs a reason.
- **Approval resume re-executes the tool task.** LangGraph restarts the interrupted node from the top. `wrap_tool_call` therefore runs again (on the fresh guard of the resumed run) and `interrupt()` returns the decision. Parallel tool calls are separate `Send` tasks, so the other calls in the same step are not re-run. Side-effecting tools must be idempotent anyway, and `create_ticket` is.
- **No history window.** Strands' `SlidingWindowConversationManager(40)` has no drop-in equivalent here. The thread history grows until the session ends, bounded per run by the guard's token and USD limits. Add `SummarizationMiddleware` if longer threads are needed.
- **Steering** is implemented by the variant, not the framework (see above).
- If the recursion limit ever fires (the guard was bypassed), the checkpoint can end mid-loop. The next prompt in that session may then fail on unanswered tool calls, and the session should be restarted.
- `bedrock-agentcore` emits a Pydantic deprecation warning on import (upstream).
