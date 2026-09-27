# Coding Standards for Agent Templates

These rules apply to every template under `templates/`, in both Python and TypeScript. They exist so that agents written by developers and by vibe-coding authors (with AI assistants) stay safe, reviewable and testable.

## 1. Strong types and domain types

- **Type checkers in strict mode:**
  - Python: `mypy --strict` must pass.
  - TypeScript: `"strict": true`, `"noUncheckedIndexedAccess": true`, `"exactOptionalPropertyTypes": true`.
- **No `Any` / `any` in the core.** They are allowed only at the shell boundary, before parsing, and only as `object` / `unknown`.
- **Model the domain, not primitives.** A value with meaning gets its own type, even when it wraps a `str`, `int` or `Decimal`. For example `SessionId`, `ToolName`, `Usd`, `TurnLimit`, `TicketId`, `TicketPriority` and `Expression`.
  - **Python:** `@dataclass(frozen=True, slots=True)` value objects, `enum.Enum` for closed sets, and sum types as a `Union` of frozen dataclasses consumed with `match`.
  - **TypeScript:** branded types (`type Usd = number & { readonly __brand: "Usd" }`), `readonly` everywhere, and discriminated unions consumed with exhaustive `switch`, closed by `assertNever`.
- **Make illegal states unrepresentable.** Prefer a sum type to a record with optional fields and a status flag.
- **Money is never a float.** Use `Decimal` in Python, or integer micro-units in TypeScript.

This is not full domain-driven design: there are no aggregates or repositories unless they earn their place. It *is* a firm rule that meaningful values have types.

## 2. Parse, don't validate

Data from outside the program is **parsed once, at the boundary, into domain types**, or rejected there. After that, the core relies on the types and never re-checks. Outside data includes:
- HTTP payloads;
- environment variables and config files;
- tool arguments produced by the model;
- model structured output;
- API responses;
- files and CLI arguments.

```python
# shell: raw JSON from AgentCore → domain type (or ParseError at the boundary)
def parse_invocation(raw: object) -> Invocation:
    fields = expect_mapping(raw, path="$")
    prompt = Prompt.parse(expect_str(fields, "prompt", path="$"))
    return Invocation(prompt=prompt)
```

- A parser is a function `parse_x(raw: object) -> X` or a classmethod `X.parse(...)`. It raises `ParseError` (Python) or returns `Result<X, ParseError>` (TypeScript), with a path such as `$.prompt` so failures are actionable.
- A constructor that can fail is **private by convention**: create values through `parse`, or through core functions that preserve the invariants.
- **Do not add "validate" functions that return `bool` and leave the data untyped.**

## 3. Don't type the serialization format

Type safety means the **domain** is typed. A frequent mistake is to write TypedDicts, DTO classes or zod schemas that mirror the JSON shape and then call the code type-safe. We don't do that:
- Inbound JSON is `object` / `unknown`, and parsers turn it **directly** into domain types.
- Outbound JSON is produced by small `to_json(x) -> object` / `render` functions in the shell.
- **Where a framework requires a schema, it lives only in the shell adapter**, and its values are converted into domain types on the first line. Examples: Pydantic models for tool arguments or structured output in Pydantic AI, `@tool` signatures in Strands, TypeBox for pi tools, zod for opencode tools. Domain logic never receives a framework schema object.

## 4. Functional core, imperative shell

```
src/<package>/
├── domain.py      # types + parsers (pure)
├── core/          # decisions and business rules: pure functions over domain types, no I/O
└── shell/         # framework adapters, AWS/HTTP, clock, randomness, storage, env, logging
```

**The core:**
- No I/O and no framework imports.
- No clock or randomness: time, ids and random values are passed in as arguments.
- Deterministic; data in, data out.
- Decisions are returned as values (`Decision = Continue | BlockTool | Stop`) and the shell carries them out.

**The shell:**
- As thin as possible. It parses inputs, calls the core, performs the effects the core asked for, and renders outputs.

**Tests:**
- Core tests are plain unit tests: no mocks, no fakes, no network. Property-based tests where useful.
- Shell tests use fakes: a scripted fake model, in-memory stores and a fake clock. **No test calls AWS or a real model.**

## 5. Errors

- **Expected outcomes are values:** budget exceeded, tool blocked, approval needed, ticket not found. They are sum types, not exceptions.
- **Exceptions are for bugs and for failures at the boundary:** `ParseError`, infrastructure errors.
- Never swallow exceptions silently. Unexpected errors are logged as audit events and surfaced.

## 6. Agent-specific rules

- **Every agent goes through the shared controls** (`org_agents` / `@org/agents`): turn, token, USD, wall-clock and tool-call limits; loop detection; the tool allowlist; human approval for side-effecting tools; redaction; audit events. Templates must not bypass them.
- **Side-effecting tools are idempotent.** The key is derived in the core from the session and the canonical arguments.
- **Keep the prompt cache stable:** no timestamps or ids in the system prompt, a fixed tool list per session, and append-only history.
- **Secrets never reach the model or the logs.** Credentials come from the runtime role or AgentCore Identity and never from the environment of tool subprocesses.

## 7. Supply chain

- Every variant commits a lockfile: `uv.lock` or `package-lock.json`.
- Python projects set `[tool.uv] exclude-newer` to a date at least 7 days before the lock date (**cooldown**). Exceptions are listed per package, with a reason, in the variant README.
- npm installs use `--ignore-scripts`. Packages that require scripts are named and justified in the README.
- No `curl | bash` installs, and nothing is installed at runtime.
- New dependencies need a reason in the PR. Prefer the standard library.

## 8. Tooling

| | Python | TypeScript |
|---|---|---|
| Types | `mypy --strict` | `tsc --noEmit` (strict) |
| Tests | `pytest` | `node --test` (built in) |
| Lint / format | `ruff check` and `ruff format` | `tsc` plus the formatter configured in the variant, if any |
| Run | `uv run …` | `node --experimental-strip-types …` (Node ≥ 22.6) or `tsx` |
