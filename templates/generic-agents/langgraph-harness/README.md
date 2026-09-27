# generic-agents / langgraph-harness

A generic, tool-using internal assistant on **LangChain `deepagents`** (0.7.x), the batteries-included harness built on LangGraph and LangChain v1 `create_agent`. It uses `ChatBedrockConverse` from `langchain-aws` to call **Amazon Bedrock** and is hosted on **AgentCore Runtime**. Its behaviour and tests mirror the reference variant [`../strands-sdk`](../strands-sdk).

**Tools** (from [`../tools`](../tools)):
- `calculate`: exact decimal arithmetic;
- `search_knowledge`: the local corpus offline, or Bedrock Knowledge Bases once configured;
- `get_ticket`;
- `create_ticket`: side-effecting, so it requires **human approval (four-eyes)** and is **idempotent**.

**deepagents built-ins**, narrowed for a non-coding assistant:

| Built-in | Kept? | How |
|---|---|---|
| Filesystem (`ls`, `write_file`, `edit_file`, `delete`, `glob`, `grep`) | **Removed** | `FilesystemMiddleware(tools=["read_file"])` replaces the default by name |
| `read_file` | Kept (cannot be removed) | `FilesystemMiddleware` requires it. The backend is `StateBackend`, so it reads only **virtual files in the graph state**: deepagents moves oversized tool results there. Allowlisted in `config/agent.toml` |
| `execute` (shell) | **Removed** | Not in the tool list. No sandbox or `LocalShellBackend` is configured |
| Sub-agents (`task`) | Kept, constrained | A single `general-purpose` spec replaces the default one. It gets **read-only tools only** (`calculate`, `search_knowledge`, `get_ticket`, `read_file`), no HITL, and a `GuardMiddleware` over the **same `RunControl`**: its turns, tokens, USD and tool calls count against the parent run's budget. `task` is allowlisted |
| Planning (`write_todos`) | Not present | `TodoListMiddleware` is not in the deepagents 0.7 default stack, and it is not added: it would cost turns without helping a short Q&A/ticket assistant |
| Summarization (compaction) | **Removed** | `NoCompaction` replaces `SummarizationMiddleware` by name. Summaries call the model outside the agent loop, so the `RunGuard` would not meter those calls. The org token limit bounds the context instead |
| Skills, memory, async sub-agents | Not configured | |
| Prompt caching | Kept | deepagents appends `langchain-aws` `BedrockPromptCachingMiddleware` (and an Anthropic one that no-ops for Bedrock) |
| Dangling-tool-call patching | Kept | `PatchToolCallsMiddleware` repairs history after a run stopped between a tool call and its result |

## Behaviour

