# generic-agents / pi-harness

A generic, tool-using internal assistant on the **[pi](https://github.com/earendil-works/pi) SDK**
(`@earendil-works/pi-coding-agent`), running on **Amazon Bedrock** and hosted on **AgentCore
Runtime**. pi is not the org standard (that is Strands); this variant shows the minimum controls
for a justified pi-based agent, following [`AGENT_PI_BEDROCK.md`](../../../AGENT_PI_BEDROCK.md).
Behaviour and tests mirror the reference variant [`strands-sdk`](../strands-sdk).

pi runs **in-process** (`createAgentSession`) inside a small Node adapter that serves the AgentCore
HTTP contract. pi's built-in coding tools are **off**; the only tools are the generic tools, reached
through the category **MCP server** ([`../tools`](../tools), `generic_tools.shell.mcp_server`):
locally on `http://127.0.0.1:8000/mcp`, in production the **AgentCore Gateway** URL (`TOOLS_MCP_URL`).

**Tools:** `calculate`, `search_knowledge`, `get_ticket`, and `create_ticket` (side-effecting:
**human approval, four-eyes**, **idempotent**; `requested_by` and `idempotency_key` are set by the
harness, never by the model).

## Behaviour

| Concern | How |
|---|---|
| Limits | Turns, total tokens, **USD budget**, wall clock, tool calls, loop detection (identical call ×3), kill switch: `@org/agents` `RunGuard`, wired through the org pi extension: `turn_start` → `beforeModelCall` (→ `ctx.abort()`), `message_end` usage `{input, output, cacheRead, cacheWrite}` → `afterModelCall`, `tool_call` → `beforeToolCall` (→ `{block, reason, terminate}`), `session_compact` usage → `recordExternalUsage`. The runner asks the guard once more *before* `session.prompt()`, so a kill switch or spent budget never reaches the provider. A timer aborts a hung call at the wall-clock limit |
| Tool policy | Allowlist + approval globs in `config/agent.toml`. pi's built-in tools are disabled (`noTools: "builtin"` + `excludeTools`); a tool the model invents is not registered, so pi answers "Tool … not found" |
| Fail-safe | A throwing `tool_call` handler makes pi block the call; the handler throws when no guarded run is active. `agent_start` without an active run aborts |
| Approval | The `tool_call` hook **holds** the call: it blocks it with a "pending approval" result and `terminate: true`, so the turn ends without another model call; the reply is `approval_required` with the approvers. On `{"approval": {"id", "decision": "approve"}}` from an authorised approver, the runner executes **that exact call** (same arguments) through the MCP client with `requested_by` = requester and the idempotency key, then gives the result to the agent as a new prompt (a new, auditable turn). `reject` → the agent is told it was not executed. The requester cannot self-approve unless `self_approval = true` |
| Messages mid-run | Pure thread state machine (`@org/agents` `core/thread`): the run owner **steers** (`session.steer()`: pi injects it after the current tool batch, before the next model call); other users are **queued** and run afterwards as their own run (not pi's `followUp()`, which would run inside the current run's budget and identity); duplicates are ignored; cancel → guard records `cancelled` + `session.abort()` |
| Failures | A provider/model error (`stopReason: "error"`) → `{"status": "failed"}` (redacted, truncated); the thread returns to idle and the next message starts a new run. A Bedrock **guardrail intervention** → `stopped` (policy stop), not `failed` |
| Guardrails | Only if `GUARDRAIL_ID` (+ `GUARDRAIL_VERSION`) is set: `before_provider_request` adds `guardrailConfig` to the Converse request. **Fails open** (pi sends the request unchanged if the handler throws), so also enforce it in IAM |
| Redaction | `tool_result` hook redacts cards, IBANs, e-mail, AWS keys and bearer tokens in tool output before the model and pi's transcript see it |
| Caching | pi adds Bedrock `cachePoint`s when the model **name** contains the family (`[pi] model_family`, since inference-profile ARNs don't match). Stable system prompt, fixed tool list, append-only history |
| Supply chain | `PI_OFFLINE=1`, `PI_SKIP_VERSION_CHECK=1`, `PI_TELEMETRY=0` forced in `src/shell/offline.ts` (and the Dockerfile); no extension/skill/prompt/theme/context-file discovery; in-memory settings, session and credential store (nothing read from `~/.pi`) |
| Audit | JSON-lines audit events on stdout (CloudWatch via AgentCore Runtime) |
| Identity | The caller's Auth0 JWT (validated by the runtime's `customJWTAuthorizer`) → `sub` is the principal; pi's `ctx` has no request identity, so the runner publishes the active run (owner, guard) to the extension (`RunSlot`) |

## How AGENT_PI_BEDROCK.md maps to code

| Design doc | Here |
|---|---|
| §3.1 credentials from the runtime role (`fromInstanceMetadata` → `process.env`, refresh 5 min before expiry) | `src/shell/credentials.ts`, `src/core/credentials.ts`; active only with `AGENTCORE_RUNTIME=1`. `fromInstanceMetadata` is `@smithy/credential-provider-imds`, already in pi-ai's AWS SDK tree |
| §3.3 application inference profile **with cost**, family in the name, no Bedrock `apiKey` | `src/shell/model.ts` (`ModelRuntime.registerProvider("amazon-bedrock", …)`, cost from `[model] price`) |
| §3.4 guardrail via `before_provider_request` (fails open) | `src/shell/guardrail.ts`; intervention → policy stop in `src/core/outcome.ts` |
| §4 SDK in-process, `-nc`, only our extensions | `src/shell/runner.ts` (`DefaultResourceLoader` with `noExtensions`, `noSkills`, `noPromptTemplates`, `noThemes`, `noContextFiles`, inline `extensionFactories`) |
| §5 org guard extension | `src/shell/orgExtension.ts` + shared `RunGuard`; decisions in `src/core/gate.ts` |
| §5 gateway tools (`pi.registerTool` + TypeBox, MCP `tools/call`) | `src/shell/tools.ts` + `@org/agents` `McpClient` |
| §6 steer / queue / cancel / dedupe | `src/shell/runner.ts` + `@org/agents` `core/thread` |
| §7.3 approval → pending result, resume with a new turn | `src/core/approval.ts`, `src/shell/runner.ts` |
| §8 no runtime installs, `PI_OFFLINE=1` | `src/shell/offline.ts`, Dockerfile |

## Code layout (functional core, imperative shell)

Framework-neutral logic is in the shared library [`@org/agents`](../../shared/ts/org-agents). This variant:

```
src/core/                 # pure: no I/O, no pi imports
├── domain.ts             # ToolCallId, ToolOutcome, FinalMessage, PiModelSettings, Guardrail (+ parsers)
├── gate.ts               # guard verdict → pi tool_call action (run / block / hold for approval)
├── outcome.ts            # finished pi run → RunOutcome (guardrail → policy stop)
├── approval.ts           # approval ids and the texts the model sees
├── pricing.ts            # configured price → pi model cost
├── credentials.ts        # refresh schedule
└── steering.ts
src/shell/
├── offline.ts            # PI_OFFLINE & co. (imported first)
├── piAi.ts               # pi's own copy of pi-ai (TypeBox, faux) / smithy IMDS
├── piMessages.ts         # pi messages (untyped) → Usage / FinalMessage
├── tools.ts              # TypeBox schemas + MCP tools/call (requested_by, idempotency key)
├── orgExtension.ts       # the org pi extension: RunGuard hooks, approval hold, redaction, tools
├── guardrail.ts          # before_provider_request → guardrailConfig
├── model.ts              # ModelRuntime + Bedrock inference profile; [pi] settings
├── credentials.ts        # IMDS → process.env refresher (AgentCore only)
├── runState.ts           # the active run shared with the extension
├── runner.ts             # one thread = one pi AgentSession; applies core decisions
└── app.ts                # AgentCore Runtime entrypoint (startAgentCoreServer)
```

## Run and test (offline)

```bash
(cd ../../shared/ts/org-agents && npm ci --ignore-scripts)   # npm does not install a file: link's deps
npm ci --ignore-scripts
npm run typecheck
npm test
```

Tests use pi-ai's built-in **faux** provider as a scripted model (`test/support.ts`; exact usage can
be scripted per call), never AWS. Tests that execute tools start the Python tools MCP server with
`uv` (skipped when `uv` is missing). Scenarios: tool use + answer, four-eyes approval with refused
self-approval and a single creation, rejected approval, loop detection, budget stop
(`AGENT_MAX_USD=0.10`, 100k input tokens), kill switch (no model call), unregistered tool,
duplicate + cancel when idle, steering mid-run, queued follow-up from another user, cancel mid-run,
redaction, provider error → `failed` then a new run, guardrail → `stopped`, invalid payloads at the
HTTP boundary, built-in tools off.

