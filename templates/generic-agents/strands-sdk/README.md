# generic-agents / strands-sdk

A generic, tool-using internal assistant on the **Strands Agents SDK**, the org standard framework. It runs on **Amazon Bedrock** and is hosted on **AgentCore Runtime**. This is the **reference variant**: the other variants mirror its behaviour and tests.

**Tools** (from [`../tools`](../tools)):
- `calculate`: exact decimal arithmetic;
- `search_knowledge`: the local corpus offline, or Bedrock Knowledge Bases once configured;
- `get_ticket`;
- `create_ticket`: side-effecting, so it requires **human approval (four-eyes)** and is **idempotent**.

## Behaviour

| Concern | How |
|---|---|
| Limits | Turns, total tokens, **USD budget**, wall clock, tool calls, loop detection (identical call ×3), kill switch. Enforced by `org_agents` `RunGuard` through Strands hooks (`BeforeModelCall` cancel, `BeforeToolCall` `cancel_tool`) |
| Tool policy | Allowlist and approval-required globs in `config/agent.toml`. Unlisted tools are blocked |
| Approval | `BeforeToolCall` raises a Strands **interrupt**. The reply is `approval_required` with the list of approvers. An approver sends `{"approval": {"id", "decision"}}` and the run resumes. The requester cannot self-approve unless `self_approval = true` |
| Messages mid-run | Pure thread state machine (`core/thread.py`): the run owner **steers** (the text is appended to the latest user turn before the next model call); other users are **queued** as follow-ups; duplicates are ignored |
| Cancel | `{"cancel": true}` during a run sets the per-run `cancel_signal`; Strands stops at its next cancellation point and the reply is `stopped` with reason `cancelled` (`RunGuard.record_external_stop`). During an approval wait the thread goes back to idle and the agent is rolled back to its state before that prompt (Strands would otherwise accept only interrupt responses next) |
| Failures | An exception from the model or the framework (throttling, validation, network…) ends the run with `{"status": "failed", "error": ...}`. The reply names only the error class; the redacted message goes to the `run_failed` audit event. The agent is rolled back to its state before the prompt (`take_snapshot`/`load_snapshot`), the thread is idle, and queued follow-ups still run. Tools that already ran are not undone (side-effecting ones are idempotent) |
| Framework limits | Strands `limit_*` stop reasons (only if `limits=` is added to the invoke) are reported as `stopped` / `framework_limit` |
| Context | `SlidingWindowConversationManager(40)`; each trim emits a `context_compacted` audit event (`shell/context.py`) |
| Caching | `BedrockModel(cache_config=CacheConfig(strategy="auto"))`. The system prompt is stable and the tool list is fixed |
| Audit | JSON-lines audit events on stdout (CloudWatch via AgentCore Runtime) |
| Identity | The caller's Auth0 JWT (validated by the AgentCore Runtime `customJWTAuthorizer`) is forwarded in `Authorization`. `sub` becomes the principal. See [`AGENT_IDENTITY_AUTH0.md`](../../../AGENT_IDENTITY_AUTH0.md) |

## Code layout (functional core, imperative shell)

Framework-neutral logic lives in the shared library (`templates/shared/python/org_agents`):
- `conversation.py`: `ApprovalPolicy`, `RunOutcome`, `Reply`;
- `core/thread.py`: the pure thread state machine;
- `core/guard.py`, `core/tool_policy.py`, `core/messages.py`, redaction and idempotency;
- `shell/settings.py`, `shell/run_guard.py`, `shell/replies.py`, `shell/invocation.py`, audit.

This variant contains only the Strands-specific shell:

```
src/generic_agent_strands/shell/
├── context.py   # sliding window that audits trims
├── hooks.py     # Strands hooks ↔ RunGuard (limits, policy, approval interrupt, steering)
├── tools.py     # Strands @tool adapters → generic_tools service (raw args parsed there)
├── runner.py    # one thread = one Strands Agent; applies core decisions
└── app.py       # AgentCore Runtime entrypoint (/invocations, /ping)
```

## Run and test (offline)

```bash
uv sync --locked
uv run pytest            # scripted fake model: tools, approval, loop, budget, kill switch, steering, failure, cancel…
uv run mypy --strict src tests
uv run ruff check src tests
```

Running it locally against Bedrock needs AWS credentials with `bedrock:InvokeModel*` on the configured model:

```bash
AWS_REGION=eu-west-1 uv run python -m generic_agent_strands.shell.app   # serves :8080
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

The AgentCore project is [`templates/agentcore/agentcore.json`](../../agentcore/agentcore.json) (runtime `generic_strands_sdk`). It uses `buildContextPath: "."` so the image can include `shared/` and `tools/`.

```bash
cd templates
agentcore deploy                  # builds the ARM64 image in CodeBuild and creates/updates the runtime
agentcore invoke --runtime generic_strands_sdk --prompt "What is the hotel limit per night?"
```

**Production checklist:**
- `[model] id` → a tagged **application inference profile** ARN, with the correct `price`;
- runtime `authorizerType: CUSTOM_JWT` with the Auth0 discovery URL and **audience**;
- `requestHeaderAllowlist: ["Authorization"]`;
- `search_knowledge` and tickets behind **AgentCore Gateway + Policy**;
- AgentCore Observability and Evaluations turned on.

**Local image build:**

```bash
docker build -f generic-agents/strands-sdk/Dockerfile -t generic-strands-sdk .   # from templates/
# behind a TLS-inspecting proxy: --secret id=extra_ca,src=/path/ca.pem (never baked into the image)
```

## Exceptions to the standards

- The `tests/fakes.py` fake model uses `Any` to satisfy the Strands `Model` interface (test shell only).
- `bedrock-agentcore` emits a Pydantic deprecation warning on import (upstream).
