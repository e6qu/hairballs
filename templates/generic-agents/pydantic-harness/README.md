# generic-agents / pydantic-harness

A generic, tool-using internal assistant built on the **org harness for Pydantic AI**, [`org-pydantic-harness`](../../shared/pydantic-harness). It runs on **Amazon Bedrock** and is hosted on **AgentCore Runtime**. Its behaviour and tests mirror the reference variant, [`strands-sdk`](../strands-sdk).

This variant is deliberately thin. It holds only:
- tool adapters;
- the AgentCore entrypoint;
- config and tests.

Everything else comes from the harness. Compared with [`pydantic-sdk`](../pydantic-sdk), which wires plain Pydantic AI to the org controls itself, this variant shows what the harness layer adds:
- **persistent sessions**, which survive restarts, including pending approvals;
- **context management**: tool-output truncation and a sliding window;
- **Bedrock prompt caching** defaults;
- guard, approval and steering wiring you do not write per agent.

**Tools** (from [`../tools`](../tools)):
- `calculate`;
- `search_knowledge`;
- `get_ticket`;
- `create_ticket`: side-effecting, so it requires **human approval (four-eyes)** and is **idempotent**.

## Behaviour

| Concern | How |
|---|---|
| Limits | Turns, total tokens, **USD budget**, wall clock, tool calls, loop detection (identical call ×3), kill switch. Enforced by `org_agents` `RunGuard` through the harness's `GuardCapability`: `before_model_request` → `SkipModelRequest` with the stop reason, `after_model_request` → usage, and `before_tool_execute` → `SkipToolExecution` |
| Tool policy | Allowlist and approval-required globs in `config/agent.toml`. A registered tool that is not in the allowlist is blocked by the guard and audited. A tool name the model invents is refused by Pydantic AI itself ("Unknown tool name"), because it is not registered |
| Approval | `before_tool_execute` raises `ApprovalRequired`, so the run ends with `DeferredToolRequests`. The reply is `approval_required` with the approvers. An approver sends `{"approval": {"id", "decision"}}` and the harness resumes with `DeferredToolResults`: approve → `True`, reject → `ToolDenied("rejected by approver")`. The tool runs as the requester, with the idempotency key from the session and its arguments |
| Messages mid-run | Pure thread state machine (`org_agents.core.thread`). The run owner **steers** through `AgentRun.enqueue(priority="asap")`: the text reaches the model on its next request. Other users are **queued** as follow-ups. Duplicates are ignored |
| Cancel | During a run: `AgentRun.cancel()`, reply `stopped` / `cancelled`. While awaiting approval: the thread goes back to idle and the pending call is answered "not executed" |
| Failures | An exception from the model or Pydantic AI (throttling, validation…) ends the run with `{"status": "failed", "error": ...}` naming only the error class (redacted details in the `run_failed` audit event). Partial history is kept, unanswered tool calls are closed, the thread is idle and queued follow-ups still run. Pydantic AI's own `UsageLimitExceeded` becomes `stopped` / `framework_limit` |
| Sessions | Thread state and Pydantic AI message history are saved after every step (`SESSIONS_DIR` → JSON-file store; otherwise in memory). A new process resumes the conversation and any pending approval |
| Context | Tool results over 2,000 chars → head + tail + marker. The history is kept to a sliding window (`[context]` in `config/agent.toml`) that never splits a tool call from its result; each trim emits a `context_compacted` audit event |
| Caching | `bedrock_cache_instructions`, `bedrock_cache_tool_definitions` and `bedrock_cache_messages`, applied where the model supports them. The system prompt is sent as stable `instructions` and the tool list is fixed |
| Audit | JSON-lines audit events on stdout (CloudWatch via AgentCore Runtime) |
| Identity | The caller's Auth0 JWT (validated by the AgentCore Runtime `customJWTAuthorizer`) is forwarded in `Authorization`. `sub` is the principal (ownership, approvals) and reaches tools as `RunContext[HarnessDeps].deps.principal`. The profile comes from namespaced claims (`[identity].claim_namespace`): a **required** email, optional given and family names, and an optional user id. If the token has no user id, one is remembered or minted per `sub` (`USERS_DB`), so email and name can change. The caller reaches tools as `deps.caller`; the ticket requester and approval replies show name and email. The model gets the first name in the first user message from each speaker, never in the system prompt. Audit logs never contain PII. Without a token the caller is a local dev user; set `REQUIRE_TOKEN=true` to refuse such requests. See [`AGENT_IDENTITY_AUTH0.md`](../../../AGENT_IDENTITY_AUTH0.md) §2.1 |

