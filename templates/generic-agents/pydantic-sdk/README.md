# generic-agents / pydantic-sdk

A generic, tool-using internal assistant on **Pydantic AI** (`pydantic-ai-slim[bedrock]`), the approved alternative framework. It runs on **Amazon Bedrock** (Converse API) and is hosted on **AgentCore Runtime**. It mirrors the behaviour and tests of the reference variant, [`../strands-sdk`](../strands-sdk).

**Tools** (from [`../tools`](../tools)):
- `calculate`: exact decimal arithmetic;
- `search_knowledge`: the local corpus offline, or Bedrock Knowledge Bases once configured;
- `get_ticket`;
- `create_ticket`: side-effecting, so it requires **human approval (four-eyes)** and is **idempotent**.

## Behaviour

| Concern | How |
|---|---|
| Limits | Turns, total tokens, **USD budget**, wall clock, tool calls, loop detection (identical call ×3), kill switch. Enforced by `org_agents` `RunGuard` through a Pydantic AI **capability** (`GuardCapability`): `before_model_request` (a stop raises `SkipModelRequest` with a final text, so the model is not called), `after_model_request` (usage → guard), `before_tool_execute` (policy, loop, tool-call limit). Pydantic AI **`UsageLimits`** (`request_limit`, `tool_calls_limit`, `total_tokens_limit` = the org limits) are a second line of defence; `UsageLimitExceeded` is mapped to the matching `StopReason` (`framework_limit` when the limit name is not recognised), recorded with `RunGuard.record_external_stop`, and returned as `stopped` |
| Tool policy | Allowlist and approval-required globs in `config/agent.toml`, decided by the guard in `before_tool_execute`. A blocked tool gets a failed tool result (`ToolFailed`). Tool names that are not registered at all are refused by Pydantic AI itself ("Unknown tool name" retry prompt) |
| Approval | **Deferred tools.** When the guard says `RequireApproval`, `before_tool_execute` raises `ApprovalRequired`; the run ends with `DeferredToolRequests` (`output_type=[str, DeferredToolRequests]`). The reply is `approval_required`; the **approval id is the `tool_call_id`**. An approver sends `{"approval": {"id", "decision"}}` and the run resumes from the stored history with `DeferredToolResults` (`True`, or `ToolDenied("rejected by approver")`, which the model sees as a `denied` tool result). The requester cannot self-approve unless `self_approval = true` |
| History | One `SessionRunner` per thread keeps the Pydantic AI message history and passes it to every run (`message_history=`), so approval resumes and follow-up prompts continue the same conversation. The system prompt is passed as `instructions` (re-sent on every request, never stored in history) |
| Messages mid-run | Pure thread state machine (`core/thread.py`): the run owner **steers** via `AgentRun.enqueue(text, priority="asap")` (delivered with the next model request, or as one more request if the run would otherwise end); other users are **queued** as follow-ups; duplicates are ignored |
| Cancel | `AgentRun.cancel()` (a cancel that arrives before the run attaches is applied when it does); the partial history is kept and the reply is `stopped` with reason `cancelled`. During an approval wait the thread goes back to idle. In both cases (and after failures and usage-limit stops) tool calls without a result are answered "not executed" (`close_unanswered_calls`): Pydantic AI refuses a new prompt after unanswered tool calls, and Bedrock needs every `toolUse` paired with a `toolResult` |
| Failures | An exception from the model or Pydantic AI (throttling, `ModelHTTPError`, validation…) ends the run with `{"status": "failed", "error": ...}` naming only the error class; the redacted message goes to the `run_failed` audit event. The partial history is kept (a tool that ran stays recorded), the thread is idle, and queued follow-ups still run |
| Caching | `BedrockModelSettings(bedrock_cache_instructions=True, bedrock_cache_tool_definitions=True, bedrock_cache_messages=True)`. Instructions are stable and the tool list is fixed |
| Usage | Pydantic AI reports `input_tokens` *including* cache reads/writes; `core/usage.py` converts to the org's disjoint buckets so each token is priced once |
| Audit | JSON-lines audit events on stdout (CloudWatch via AgentCore Runtime) |
| Identity | The caller's Auth0 JWT (validated by the AgentCore Runtime `customJWTAuthorizer`) is forwarded in `Authorization`. `sub` is the principal (ownership, approvals). The profile comes from namespaced claims (`[identity].claim_namespace`): a **required** email, optional given and family names, and an optional user id. If the token has no user id, one is remembered or minted per `sub` (`USERS_DB`), so email and name can change. Principal and caller reach tools in the typed `RunDeps`; the ticket requester and approval replies show name and email. The model gets the first name in the first user message from each speaker, never in the system prompt. Audit logs never contain PII. Without a token the caller is a local dev user; set `REQUIRE_TOKEN=true` to refuse such requests. See [`AGENT_IDENTITY_AUTH0.md`](../../../AGENT_IDENTITY_AUTH0.md) §2.1 |