| Concern | How |
|---|---|
| Limits | Turns, total tokens, **USD budget**, wall clock, tool calls, loop detection (identical call ×3) and kill switch. Enforced by the `org_agents` `RunGuard` through LangChain v1 middleware (`create_deep_agent(middleware=...)`): `before_model` (limits, kill switch → `jump_to: end`), `wrap_model_call` (usage → budget), `after_model` (a stopped run jumps to the end, so that turn's tools never run) and `wrap_tool_call` (policy, loop, tool-call limit) |
| Recursion limit | Always set explicitly: `(max_turns + 1) × 10 + 10` super-steps (140 for 12 turns), from `core/recursion.py`. Without it the limit is deepagents' bound `9_999`. It is only a backstop: one turn is 6 graph nodes, so the guard's turn limit always trips first (tested). A `GraphRecursionError` would map to `stopped (turn_limit)`, recorded with `RunGuard.record_external_stop` (turn_limit rather than framework_limit, because the limit is derived from `max_turns`). The sub-agent graph keeps its own bound limit, but its turns count against the shared guard |
| Usage | `AIMessage.usage_metadata` → org `Usage`. LangChain's `input_tokens` already includes cache read and write tokens, so `core/usage.py` subtracts them before pricing |
| Tool policy | Allowlist and approval-required globs in `config/agent.toml`. Unlisted tools (including hallucinated ones) are blocked in `wrap_tool_call` with an error result |
| Approval | deepagents `interrupt_on` → LangChain `HumanInTheLoopMiddleware`, built from the org tool policy (every `approval_required` tool, decisions `approve`/`reject`). The run pauses with a LangGraph interrupt, and the reply is `approval_required` with the approvers. An approver sends `{"approval": {"id", "decision"}}`. The **org thread core** enforces four-eyes (the requester cannot approve unless `self_approval = true`), then the runner resumes with `Command(resume={interrupt_id: {"decisions": [{"type": "approve"}]}})` or `{"type": "reject", "message": "rejected by approver"}`. A rejected call is never executed, and the model receives an error `ToolMessage`. The HITL `when` predicate skips the interrupt if the guard has already stopped the run |
| Messages mid-run | Pure thread state machine (`core/thread.py`). The run owner **steers**: queued text becomes a `HumanMessage` appended in `before_model`, before the next model call, and Converse merges it into the tool-result user turn. Other users are **queued** as follow-ups. Duplicates are ignored. Cancel sets a flag, and the middleware ends the run at the next `before_model` or `after_model` |
| Cancel | The reply is `stopped` with reason `cancelled` (`RunGuard.record_external_stop`), also when the cancel lands during the final model call. The flag is cleared when the run finishes. A cancel while awaiting approval returns the thread to idle and drops the pending HITL request; deepagents' `PatchToolCallsMiddleware` answers the abandoned tool call at the start of the next run |
| Failures | An exception from the model or the graph (throttling, validation…) ends the run with `{"status": "failed", "error": ...}` naming only the error class; the redacted message goes to the `run_failed` audit event. The thread is idle, queued follow-ups still run, and dangling tool calls are patched by `PatchToolCallsMiddleware` on the next run |
| History | LangGraph `InMemorySaver` checkpointer, `thread_id` = the AgentCore session id. This is append-only, which keeps the prompt cache stable |
| Caching | `BedrockPromptCachingMiddleware` (added by deepagents). The system prompt is stable and the tool list is fixed per session |
| Audit | JSON-lines audit events on stdout (CloudWatch via AgentCore Runtime) |
| Identity | The caller's Auth0 JWT (validated by the AgentCore Runtime `customJWTAuthorizer`) is forwarded in `Authorization`. `sub` is the principal (ownership, approvals). The profile comes from namespaced claims (`[identity].claim_namespace`): a **required** email, optional given and family names, and an optional user id. If the token has no user id, one is remembered or minted per `sub` (`USERS_DB`), so email and name can change. The caller reaches `create_ticket` through the LangGraph run context (`context_schema=RunContext`), not graph state, so the model never sees or sets it. The ticket requester and approval replies (HITL interrupts) show name and email. The model gets the first name in the first `HumanMessage` from each speaker, never in the system prompt. Audit logs never contain PII. Without a token the caller is a local dev user; set `REQUIRE_TOKEN=true` to refuse such requests. See [`AGENT_IDENTITY_AUTH0.md`](../../../AGENT_IDENTITY_AUTH0.md) |

## Code layout (functional core, imperative shell)

Framework-neutral logic lives in the shared library (`templates/shared/python/org_agents`). This variant contains only:

```
src/generic_agent_deepagents/
├── core/
│   ├── usage.py       # LangChain token totals → org Usage (cache tokens split out)
│   └── recursion.py   # LangGraph recursion limit derived from max_turns
└── shell/
    ├── tools.py       # LangChain @tool adapters → generic_tools service (raw args parsed there)
    ├── middleware.py  # GuardMiddleware / SteeringMiddleware / NoCompaction ↔ RunGuard
    ├── agent.py       # create_deep_agent(...) with the built-ins narrowed (see table above)
    ├── runner.py      # one thread = one checkpointed graph; HITL interrupt ↔ org approvals
    └── app.py         # AgentCore Runtime entrypoint (/invocations, /ping)
```

## Run and test (offline)

```bash
uv sync --locked
uv run pytest            # scripted fake chat model: tools, approval, loop, budget, sub-agent budget, kill switch, steering…
uv run mypy --strict src tests
uv run ruff check src tests && uv run ruff format --check src tests
```

Running it locally against Bedrock needs AWS credentials with `bedrock:InvokeModel*` on the configured model:

```bash
AWS_REGION=eu-west-1 uv run python -m generic_agent_deepagents.shell.app   # serves :8080
curl -s localhost:8080/invocations -H 'Content-Type: application/json' \
  -H 'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id: thread-0000000000000000000000000000001' \
  -d '{"prompt": "What is the hotel limit per night? Also compute 180 * 3."}'
```

**Request payloads:**
- `{"prompt", "message_id"?}`
- `{"cancel": true}`
- `{"approval": {"id", "decision": "approve"|"reject"}}`

**Replies:** `completed`, `approval_required`, `stopped`, `failed`, `steered`, `queued`, `cancelling`, `duplicate`, `refused`, `invalid_request`.

## Deploy (current AgentCore)

The AgentCore project is [`templates/agentcore/agentcore.json`](../../agentcore/agentcore.json) (runtime `generic_langgraph_harness`). It uses `buildContextPath: "."` so the image can include `shared/` and `tools/`.

```bash
cd templates
agentcore deploy
agentcore invoke --runtime generic_langgraph_harness --prompt "What is the hotel limit per night?"
```

**Production checklist:** the same as the [reference](../strands-sdk/README.md#deploy-current-agentcore). In addition, the `InMemorySaver` checkpointer lives only as long as the session's microVM. For threads that must survive it, use a durable LangGraph checkpointer, such as one backed by AgentCore Memory or DynamoDB.

**Local image build:**

```bash
docker build -f generic-agents/langgraph-harness/Dockerfile -t generic-langgraph-harness .   # from templates/
```

## Exceptions to the standards

- **Dependencies.** `deepagents` 0.7.15 hard-depends on `langchain-anthropic` (+ `anthropic`) and `langchain-google-genai` (+ `google-genai`, `google-auth`), plus `langsmith` and `wcmatch`. These are not optional extras, so they cannot be dropped. They are imported but never used for model calls here, because the only model is `ChatBedrockConverse`. The lock resolves 82 packages.
- **`Any` at the framework boundary.** `Any` appears in `shell/middleware.py`, `shell/agent.py` and `shell/runner.py` for LangChain/LangGraph generics (`AgentMiddleware[...]`, `Command[Any]`, `CompiledStateGraph[...]`), and in `tests/fakes.py` for the `BaseChatModel` interface. The core has none.
- **The `SubAgent` spec is a TypedDict.** It is a framework-required schema that lives only in `shell/agent.py`.
- **Kept built-ins widen the allowlist.** `config/agent.toml` allowlists `task` and `read_file`, which the reference does not have (see the built-ins table).
- **Cancel granularity.** LangGraph has no in-flight cancel for a synchronous `invoke`. Cancel takes effect at the next `before_model` or `after_model`, so the tools of the in-flight turn do not run. A model call already in flight completes and is metered. The cancelled run replies `stopped` / `cancelled` with the last assistant text, or an empty text.
- **Approval covers a whole turn.** If one model turn requests several approval-gated calls, HITL batches them into one interrupt, and the single org decision applies to all of them.
- **Guard ordering around approval.** The guard's tool checks (loop detection, tool-call limit) run when the approved tool executes, not before the approval request. deepagents places HITL in its tail middleware, so HITL's `after_model` runs before ours.
- `bedrock-agentcore` emits a Pydantic deprecation warning on import (upstream).
