# @org/agents (TypeScript)

Shared agent controls for the TypeScript agent templates (the **pi** and **opencode** harness
variants). It is a faithful port of the Python library `templates/shared/python` (`org_agents`):
same semantics, same stop reasons, same `/invocations` payloads and reply JSON, same
`config/agent.toml` format. Names are the Python names in camelCase.

What every agent gets from it (see `templates/CODING_STANDARDS.md` §6):

- **Domain types** (`src/domain.ts`): branded types with `parse(raw: unknown, path)` → `Result<T, ParseError>`
  and `of(...)` for trusted values: `SessionId`, `PrincipalId` (allows `auth0|123`, `x@clients`),
  `MessageId`, `ApprovalId`, `ToolName`, `ToolPattern` (`*`/`?` globs), `Fingerprint`, `ModelId`,
  `AwsRegion`, `Usd` (integer **micro-dollars**, parsed exactly from numbers or decimal strings),
  `TokenCount`, `PositiveInt`, `DurationMs`, `Instant`, `Usage`, `ModelPrice`, `Limits`,
  `ToolPolicy`, `Prompt`, `ApprovalDecision`.
- **Pure core** (`src/core/`): the run guard state machine (turn / token / USD / wall-clock /
  tool-call limits, loop detection, kill switch), exact pricing, tool allowlist + approval
  decisions, message policy (duplicates, steer / queue / reject while busy, cancel, approvals),
  the thread state machine, conversation types (`ApprovalPolicy`, `RunOutcome`, `Reply`),
  idempotency keys and redaction (JWTs, AWS keys, e-mail, IBAN with mod-97, cards with Luhn).
- **Shell** (`src/shell/`): clocks, argument fingerprints, audit events + JSON-lines sink,
  `RunGuard` (what framework hooks call), config / settings loading with env overrides,
  `/invocations` parsing + JWT principal, reply rendering, a minimal **MCP client** (Streamable
  HTTP) and the **AgentCore Runtime HTTP server** (`GET /ping`, `POST /invocations`).

## Using it from a variant

The package is not published. A variant depends on it through a `file:` link and runs the
TypeScript sources directly under Node's type stripping (Node ≥ 22.6, no build step):

```jsonc
// templates/<family>/<variant>/package.json
"dependencies": { "@org/agents": "file:../../shared/ts/org-agents" }
```

- npm creates a **symlink**; Node resolves it to the real path outside `node_modules`, which is
  what allows type stripping (Node refuses to strip types for files inside `node_modules`).
  Do not use `install-links=true` or `--preserve-symlinks`.
- npm does **not** install the dependencies of a linked package: run
  `npm ci --ignore-scripts` in this directory first (also in Dockerfiles, before the variant's own
  `npm ci`).
- Variants that type-check these sources need `"allowImportingTsExtensions": true` (with `noEmit`)
  and `"module"/"moduleResolution": "nodenext"`, like `tsconfig.json` here.

```ts
import { loadSettings, RunGuard, SystemClock, JsonLinesAuditSink, killSwitchFrom, SessionId, unwrap } from "@org/agents";
import { McpClient } from "@org/agents/shell/mcpClient"; // every module is also a subpath export

const settings = unwrap(loadSettings(process.env));     // ParseError → fail fast at startup
const guard = new RunGuard({
  session, ...settings.agent,                             // limits, price, tools
  clock: new SystemClock(), audit: new JsonLinesAuditSink(),
  killSwitch: () => killSwitchFrom(process.env),
});
// before each model call:  guard.beforeModelCall()            → continue | stop
// after each model call:   guard.afterModelCall(usage)        → continue | stop
// before each tool call:   guard.beforeToolCall(name, rawArgs) → proceed | block_tool | require_approval | stop
// at the end:              guard.finish()
```

`startAgentCoreServer({ handler, host, port })` serves the AgentCore contract; the handler
receives a parsed `SessionId` and `Incoming` and returns a `Reply`, which is rendered to exactly the
JSON the Python variants return (`{"status": "completed", "answers": [...]}`, `approval_required`,
`stopped`, `steered` / `queued` / `cancelling` / `duplicate`, `refused`, and
`{"status": "invalid_request", "path", "error"}` for unparseable input).

## Standards applied

- Strict `tsc` (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `erasableSyntaxOnly`, `verbatimModuleSyntax`): only erasable syntax (no enums, namespaces,
  parameter properties or decorators), imports with explicit `.ts` extensions.
- Parse, don't validate: outside data is `unknown` and is parsed once into domain types; errors
  carry a JSON path (`$.limits.max_turns`). The wire format is not typed: `render` functions
  produce outbound JSON.
- Closed sets are string-literal unions; sum types are discriminated unions on `kind`, consumed
  by exhaustive `switch` closed with `assertNever`.
- Money is never a float: `Usd` is integer micro-dollars; costs are computed with `bigint` and
  rounded once (half-even), exactly like Python's `Decimal`.
- Functional core / imperative shell: `src/core` has no I/O, clock or randomness (it only uses
  `node:crypto`'s deterministic sha256 for idempotency keys).

## Dependencies

- Runtime: `smol-toml` (tiny, zero-dependency TOML parser; Node has no built-in TOML) for
  `config/agent.toml`.
- Dev: `typescript`, `@types/node`.
- All pinned exactly, published before the 7-day cooldown date (2026-09-20). No install scripts.

## Commands

```sh
npm ci --ignore-scripts
npm run typecheck   # tsc --noEmit
npm test            # node --test "test/**/*.test.ts"
```

`test/mcpClient.test.ts` starts the real Python MCP server of the generic tools
(`uv run --directory ../../../generic-agents/tools --extra mcp python -m generic_tools.shell.mcp_server`)
on a free port; it is skipped when `uv` is not installed. No test calls AWS or a model.
