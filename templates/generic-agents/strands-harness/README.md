# generic-agents / strands-harness

A generic, tool-using internal assistant built with **[strands-harness](https://pypi.org/project/strands-harness/)** (`create_harness`), the "batteries included" layer on top of the Strands Agents SDK. It runs on **Amazon Bedrock** and is hosted on **AgentCore Runtime**. It behaves like the reference variant [`../strands-sdk`](../strands-sdk) and passes the same tests. `create_harness(...)` returns a plain `strands.Agent`, so the org hooks, tool adapters and runner are the same as in the SDK variant.

**Tools** (from [`../tools`](../tools)):
- `calculate`: exact decimal arithmetic;
- `search_knowledge`: the local corpus offline, or Bedrock Knowledge Bases once configured;
- `get_ticket`;
- `create_ticket`: side-effecting, so it requires **human approval (four-eyes)** and is **idempotent**.

The harness context management adds two **read-only** tools: `retrieve_context` and `retrieve_offloaded_content`. They are in the `[tools].allowed` list in `config/agent.toml`; any tool that is not listed is blocked by the guard.

## What the harness adds over the plain SDK, and what is switched off

`create_harness` defaults to a **coding agent**. This is a non-coding assistant, so everything that touches the host, the network or the filesystem is turned off in [`shell/harness.py`](src/generic_agent_strands_harness/shell/harness.py). Source checked: `.venv/.../strands_harness/agent.py` (`create_harness`), `options.py`, `defaults.py`, `models.py`.

| Harness feature | Default | Here | Why |
|---|---|---|---|
| Context manager (`context_manager="auto"`, SDK `strands._context_manager`) | on | **on** | Large tool results are truncated into an in-memory stash, which the model can read back with `retrieve_context`. At 85% of the context window the history is summarized. This replaces the SDK variant's `SlidingWindowConversationManager(40)` |
| `ContextOffloader` (tool results over about 1.5k tokens) | on | **on** | Stores the result in a temp dir from `tempfile.mkdtemp` because `session=False`. A preview and a reference stay in context, and the model reads the rest with `retrieve_offloaded_content` |
| Harness contract (`HARNESS_CONTRACT`) | on | **on** | A static behavioural prompt, with `prompts/system.md` appended as `instructions`. There are no timestamps, so the cached prefix does not change |
| Prompt caching (`caching`) | on | **same config, set on the model** | The harness applies caching only when it builds the model from a `"provider/name"` string. That string form cannot carry the configured region, so `app.py` builds `BedrockModel(..., cache_config=CacheConfig(strategy="auto", tools_ttl=True))`, which is what the harness would build. `create_harness` gets `caching=False`, so it logs no warning |
| OTEL tracing (`setup_telemetry`) | off unless `OTEL_TRACES_EXPORTER` is set | unchanged | Opt-in through the standard env var. AgentCore Observability is the production route |
| Built-in tools `shell`, `read`, `write`, `edit`, `web_fetch`, `web_search` (native or Exa), `programmatic_tool_caller` (Monty sandbox), `subagent` | on | **off** (`builtin_tools=[]`) | Not needed by a non-coding assistant, and each one reaches the host, the web or a code sandbox. `subagent` would also start child agents, with model calls of their own |
| Sandbox-vended tools | dropped by the harness | dropped | The default `NotASandboxLocalEnvironment` provides no tools |
| Built-in plugins `todos` and `environment` | on | **off** (`builtin_plugins=[]`) | `environment` injects the date, the cwd and `AGENTS.md` before every turn, which breaks the stable prompt prefix and exposes host details. `todos` is for multi-step coding work |
| File-backed sessions (`./.agent/sessions`) | on | **off** (`session=False`) | The conversation is in memory, one session per AgentCore microVM. The shared thread state machine owns the thread lifecycle |
| Long-term memory (`./.agent/memory`) | on | **off** (`memory=False`) | It is file-backed and extracts facts with extra model calls that the guard does not see. It would also persist user data across sessions |
| Skills (`./.agent/skills`) | on | **off** (`skills=False`) | Nothing to load, and it avoids reading from the host filesystem |
| Background tasks | on (`agentic: ["*"]`) | **off** (`background_tasks=False`) | Tools run inline, so every call goes through the guard hooks in order |
| Interventions (HITL / Cedar / LLM classifier) | off | off | Approval is enforced by the org `RunGuard` and a Strands interrupt, as in the reference variant |

## Behaviour

| Concern | How |
|---|---|
| Limits | Turns, total tokens, **USD budget**, wall clock, tool calls, loop detection (identical call ×3) and kill switch. Enforced by the `org_agents` `RunGuard` through Strands hooks passed to `create_harness(hooks=...)`: `BeforeModelCall` cancel and `BeforeToolCall` `cancel_tool` |
| Tool policy | Allowlist and approval-required globs in `config/agent.toml`. Unlisted tools are blocked |
| Approval | `BeforeToolCall` raises a Strands **interrupt**. The reply is `approval_required` with the list of approvers. An approver sends `{"approval": {"id", "decision"}}` and the run resumes. The requester cannot self-approve unless `self_approval = true` |
| Messages mid-run | Pure thread state machine (`org_agents.core.thread`). The run owner **steers**: the text is appended to the latest user turn before the next model call. Other users are **queued** as follow-ups. Duplicates are ignored, and cancel stops the agent |
| Context | Harness `"auto"` context manager plus `ContextOffloader` (see above) |
| Caching | `CacheConfig(strategy="auto", tools_ttl=True)`. The system prompt is stable and the tool list is fixed |
| Audit | JSON-lines audit events on stdout (CloudWatch via AgentCore Runtime) |
| Identity | The caller's Auth0 JWT (validated by the AgentCore Runtime `customJWTAuthorizer`) is forwarded in `Authorization`. `sub` becomes the principal |

## Code layout (functional core, imperative shell)

Framework-neutral logic comes from the shared library (`templates/shared/python/org_agents`). The variant contains only shell code:

```
src/generic_agent_strands_harness/shell/
├── harness.py   # create_harness(...) with the coding-agent built-ins switched off
├── hooks.py     # Strands hooks ↔ RunGuard (copied from strands-sdk: framework shell code)
├── tools.py     # Strands @tool adapters → generic_tools service (copied from strands-sdk)
├── runner.py    # one thread = one harness Agent; applies core decisions
└── app.py       # AgentCore Runtime entrypoint (/invocations, /ping)
```

The package does not import from `generic_agent_strands`. It has no framework-specific pure logic, so `core/` is empty.

## Run and test (offline)

```bash
uv sync --locked
uv run pytest            # scripted fake model: tools, approval, loop, budget, kill switch, steering, harness wiring
uv run mypy --strict src tests
uv run ruff check src tests && uv run ruff format --check src tests
```

Running it locally against Bedrock needs AWS credentials with `bedrock:InvokeModel*` on the configured model:

```bash
AWS_REGION=eu-west-1 uv run python -m generic_agent_strands_harness.shell.app   # serves :8080
curl -s localhost:8080/invocations -H 'Content-Type: application/json' \
  -H 'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id: thread-0000000000000000000000000000001' \
  -d '{"prompt": "What is the hotel limit per night? Also compute 180 * 3."}'
```

The request and reply contract is the same as in [`../strands-sdk`](../strands-sdk/README.md):
- **Requests:** `{"prompt", "message_id"?}`, `{"cancel": true}`, `{"approval": {"id", "decision"}}`.
- **Replies:** `completed`, `approval_required`, `stopped`, `steered`, `queued`, `cancelling`, `duplicate`, `refused`, `invalid_request`.

## Deploy (current AgentCore)

Add a runtime `generic_strands_harness` to [`templates/agentcore/agentcore.json`](../../agentcore/agentcore.json), with the same shape as `generic_strands_sdk` and `dockerfile: generic-agents/strands-harness/Dockerfile`. Then:

```bash
cd templates
agentcore deploy
agentcore invoke --runtime generic_strands_harness --prompt "What is the hotel limit per night?"
docker build -f generic-agents/strands-harness/Dockerfile -t generic-strands-harness .   # local image, from templates/
```

The production checklist is the same as for the reference variant: an application inference profile ARN with the correct price, `CUSTOM_JWT` with an audience, `requestHeaderAllowlist: ["Authorization"]`, and Gateway + Policy for the tools.

## Exceptions to the standards

- **Cooldown exception: `strands-harness==0.1.2` only.** Every release of it (0.0.0 to 0.1.2, uploaded 2026-09-21/22) is newer than the 7-day cooldown (`exclude-newer = 2026-09-20`). uv 0.8.17 supports a per-package cutoff, so `pyproject.toml` has `[tool.uv] exclude-newer-package = { strands-harness = "2026-09-23T00:00:00Z" }`, and the version is pinned exactly. uv records this in `uv.lock` under `[options.exclude-newer-package]`. Its dependencies do **not** need an exception: `strands-agents[otel]>=1.56,<2` resolves to **1.56.0**, the same as the reference, and `pydantic-monty==0.0.23` and its `-client`/`-runtime` packages were uploaded on 2026-09-05. Both resolve under the global cutoff. Remove the exception once 2026-09-29 has passed.
- **Unused heavy dependency:** `pydantic-monty` (the sandbox for `programmatic_tool_caller`) is a hard dependency of `strands-harness`, so it is installed even though that tool is off.
- **Summarization is not metered:** the context manager's summarizer calls `model.stream` directly (`strands/_context_manager/methods/summarize.py`) instead of going through the agent loop. The model hooks do not see it, so `RunGuard` does not count its tokens or cost. It runs only at 85% of the context window. With the default limits (`max_usd = 0.50`, `max_total_tokens = 200000`), a run is usually stopped before that point, but mostly-cached histories can get there. The wall-clock limit still applies. If this matters, pass a custom `ContextManagerConfig` without `Offload.summarize`.
- The context manager warns once that `context_window_limit` is not set on the model and uses the SDK default. Set it on the `BedrockModel` for exact utilization.
- The `ContextOffloader` temp directory, and a `retrieve_offloaded_content` tool registered on every agent, are harness behaviour. The directory lives in the microVM's `/tmp` and is gone when the session ends.
- `tests/fakes.py`, a copy of the reference fake model, uses `Any` to satisfy the Strands `Model` interface (test shell only).
- `bedrock-agentcore` emits a Pydantic deprecation warning on import (upstream).