## Code layout (functional core, imperative shell)

Framework-neutral logic lives in the shared library (`templates/shared/python/org_agents`):
- `conversation.py`: `ApprovalPolicy`, `RunOutcome`, `Reply`;
- `core/thread.py`: the pure thread state machine;
- `core/guard.py`, `core/tool_policy.py`, `core/messages.py`, redaction and idempotency;
- `shell/settings.py`, `shell/run_guard.py`, `shell/replies.py`, `shell/invocation.py`, audit.

This variant contains only the Pydantic AI-specific code:

```
src/generic_agent_pydantic/
├── core/usage.py      # pure: inclusive → disjoint token usage; UsageLimitExceeded message → StopRun
└── shell/
    ├── deps.py        # RunDeps (session, principal, caller, guard): the typed deps_type
    ├── capability.py  # GuardCapability ↔ RunGuard (limits, policy, approval deferral) + UsageLimits
    ├── tools.py       # Pydantic AI Tool adapters → generic_tools service (raw args parsed there)
    ├── runner.py      # one thread = one history; agent.iter, deferred results, enqueue, cancel
    └── app.py         # AgentCore Runtime entrypoint (/invocations, /ping)
```

## Run and test (offline)

```bash
uv sync --locked
uv run pytest            # FunctionModel script: tools, approval, loop, budget, kill switch, steering…
uv run mypy --strict src tests
uv run ruff check src tests
uv run ruff format --check src tests
```

Running it locally against Bedrock needs AWS credentials with `bedrock:InvokeModel*` on the configured model:

```bash
AWS_REGION=eu-west-1 uv run python -m generic_agent_pydantic.shell.app   # serves :8080
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

The AgentCore project is [`templates/agentcore/agentcore.json`](../../agentcore/agentcore.json) (runtime `generic_pydantic_sdk`). It uses `buildContextPath: "."` so the image can include `shared/` and `tools/`.

```bash
cd templates
agentcore deploy                  # builds the ARM64 image in CodeBuild and creates/updates the runtime
agentcore invoke --runtime generic_pydantic_sdk --prompt "What is the hotel limit per night?"
```

**Production checklist:**
- `[model] id` → a tagged **application inference profile** ARN, with the correct `price`;
- runtime `authorizerType: CUSTOM_JWT` with the Auth0 discovery URL and **audience**;
- `requestHeaderAllowlist: ["Authorization"]`;
- `search_knowledge` and tickets behind **AgentCore Gateway + Policy**;
- AgentCore Observability and Evaluations turned on.

**Local image build:**

```bash
docker build -f generic-agents/pydantic-sdk/Dockerfile -t generic-pydantic-sdk .   # from templates/
# behind a TLS-inspecting proxy: --secret id=extra_ca,src=/path/ca.pem (never baked into the image)
```

## Exceptions to the standards

- `Any` appears only in the shell where Pydantic AI's types force it: the `before_tool_execute` hook signature (`dict[str, Any]` validated args) and the fake model's `ToolCall.args`.
- **Unregistered tool names** never reach the guard: Pydantic AI answers them with an "Unknown tool name" retry prompt before any tool hook runs, so no `ToolDecisionEvent` is audited for them. Registered tools that the allowlist denies *are* blocked and audited by the guard (tested).
- **`UsageLimitExceeded` carries only a message**, so the mapping to `StopReason` (`core/usage.py`) matches on the limit name in the text. Pydantic AI checks `tool_calls_limit` for a whole response *before* the tool hooks, so a single response with more calls than allowed stops via this path (audited by the runner) rather than via the guard.
- **Multiple approval-required calls in one response:** the thread state machine holds one pending approval, so the first call is put to the approvers and the others are answered with `ToolDenied("…only one approval can be pending at a time…")` on resume; the model can request them again.
- No history trimming across runs (the reference uses a 40-message sliding window). Per-run tokens and cost are bounded by the guard; long-lived threads should add a `ProcessHistory` capability that trims on tool-call/return boundaries.
- `bedrock-agentcore` emits a Pydantic deprecation warning on import (upstream).
