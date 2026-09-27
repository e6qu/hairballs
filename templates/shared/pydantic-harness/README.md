# shared / pydantic-harness (`org-pydantic-harness`)

A **thin org harness on Pydantic AI**. It gives any Pydantic AI agent the org "batteries" as one reusable library, for any agent category. It does not contain category tools: the agent brings its own `pydantic_ai.Tool`s.

Plain Pydantic AI (see the `pydantic-sdk` variants) gives you the agent loop. This library adds what an org agent needs around it:

| Battery | What the harness adds | Pydantic AI API it builds on |
|---|---|---|
| Guarded runs | Turns, tokens, **USD budget**, wall clock, tool-call limit, **loop detection**, kill switch, tool allowlist, audit events, all from `org_agents` `RunGuard` | `AbstractCapability` hooks: `before_model_request` (stop → `SkipModelRequest`), `after_model_request` (usage), `before_tool_execute` (`SkipToolExecution` / `ApprovalRequired`) |
| Four-eyes approval | Approval-gated tools pause the run; the reply lists the approvers; the requester cannot self-approve; the run resumes as the requester, and the tool runs once | Deferred tools: `output_type=[str, DeferredToolRequests]`, resume with `DeferredToolResults` (`True` / `ToolDenied`) |
| Conversation threads | Pure thread state machine (`org_agents.core.thread`): duplicates ignored, owner **steers**, others are **queued** as follow-ups, cancel | `AgentRun.enqueue(priority="asap")`, `AgentRun.cancel()` |
| Cancel | During a run: `AgentRun.cancel()` (a cancel that arrives before the run attaches is applied when it does); the reply is `stopped` / `cancelled`. While awaiting approval: the thread goes back to idle and the pending calls are answered "not executed" | `RunCancelled.all_messages()` |
| Failures | An exception from the model or framework ends the run with `{"status": "failed", "error": ...}` naming only the error class; the redacted message is in the `run_failed` audit event. The partial history is kept (tools that ran stay recorded), unanswered tool calls are closed, the thread is idle and queued follow-ups still run. Pydantic AI's own `UsageLimitExceeded` (its default `request_limit=50`, behind the org limits) becomes `stopped` / `framework_limit` | `AgentRun.all_messages()` |
| **Session persistence** | Thread state + message history saved after every step; a new process resumes the session, including a pending approval. A run cut off by a restart comes back `Idle` | `ModelMessagesTypeAdapter` (framework's own history format) |
| **Context management** | Tool outputs over 2,000 chars are cut to head + tail with a marker; the history is trimmed to a sliding window of recent turns, never splitting a tool call from its result; each trim emits a `context_compacted` audit event | History processor via the `ProcessHistory` capability |
| **Prompt caching** | Bedrock cache points on system prompt, tool list and last user message, where the model supports them | `BedrockModelSettings(bedrock_cache_*)` |

`create_harness(settings, tools, model, *, session, clock, audit, kill_switch, store=None, context=None)` returns a `Harness` with `handle(Incoming) -> Reply`: the same contract as every other org agent runner, so `org_agents.shell.invocation.parse_incoming` and `org_agents.shell.replies.render` plug straight in.

```python
from org_pydantic_harness.shell import HarnessDeps, JsonFileSessionStore, bedrock_model, create_harness
from pydantic_ai import RunContext, Tool

def create_ticket(ctx: RunContext[HarnessDeps], title: str) -> str:
    ...  # ctx.deps.principal / ctx.deps.session are org domain types

harness = create_harness(
    settings, [Tool(create_ticket)], bedrock_model(settings.agent.model_id, settings.agent.region),
    session=session_id, clock=SystemClock(), audit=JsonLinesAuditSink(),
    kill_switch=lambda: kill_switch_from(os.environ), store=JsonFileSessionStore(Path("/mnt/sessions")),
)
reply = harness.handle(parse_incoming(payload, sender))
```

## Code layout

```
src/org_pydantic_harness/
├── core/                  # pure, no framework imports
│   ├── context.py         # ContextPolicy, truncate_output, MessageShape, window_start
│   └── session.py         # recover(ThreadState) after a restart
└── shell/                 # Pydantic AI integration
    ├── harness.py         # Harness / create_harness: thread state machine + agent.iter + approvals
    ├── guard.py           # GuardCapability: RunGuard ↔ capability hooks
    ├── context.py         # ModelMessage ↔ MessageShape; history processor
    ├── steering.py        # Steer → AgentRun.enqueue; cancel → AgentRun.cancel
    ├── sessions.py        # SessionStore protocol, in-memory and JSON-file stores, snapshot codec
    ├── bedrock.py         # BedrockConverseModel with prompt-cache settings
    ├── config.py          # optional [context] table of config/agent.toml
    └── deps.py            # HarnessDeps(session, principal) for tools
```

## Configuration

Everything from `org_agents` (`[agent]`, `[model]`, `[limits]`, `[tools]`, `[approvals]`) plus an optional table:

```toml
[context]
max_tool_output_chars = 2000   # longer tool results are truncated...
keep_head_chars = 1200         # ...to this head
keep_tail_chars = 600          # ...and this tail, with a marker in between
max_messages = 60              # trim when the history is longer than this...
keep_messages = 30             # ...back to about this many (hysteresis keeps the cache warm)
```

## Design notes

- **Cache-friendly compaction.** Pydantic AI 2.x persists what a history processor returns. A tool output is truncated the first time it enters the history and is stable afterwards. The window is trimmed with hysteresis, so the cached prefix changes rarely. The system prompt is sent as `instructions`, so it is never in the history and never trimmed.
- **Guard stops end the run cleanly.** A stop before a model call returns a synthetic text response instead of calling the model, and pending tool calls are skipped with the stop reason. The history always stays valid and resumable.
- **Steering** uses Pydantic AI's native queue: `AgentRun.enqueue(..., priority="asap")`, available in the pinned 2.46. If a version lacked it, the fallback would be a history processor that appends queued text to the last request (as the Strands variant does). A steer that arrives just after the final model response is carried over to the thread's next run.
- **One approval per turn.** If a model response contains several approval-gated calls, the first is put to the approvers and the others are closed with a "not executed, ask again" result. An approver therefore never approves a call they were not shown.

## Run and test (offline)

```bash
uv sync --locked
uv run pytest -q                 # pure core tests + harness tests on FunctionModel (no AWS)
uv run mypy --strict src tests
uv run ruff check src tests && uv run ruff format --check src tests
```

## Exceptions to the standards

- `Any` appears only at the framework boundary: `AgentRun[HarnessDeps, Any]` in `steering.py` (the output type is irrelevant there), `Coroutine[Any, Any, T]` in the event-loop helper, and the `tests/fakes.py` tool arguments.
- The harness sets `pydantic_ai.BANNER_ENABLED = False` on import. The banner is for interactive terminals, and agents log JSON lines.
- A steering message delivered while an approval is pending makes Pydantic AI close the unapproved call as `interrupted`, so it is not executed, and continue the run. The model has to ask again, which needs approval again.
- Only window trims are audited (`ContextCompactedEvent` counts messages); tool-output truncation changes content, not the message count, and is not audited.