## Code layout (functional core, imperative shell)

The shared layers:
- `templates/shared/python/org_agents`: domain, thread state machine, guard, policies, audit, settings, invocation parsing and reply rendering;
- `templates/shared/pydantic-harness/org_pydantic_harness`: the Pydantic AI harness (`create_harness`, sessions, context, steering, Bedrock caching).

This variant:

```
src/generic_agent_pydantic_harness/shell/
├── tools.py     # Pydantic AI Tool adapters → generic_tools service (raw args parsed there)
└── app.py       # AgentCore Runtime entrypoint (/invocations, /ping); one harness per session
```

It has no `core/` of its own: every decision lives in `org_agents` or in the harness core.

## Run and test (offline)

```bash
uv sync --locked
uv run pytest            # scripted FunctionModel: tools, approval (+ restart), loop, budget, kill switch, steering…
uv run mypy --strict src tests
uv run ruff check src tests && uv run ruff format --check src tests
```

Running it locally against Bedrock needs AWS credentials with `bedrock:InvokeModel*` on the configured model:

```bash
AWS_REGION=eu-west-1 SESSIONS_DIR=/tmp/sessions uv run python -m generic_agent_pydantic_harness.shell.app   # :8080
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

Add the runtime `generic_pydantic_harness` to [`templates/agentcore/agentcore.json`](../../agentcore/agentcore.json), with the same shape as `generic_strands_sdk`. It uses `buildContextPath: "."`, so the image can include `shared/python`, `shared/pydantic-harness` and `tools/`.

```bash
cd templates
agentcore deploy
agentcore invoke --runtime generic_pydantic_harness --prompt "What is the hotel limit per night?"
```

**Production checklist:**
- `[model] id` → a tagged **application inference profile** ARN, with the correct `price`. For prompt caching with an ARN, construct the model with `bedrock_model(base_id, region, inference_profile=arn)`, so Pydantic AI knows the model family;
- `SESSIONS_DIR` on persistent session storage, or a `SessionStore` over DynamoDB/S3;
- runtime `authorizerType: CUSTOM_JWT` with the Auth0 discovery URL and **audience**;
- `requestHeaderAllowlist: ["Authorization"]`;
- `search_knowledge` and tickets behind **AgentCore Gateway + Policy**;
- AgentCore Observability and Evaluations turned on.

**Local image build:**

```bash
docker build -f generic-agents/pydantic-harness/Dockerfile -t generic-pydantic-harness .   # from templates/
```

## Exceptions to the standards

- **Denied tool scenario.** With Pydantic AI, a tool name the model invents (`delete_everything`) is refused by the framework before any hook runs. The model gets a retry prompt that lists the available tools, and the org guard never sees the call. The guard's own allowlist block, with its audit event, applies to *registered* tools that are not allowlisted. That case is covered by the harness tests (`test_registered_but_unlisted_tool_is_blocked`).
- **Steering while an approval is pending.** If steering text arrives while a tool call waits for approval, Pydantic AI closes that call as `interrupted` (not executed) and continues the run. The model has to ask again, which needs approval again. Steering itself is native (`AgentRun.enqueue`), not a fallback.
- **Several approval-gated calls in one response.** The first is put to the approvers. The others are closed with "not executed … ask again", so nobody approves a call they were not shown.
- `Any` appears only in `tests/fakes.py` (tool arguments for the scripted `FunctionModel`).
- `bedrock-agentcore` emits a Pydantic deprecation warning on import (upstream).
