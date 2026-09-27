# generic-agents / opencode-harness

A generic, tool-using internal assistant on the **[opencode](https://github.com/anomalyco/opencode)
harness** (`opencode serve`), running on **Amazon Bedrock** and hosted on **AgentCore Runtime**.
opencode is not the org standard (that is Strands); this variant shows the minimum controls for a
justified opencode-based agent, following [`AGENTS_OPENCODE_BEDROCK.md`](../../../AGENTS_OPENCODE_BEDROCK.md).
Behaviour and tests mirror the reference variant [`strands-sdk`](../strands-sdk).

A small Node **adapter** serves the AgentCore HTTP contract on `0.0.0.0:8080` and starts
`opencode serve` as a **child process** on loopback (one per microVM, lazily, Basic auth with a
random password), with a configuration generated from `config/agent.toml`. An org **guard plugin**
inside opencode forwards every model call and tool call to the adapter's `RunGuard`. opencode's
built-in tools are **denied**; the only tools are the generic tools, reached through the category
**MCP server** ([`../tools`](../tools), `generic_tools.shell.mcp_server`): locally
`http://127.0.0.1:8000/mcp`, in production the **AgentCore Gateway** URL (`TOOLS_MCP_URL`).

**Tools** (as the model sees them: `gw_<tool>`): `calculate`, `search_knowledge`, `get_ticket`, and
`create_ticket` (side-effecting: **human approval, four-eyes**, **idempotent**; `requested_by` and
`idempotency_key` are set by the guard, never by the model).

**Pinned:** opencode **1.18.31** (published 2026-09-14; 1.18.32 of 2026-09-21 is inside the 7-day
cooldown). Every harness API used here was re-verified against the `v1.18.31` source tag
(`014614d`) and the installed binary; file references below are to that tag.

## Behaviour

| Concern | How |
|---|---|
| Limits | Turns, total tokens, **USD budget**, wall clock, tool calls, loop detection (identical call ×3), kill switch: `@org/agents` `RunGuard`, one per run, owned by the adapter. Fed by the guard plugin's `chat.params` hook (runs before **every** model call → `beforeModelCall`; throwing aborts the call) and `tool.execute.before` (→ `beforeToolCall`; throwing blocks the tool), and by the adapter's event stream (`message.updated` of a **completed** assistant message → `afterModelCall`). Any stop → `POST /session/:id/abort`. A timer aborts at the wall-clock limit. opencode's own `steps` is only a soft limit (set to `max_turns` as a hint) |
| Budget | Tokens from opencode (`input`, `output` + `reasoning`, cache read / write), priced with the **org price** in `agent.toml` (integer micro-dollars). opencode's `cost` field (catalog estimate) is ignored. Usage is deduplicated by message id and reconciled from `GET /session/:id/message` before every model call and at the end of the run, so an event race cannot let a call through |
| Tool policy | Deny-by-default opencode permissions **generated from the org `ToolPolicy`** (`src/core/permissions.ts`): `*` and every built-in (bash, edit, read, webfetch, websearch, task, skill, external_directory, question, …) → `deny` (hidden from the model), allowlisted `gw_*` tools → `allow`, approval tools → `ask`, `doom_loop` → `ask`. The same ruleset is also passed on `POST /session` (session rules are evaluated last). The guard plugin checks the allowlist again for every call; a tool the model invents arrives as opencode's `invalid` pseudo tool and is judged by the name the model asked for (audit: `denied`) |
| Approval | For an approval tool, `tool.execute.before` lets the call proceed to opencode's permission check (`ask`), after writing `requested_by` + `idempotency_key` into `output.args` (the very object passed to the MCP call). opencode emits `permission.asked` and **waits**; the adapter replies `approval_required` with the approvers (four-eyes: the requester cannot approve unless `self_approval = true`). An authorised `{"approval": {"id", "decision"}}` → `POST /permission/:id/reply` `once` or `reject` (`experimental.continue_loop_on_deny`, so the model is told "rejected by approver" and answers). Every other `ask` is rejected; `doom_loop` → reject + `loop_detected` stop |
| Messages mid-run | Pure thread state machine (`@org/agents` `core/thread`): the run owner **steers** (`prompt_async` while busy: opencode stores the message and its loop picks it up before the next model call); other users' prompts are refused by the identity binding (below), so queuing only applies when the thread's `busy_policy = "queue"` for the owner; duplicates are ignored; cancel → guard records `cancelled` + abort |
| Failures | A provider/model error (opencode `session.error`) → `{"status": "failed"}`; the thread returns to idle and the next message starts a new run. opencode crashing or the event stream dropping also fails the run, never wedges the thread |
| Redaction | `tool.execute.after` sends tool output (MCP `content[].text` or built-in `output`) to the adapter, which redacts cards, IBANs, e-mail, AWS keys and bearer tokens before the model and opencode's session DB see it. If the bridge is unreachable, the output is withheld |
| Fail-safe | The plugin fails **closed**: no bridge, bad token or no active run → model call / tool call refused. The bridge listens on 127.0.0.1 with a random per-process token |
| Caching | Model key `claude-org` (opencode adds Bedrock `cachePoint`s only for claude/anthropic ids); fixed tool list; stable org prompt. opencode's environment block contains today's date, so the cached prefix resets daily (design doc §3.2) |
| Supply chain | No `opencode-ai` postinstall: the platform binary package is an exact-pinned optional dependency (sha512 in the lockfile). No npm plugins (the guard plugin is a local file with **no imports**). `OPENCODE_DISABLE_PROJECT_CONFIG`, `_MODELS_FETCH` (+ pinned empty `config/opencode-models.json`), `_AUTOUPDATE`, `_SHARE`, `_DEFAULT_PLUGINS`, `_CLAUDE_CODE`, `_EXTERNAL_SKILLS`, `_LSP_DOWNLOAD`; the config dir is pre-seeded so opencode's background `npm install @opencode-ai/plugin` is a no-op; nothing is downloaded at runtime |
| Isolation | opencode gets an **allowlisted environment** (never the adapter's AWS keys), a fresh temp HOME / XDG dirs / session DB and an empty workspace as cwd; it listens only on loopback |
| Audit | JSON-lines audit events on stdout (CloudWatch via AgentCore Runtime) |
| Identity | The caller's Auth0 JWT (validated by the runtime's `customJWTAuthorizer`) → `sub` is the principal. The raw JWT comes from the handler's `InvocationContext` (`@org/agents`; `Authorization` must be in `requestHeaderAllowlist`) and is forwarded to the tools MCP server (Gateway + Cedar) as `Authorization: Bearer …` in the generated `mcp.gw.headers` |
| Identity binding | opencode reads that header **once, at start**, so `opencode serve` starts on the first **prompt** with that caller's token and the process is bound to that principal (`src/core/identity.ts`, `Registry`). A prompt from any **other** principal is **refused** (`{"status": "refused", "reason": "this agent's tools are bound to the user who started the session …"}`): it would otherwise run with someone else's Gateway identity. Cancels and approval responses are not bound (an approved call runs in the requester's run, with the requester's token); before any prompt they are refused without starting opencode. Restarting opencode with the new token was rejected: it would drop the in-flight run and pending approvals |

## How AGENTS_OPENCODE_BEDROCK.md maps to code

| Design doc | Here |
|---|---|
| §2 one `opencode serve` per session, loopback, Basic auth, lazily started | `src/shell/opencodeHost.ts` (random `OPENCODE_SERVER_PASSWORD`, port chosen by opencode and read from its stdout) |
| §3.1 credentials: `credential_process` profile, `AWS_PROFILE` opens opencode's Bedrock gate; never `apiKey` / bearer token | `config/aws-config` + `src/shell/imdsCredentials.ts` (IMDSv2 → credential_process JSON, in Node instead of curl + jq); the child gets `AWS_PROFILE`, `AWS_CONFIG_FILE`, `AWS_REGION` only. Verified locally that opencode runs the `credential_process` (`provider.ts` `amazon-bedrock` loader → `fromNodeProviderChain({profile})`) |
| §3.2 managed config (Bedrock only, whitelist, share/autoupdate/snapshot off, pinned catalog) | `src/shell/opencodeConfig.ts` renders the whole config into `OPENCODE_CONFIG_CONTENT` (`enabled_providers`, `whitelist`, `npm: "@ai-sdk/amazon-bedrock"` — bundled in the binary, `provider.ts` `BUNDLED_PROVIDERS`) |
| §3.3 container environment | `OpencodeHost#childEnv` (allowlist) |
| §4 deny-by-default permissions, `gw_*` via Gateway, high-risk tools `ask` | `src/core/permissions.ts` `permissionRules` (from the org `ToolPolicy`), also passed per session on `POST /session` |
| §5 agents: disable `build`, one primary agent | generated `agent` block: `build`/`plan`/`general`/`explore` disabled, `org-generic` primary with the org prompt |
| §6 adapter ↔ API mapping (`prompt_async`, `/event`, `/permission/:id/reply`, `/abort`) | `src/shell/opencodeApi.ts` (plain `fetch`), `src/shell/runner.ts` |
| §7 every `ask` decided by the adapter; approval → `once`, otherwise `reject` | `decideAsk` (core) + `SessionRunner#onAsk`; four-eyes via `@org/agents` thread core (CIBA is the production approver channel, out of scope here) |
| §8 guard plugin: hard step cap, USD budget, loop hash, kill switch, audit, redaction, `shell.env` scrubbing | `src/plugin/orgGuard.ts` (thin, fails closed) + `src/shell/guardBridge.ts` + `SessionRunner` (`RunGuard` decisions, org pricing) |
| §9 no `curl \| bash`, pinned binary, no npm plugins | `package.json` optional deps + `Dockerfile` (`test -x` on the arm64 binary) |

**Verified in the installed version (1.18.31)** (the design doc marks these [verify in PoC]):
- `prompt_async` while busy is picked up by the running loop before the next model call (`session/prompt.ts` `runLoop` re-reads the messages each step) — test *steering*.
- `tool.execute.before` runs **before** the permission `ask` and receives the same `args` object that is passed to the MCP call, so in-place mutation works (`session/tools.ts`) — test *four-eyes* (ticket shows `requested by auth0|alice` although the model sent `mallory`). Note: opencode's transcript keeps the model's own arguments.
- Throwing in `tool.execute.before` → tool error, the loop continues; throwing in `chat.params` → the model call fails (`session/llm/request.ts`).
- `message.updated` fires several times per message; usage is final when `time.completed` is set.
- A rejected permission ends the loop unless `experimental.continue_loop_on_deny` (`session/processor.ts`); the design doc's plugin hook `permission.ask` is not triggered — permissions are handled from the event stream.

## Code layout (functional core, imperative shell)

```
src/
├── domain.ts                 # OcSessionId, OcMessageId, PermissionRequestId, ModelBackend
├── core/permissions.ts       # pure: ToolPolicy → opencode ruleset, tool-name mapping, ask routing,
│                             #       side-effect arguments (requested_by, idempotency key)
├── core/identity.ts          # pure: which prompts may run with the bound caller's token
├── plugin/orgGuard.ts        # opencode plugin (runs in opencode's Bun runtime, no imports)
└── shell/
    ├── app.ts                # AgentCore entrypoint (startAgentCoreServer), Registry + identity binding
    ├── runner.ts             # one thread = one opencode session; RunGuard; approvals; steering
    ├── opencodeHost.ts       # child process, allowlisted env, event-stream pump
    ├── opencodeApi.ts        # HTTP client (fetch)
    ├── opencodeEvents.ts     # boundary parsers: SSE events, messages → domain values
    ├── opencodeConfig.ts     # renders OPENCODE_CONFIG_CONTENT
    ├── guardBridge.ts        # loopback endpoint the plugin calls
    ├── binary.ts             # resolves the pinned platform binary (or OPENCODE_BIN)
    └── imdsCredentials.ts    # credential_process helper for the Bedrock profile
```

## Run and test (offline)

```bash
(cd ../../shared/ts/org-agents && npm ci --ignore-scripts)
npm ci --ignore-scripts          # installs the opencode binary for this host (linux x64 / arm64)
npm run typecheck                # tsc --noEmit (strict)
npm test                         # node --test: core, shell, and end to end
```

The end-to-end suite (`test/agent.test.ts`) starts the **real pinned opencode binary**, the Python
tools MCP server (`uv run … generic_tools.shell.mcp_server`; skipped when `uv` is missing) and a
**scripted fake model**: a local OpenAI-compatible server (`test/support/fakeModel.ts`) registered
as a custom provider through opencode's bundled `@ai-sdk/openai-compatible`. No AWS, no real model;
the opencode child never sees the test process's environment. Scenarios: tool use + answer,
four-eyes approval (self-approval refused, created once, `requested_by` from the guard, output
redacted), rejected approval, loop detection, budget stop (`AGENT_MAX_USD=0.10`, 100k input tokens),
kill switch (0 model calls), denied tool, duplicate + cancel-when-idle, steering mid-run, cancel
mid-run, wall clock, provider error → `failed` then a new run, identity binding (a second user's
prompt refused, opencode started once with the first caller's token). Invalid payloads, and
cancel / approval before any prompt, are tested at the HTTP boundary without opencode. ~15 s in total (one opencode process per test file).
`OPENCODE_LOGS=1` forwards opencode's logs.

Running locally against Bedrock needs the tools MCP server and a working AWS profile for opencode
(`AWS_PROFILE`, `AWS_CONFIG_FILE`; the adapter never passes access keys through):

```bash
TOOLS_MCP_URL=http://127.0.0.1:8000/mcp AWS_REGION=eu-west-1 node src/shell/app.ts   # serves :8080
curl -s localhost:8080/invocations -H 'Content-Type: application/json' \
  -H 'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id: thread-0000000000000000000000000000001' \
  -d '{"prompt": "What is the hotel limit per night? Also compute 180 * 3."}'
```

**Request payloads / replies:** identical to the reference variant (`{"prompt"}`, `{"cancel": true}`,
`{"approval": {"id", "decision"}}` → `completed`, `approval_required`, `stopped`, `failed`,
`steered`, `queued`, `cancelling`, `duplicate`, `refused`, `invalid_request`).

## Deploy (current AgentCore)

Runtime `generic_opencode_harness` in [`templates/agentcore/agentcore.json`](../../agentcore/agentcore.json)
(`build: Container`, `runtimeVersion: NODE_22`, `buildContextPath: "."`), plus the tools MCP
server as its own runtime (`generic_tools_mcp`, behind AgentCore Gateway). Set `TOOLS_MCP_URL` to
the Gateway MCP URL.

```bash
cd templates
agentcore deploy
docker build -f generic-agents/opencode-harness/Dockerfile -t generic-opencode-harness .   # local image
```

**Production checklist:** `[model] id` → a tagged application inference profile ARN (with the
right `price`); VPC mode with egress only to Bedrock / AgentCore endpoints and the Gateway
(`BEDROCK_ENDPOINT` for a VPC interface endpoint); `requestHeaderAllowlist: ["Authorization"]`;
Cedar policy at the Gateway for `create_ticket`; `idleRuntimeSessionTimeout` ≥ the expected
approval latency (a pending approval keeps the opencode session waiting in the microVM).

## Exceptions to the standards

- **Binary dependency:** `opencode-linux-arm64` / `opencode-linux-x64` 1.18.31 (≈185 MB each, a
  Bun-compiled single file that SCA tools cannot look inside; track upstream advisories). No
  install scripts: `opencode-ai` (which needs a postinstall) is not used.
- **`any`-free, but untyped at the plugin boundary:** `src/plugin/orgGuard.ts` declares only the
  hook shapes it uses (it must not import anything at runtime).
- **Managed config file:** not used; the complete config is generated per process and passed in
  `OPENCODE_CONFIG_CONTENT` (project config disabled; the global config dir is a fresh, pre-seeded
  temp dir with no config file). A managed `/etc/opencode/opencode.json` would be merged last and could silently change
  the generated permission order.
- `@opencode-ai/sdk` is not used (plain `fetch`, see `opencodeApi.ts`).

## Gaps

- **Token lifetime:** the MCP `Authorization` header is fixed when opencode starts (first prompter
  of the microVM); a refreshed token from the same user is not picked up. Keep the runtime
  `maxLifetime` ≤ the Auth0 access-token lifetime (`AGENTS_OPENCODE_BEDROCK.md`). Approvers'
  tokens are not used for the tool call itself.
- **One user per microVM:** other principals' prompts are refused (see *Identity binding*); a
  shared multi-user thread needs a new session per user, or the pi variant (per-run tokens).
- **Guardrails:** not wired (design doc §3.2 marks the `guardrailConfig` pass-through as unverified).
- **CIBA:** approvals come through `/invocations` (org thread core), not Auth0 CIBA.
- **Compaction / title agents:** a title call is avoided by naming the session; opencode's
  compaction (on context overflow) is a model call that the guard counts, but it is not exercised
  by the tests.
- **Wall clock** in the resumed run restarts after an approval (same as the reference variants).