Locally against Bedrock (AWS credentials with `bedrock:InvokeModel*` on the model) and the tools server:

```bash
(cd ../tools && uv run --extra mcp python -m generic_tools.shell.mcp_server) &   # :8000/mcp
AWS_REGION=eu-west-1 node src/shell/app.ts                                       # :8080
curl -s localhost:8080/invocations -H 'Content-Type: application/json' \
  -H 'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id: thread-0000000000000000000000000000001' \
  -d '{"prompt": "What is the hotel limit per night? Also compute 180 * 3."}'
```

**Payloads / replies:** identical to the Python variants (`{"prompt"}`, `{"cancel": true}`,
`{"approval": {"id", "decision"}}` → `completed`, `approval_required`, `stopped`, `failed`,
`steered`, `queued`, `cancelling`, `duplicate`, `refused`, `invalid_request`).

## Deploy (current AgentCore)

Runtime `generic_pi_harness` in [`templates/agentcore/agentcore.json`](../../agentcore/agentcore.json)
(`runtimeVersion: NODE_22`, `build: Container`, `buildContextPath: "."`). The tools MCP server is its
own runtime (`generic_tools_mcp`) behind AgentCore Gateway; point `TOOLS_MCP_URL` at the Gateway.

```bash
cd templates
agentcore deploy
docker build -f generic-agents/pi-harness/Dockerfile -t generic-pi-harness .   # local; add --secret id=extra_ca,src=ca.pem behind a TLS proxy
```

Environment: `AWS_REGION`, `AGENT_MAX_USD`, `AGENT_MAX_TURNS`, `TOOLS_MCP_URL`,
`AGENTCORE_RUNTIME=1` (turns on the credential refresher), optional `BEDROCK_MODEL_ID`,
`BEDROCK_BASE_URL` (VPC endpoint), `GUARDRAIL_ID` + `GUARDRAIL_VERSION`, `PI_CACHE_RETENTION=long`
when approvals pause runs for more than 5 minutes, `AGENT_KILL_SWITCH`.

**Production checklist:** `[model] id` → tagged application inference profile ARN with the right
`price` and `[pi] model_family`; runtime `CUSTOM_JWT` authorizer (Auth0 discovery URL + audience);
`requestHeaderAllowlist: ["Authorization"]`; execution role limited to the inference profile;
guardrail enforced in IAM as well; Observability and Evaluations on.

## Exceptions to the standards

- **pi 0.86.0, not the latest 0.87.1.** 0.87.1 (2026-09-22) is inside the 7-day cooldown; 0.86.0
  (published 2026-09-19T23:14Z) has every API used here. The design doc was written against
  0.87.1 (`2b0a123`); everything below was re-verified in the installed 0.86.0.
- **Node ≥ 22.19** (`engines`): pi 0.86.0 requires it (not 22.6).
- **Nested dependency tree.** pi ships `npm-shrinkwrap.json`, so its 143 dependencies (incl.
  `@earendil-works/pi-ai`, `typebox`, the OpenAI/Anthropic/Google/AWS SDKs) install under
  `node_modules/@earendil-works/pi-coding-agent/node_modules`. We import pi's own pi-ai (TypeBox
  `Type`, faux provider) and smithy IMDS by path (`src/shell/piAi.ts`, typed via `paths` in
  tsconfig) instead of adding them as dependencies, which would install a second copy (232 instead
  of 149 lockfile entries) and split module state.
- **`skipLibCheck: true`**: pi's shipped `.d.ts` files import JSON without import attributes, which
  `tsc` rejects under `module: nodenext`. Our sources and `@org/agents` are still fully checked.
- **Install scripts** (not run; `--ignore-scripts`): `esbuild` (postinstall binary check; the
  platform binary is an optional dependency, and esbuild is only used by pi's file-extension loader,
  which we do not use), `protobufjs` (postinstall version check), `@google/genai` (no-op preinstall).
- `any` appears only in pi's own types (`Model<any>`); our code uses `unknown` at the pi boundary.
- The org extension is an inline factory in this codebase (reviewed, type-checked, tested), not a
  file loaded by pi's `jiti` loader as in the design doc sketch.

## Known gaps

- **Gateway identity:** the MCP client does not forward the caller's JWT, because the shared
  `InvocationHandler` does not expose the raw `Authorization` token (shared-lib change needed).
- No approval-granted/rejected audit event type in `@org/agents` (the approved call is audited as a
  `tool_decision`); no dedicated `guardrail` stop reason (uses `framework_limit`).
- Replies are JSON, not SSE streaming; no transcript export to S3 on `agent_settled`.
- Invalid tool arguments are rejected by pi's TypeBox validation *before* the `tool_call` hook, and
  unregistered tool names never reach it: such calls are not counted by the guard (they execute
  nothing).
