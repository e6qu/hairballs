# Agentic Framework Scoping

**Purpose:** Pick a standard framework (or a small set) that staff can use to build promptable and autonomous AI agents inside a fintech. Authors include professional developers and non-developers who "vibe-code" with AI assistants.
**Primary platform:** Amazon Bedrock and Bedrock AgentCore.
**Hard constraints:** few dependencies, trusted dependencies, security-scannable artifacts, low supply-chain risk.
**Status:** Research and scoping. No code has been written yet. Section 11 lists the proof-of-concept work needed before a final decision.
**Decisions taken:**
- **2026-09-27: Platform commitment to AWS.** We accept being tied to AWS, Amazon Bedrock (models) and Bedrock AgentCore (agent platform). Portability to other clouds and model vendors is **not** a requirement. See §2 (R1, R11) and §10 (risk 8).
**Research date:** 2026-09-26/27. Every version, count and date below is as of that date.

---

## Contents

1. [Executive summary](#1-executive-summary)
2. [Requirements and evaluation criteria](#2-requirements-and-evaluation-criteria)
3. [Landscape and popularity (Hacker News, GitHub)](#3-landscape-and-popularity)
4. [Candidate profiles](#4-candidate-profiles)
5. [Supply-chain and dependency analysis](#5-supply-chain-and-dependency-analysis)
6. [How state-of-the-art agents are built](#6-how-state-of-the-art-agents-are-built)
7. [Runaway, cost and safety controls](#7-runaway-cost-and-safety-controls)
8. [Serving non-developer (vibe-coding) authors](#8-serving-non-developer-vibe-coding-authors)
9. [Recommendation](#9-recommendation)
10. [Risks and open questions](#10-risks-and-open-questions)
11. [Proof-of-concept plan](#11-proof-of-concept-plan)
12. [Appendix: method, raw data, sources](#12-appendix-method-raw-data-sources)

---

## 1. Executive summary

**Recommendation (subject to the PoC in §11):**

| Tier | Who | Standard | Why |
|---|---|---|---|
| **Tier 0: configure, don't code** | Non-developers, prompt authors, analysts | **Amazon Bedrock AgentCore managed harness**: agents declared as config (model, instructions, tools, skills). Tools come only from an approved catalog behind **AgentCore Gateway**, and **AgentCore Policy (Cedar)** authorizes each call. | Authors ship no application dependencies, which removes most supply-chain risk. Default runaway caps are built in: `maxIterations` 75, `timeoutSeconds` 3600, plus `maxTokens`. Each session runs in its own microVM. Everything is traced to CloudWatch and CloudTrail. AWS names this as the path forward from Bedrock Agents Classic. |
| **Tier 1: code on a paved road** | Developers, and vibe-coders who have graduated | **Strands Agents SDK** (Python first, TypeScript second), wrapped in an internal package that ships locked, hash-pinned dependencies, default limits, hooks, telemetry and templates. Deployed on AgentCore Runtime. | Bedrock-native and owned by AWS, so no new vendor to trust. Apache-2.0. Releases on PyPI carry PEP 740 attestations and npm releases carry provenance. It is the reference framework for AgentCore (CLI templates, evals, Classic import). Its harness uses the same primitives as Tier 0. |
| **Approved alternative, only with a written justification** | Teams with strict budget or durability needs | **Pydantic AI (`pydantic-ai-slim[bedrock]`)** | Smallest footprint measured (24 Python packages). PEP 740 attestations. Best built-in budget controls: request, token, tool-call and USD cost limits, on by default with `request_limit=50`. Native mid-run message queueing. Durable-execution integrations. The catch is a very fast release cadence (65 releases in 90 days). |

**Not approved as runtime dependencies:** LiteLLM, CrewAI, Mastra, Claude Agent SDK (as a runtime library), LlamaIndex agents, Google ADK, OpenAI Agents SDK when used with Bedrock, Microsoft Agent Framework (its Bedrock connector is beta), and the coding-agent harnesses (opencode, pi, Codex CLI, Claude Code) as a *platform for building agents*. Reasons are in §4 and §5. Several are still useful as developer tools or as design references.

**The five findings that drive the recommendation:**

1. **Supply-chain incidents in this ecosystem are real and recent.**
   - LiteLLM's PyPI package was trojaned on 2026-03-24 through a compromised Trivy GitHub Action in LiteLLM's own CI.
   - Mastra's npm packages were trojaned on 2026-06-17 through a former contributor's npm account.
   - The Nx "s1ngularity" malware (2025-08) drove the AI CLIs installed on developer machines to hunt for secrets.
   - Consequences for our choice: every dependency counts, provenance matters, and security scanners must themselves be pinned.
2. **Footprints vary by 5–20×** for the same job (§5.1).
   - Python: Pydantic AI slim = 24 packages, Strands = 48, CrewAI = 142.
   - npm: Vercel AI SDK = 20, Strands TS = 32 without auto-installed peers, Mastra = 152.
   - Claude Agent SDK bundles a **241 MB closed-source native binary** that dependency scanners cannot inspect.
3. **Few frameworks limit runaway agents by default** (§6.8).
   - LangGraph's default step cap is now **10,007**, effectively unbounded. Strands has **no** default turn limit. OpenAI Agents SDK defaults to 10 turns. Pydantic AI defaults to 50 requests.
   - The org standard therefore has to impose limits itself, through the AgentCore harness caps or our Tier 1 wrapper.
4. **Mid-run user messages are handled very differently** (§6.3).
   - Strands throws `ConcurrencyException`.
   - Pydantic AI queues the message (`asap` or `when_idle`).
   - Coding harnesses (Claude Code, Codex, pi, opencode) inject it as *steering* at the next tool boundary.
   - Chat-thread agents (for example in Slack) need an explicit policy for this. It belongs in the platform layer, not in each agent.
5. **Hacker News mindshare has moved from frameworks to harnesses** (§3).
   - Claude Code has about 28k comment mentions, opencode and OpenClaw about 4.8k each. The top framework, LangChain, has about 3.7k, mostly critical.
   - Strands is barely discussed: 11 comment mentions, and one real thread (the Strands Harness launch, 147 points).
   - We are choosing Strands for fit, provenance and AWS alignment, not for community momentum. That is a risk we accept (§10).

---

## 2. Requirements and evaluation criteria

| # | Requirement | Weight | How we assess it |
|---|---|---|---|
| R1 | **(Decided: AWS commitment)** Works natively with **Amazon Bedrock** (Converse API, cross-region inference, guardrails, prompt caching) and deploys to **AgentCore** | Must | Native provider vs. going through LiteLLM; AgentCore CLI template / sample / docs coverage |
| R2 | **Few, trusted dependencies** | Must | Transitive package count and size, measured (§5.1); native binaries; install scripts |
| R3 | **Supply-chain integrity** | Must | Release provenance (PEP 740 / npm provenance), trusted publishing vs. long-lived tokens, CI hygiene, incident history, release cadence |
| R4 | **Security-scannable** | Must | SBOM-friendly (pure packages, lockfiles), no opaque bundled binaries, OSV/GHSA coverage |
| R5 | **Promptable and autonomous agents**: tool use, multi-step loops, human-in-the-loop, sessions | Must | Loop model, HITL, persistence (§6) |
| R6 | **Runaway protection**: turn, token, cost, time and tool limits; loop detection; cancellation | Must | Defaults and mechanisms, from source (§6.8, §7) |
| R7 | **Usable by non-developers** through config or templates, with AI assistants able to generate correct code | Should | Declarative options, API simplicity, docs quality, how well AI assistants know the API |
| R8 | Observability and auditability (OpenTelemetry, CloudWatch, CloudTrail) | Should | Built-in OTel; AgentCore Observability / Evaluations support |
| R9 | Multi-agent composition (agents-as-tools, graphs, A2A) | Should | Primitives available |
| R10 | Longevity: vendor backing, license, API stability | Should | Owner, license, cadence, deprecations |
| R11 | ~~Model / cloud portability~~ | **Dropped** (decision of 2026-09-27) | Not assessed. Choice among the models Bedrock hosts is enough |

---

## 3. Landscape and popularity

### 3.1 Hacker News mentions (measured 2026-09-26)

Source: the HN Algolia API with exact-word matching (`queryType=prefixNone`, `typoTolerance=false`) and several aliases per product. "Points" is the sum across matched stories; "+" means the sum is capped at the top 1,000 stories. Comment mentions are the maximum `nbHits` across aliases, so they are an **undercount of discussion volume** but comparable across rows. Noisy names (pi, Haystack, Letta, Agno) are undercounted or excluded.

**Agent frameworks and SDKs**

| Framework | Stories | Points | Stories ≥100 pts | Comment mentions |
|---|---:|---:|---:|---:|
| LangChain | 1,116 | 14,065+ | 43 | 3,666 |
| LangGraph | 268 | 1,649 | 2 | 649 |
| LlamaIndex | 210 | 2,981 | 9 | 526 |
| AutoGen / AG2 | 123 | 680 | 2 | 389 |
| DSPy | 115 | 1,365 | 5 | 353 |
| CrewAI | 178 | 1,378 | 3 | 253 |
| Vercel AI SDK | 154 | 2,063 | 6 | 190 |
| Mastra | 56 | 1,291 | 4 | 169 |
| Claude Agent SDK (incl. "Claude Code SDK") | 102 | 1,769 | 6 | 120 |
| Pydantic AI | 68 | 619 | 2 | 114 |
| smolagents | 22 | 578 | 2 | 81 |
| OpenAI Agents SDK | 57 | 1,517 | 3 | 73 |
| Semantic Kernel | 67 | 321 | 0 | 70 |
| Google ADK | 51 | 346 | 1 | 49 |
| Bedrock AgentCore | 22 | 61 | 0 | 19 |
| **Strands Agents** | **21** | **286** | **1** | **11** |
| Microsoft Agent Framework | 20 | 116 | 0 | 7 |

**Agent harnesses (hackable coding agents)**

| Harness | Stories | Points | Stories ≥100 pts | Comment mentions |
|---|---:|---:|---:|---:|
| Claude Code | 7,046 | 85,704+ | 182+ | 28,253 |
| OpenClaw (built on pi) | 1,601 | 13,266+ | 26 | 4,791 |
| opencode | 619 | 9,692 | 18 | 4,780 |
| Aider | 186 | 2,346 | 6 | 2,562 |
| Gemini CLI | 338 | 5,764 | 13 | 1,547 |
| Cline | 202 | 1,808 | 5 | 1,336 |
| Codex CLI | 189 | 3,211 | 8 | 896 |
| pi (undercount: the name is unsearchable) | 80 | 1,516 | 3 | 330 |
| Goose | 21 | 440 | 1 | 120 |
| OpenHands | 34 | 343 | 1 | 109 |
| mini-swe-agent / SWE-agent | 32 | 569 | 2 | 81 |

### 3.2 Recurring themes in HN discussion

- **"LangChain is over-abstracted."** This is the strongest and most persistent theme ([40739982](https://news.ycombinator.com/item?id=40739982), [41141305](https://news.ycombinator.com/item?id=41141305)).
- **"An agent is just a while-loop with tools."** ([45158559](https://news.ycombinator.com/item?id=45158559)). The counter-argument is that production concerns (durability, limits, observability, sandboxing) are where frameworks earn their place. This matches our requirement set.
- **Framework churn and fatigue.** AutoGen has gone into maintenance mode, with Microsoft Agent Framework as its successor. LlamaIndex has shifted focus to LlamaParse.
- **Harness minimalism is praised.** pi's "Pi – A minimal terminal coding harness" (608 points, [47143754](https://news.ycombinator.com/item?id=47143754)); "Claude Code sends 33k tokens before reading the prompt; OpenCode sends 7k" (706 points, [48883275](https://news.ycombinator.com/item?id=48883275)).
- **Strands.** The only substantial thread is "Strands Harness" (147 points, 96 comments, 2026-09-23, [49817289](https://news.ycombinator.com/item?id=49817289)). Comments question the self-reported 28% token saving, since plain pi was left out of the benchmark and Terminal Bench 2.1 is saturated; a Strands team member committed to a pi run. Others remark on heavy AgentCore sales pressure. One commenter says AgentCore is "the best way to handle enterprise agentic workflows" because of its IAM and ARN governance.

### 3.3 GitHub stars (secondary signal)

| Project | Stars |
|---|---:|
| opencode | 210k |
| Claude Code | 148k |
| LangChain | 147k |
| Codex | 127k |
| pi | ~110k (approximate) |
| AutoGen | 61k (in maintenance) |
| CrewAI | 59k |
| LlamaIndex | 52k |
| LangGraph | 42k |
| OpenAI Agents SDK | 30k |
| smolagents | 30k |
| Mastra | 28k |
| Vercel AI SDK | 27k |
| Google ADK | 22k |
| Pydantic AI | 20k |
| Microsoft Agent Framework | 14k |
| **Strands (harness-sdk monorepo)** | **8.5k** |
| Claude Agent SDK (Python) | 8.2k |

---

## 4. Candidate profiles

Versions are taken from PyPI and npm on 2026-09-26/27.

### 4.1 Strands Agents (AWS): primary candidate

- **Versions and license:** `strands-agents` 1.57.1 (Python) and `@strands-agents/sdk` 1.19.0 (TypeScript, 1.0 reached 2026-04-30). Apache-2.0. The repo is now the monorepo [`strands-agents/harness-sdk`](https://github.com/strands-agents/harness-sdk) (formerly `sdk-python`).
- **History:** preview in May 2025; 1.0 in July 2025. AWS says it powers "thousands of agents at Amazon" (the Q Developer and Glue teams among them).
- **Model:** a model-driven loop (`Agent` + `@tool`). The LLM plans. Graph, Swarm and Workflow patterns are available when the flow must be deterministic.
- **Providers:** Bedrock is the default (native Converse). Also Anthropic, OpenAI, Gemini, LiteLLM, Ollama, Mistral, llama.cpp, SageMaker and Writer.
- **Features:** MCP client; A2A server and client; typed hooks; interrupts for HITL; session managers (file, S3, repository, snapshot); a conversation/context manager (sliding window, summarizing, "auto"); structured output; OTel tracing; a separate evals package.
- **Strands harness** (2026-09-21): `create_harness()` returns a plain `Agent` with batteries included:
  - shell and file tools, web access, a sandbox;
  - auto context management and on-disk sessions;
  - memory and skills;
  - MCP support;
  - Cedar or "ask" tool gates.
  AWS claims it uses 28% fewer tokens than rival harnesses. That is a vendor benchmark and is disputed on HN.
- **AgentCore fit:**
  - the default framework in the AgentCore CLI (`agentcore create --framework Strands`), in both Python and TypeScript;
  - built-in telemetry recognised by AgentCore Evaluations;
  - Bedrock Agents Classic configurations can be imported as Strands code.
- **Weaknesses:**
  - Weekly releases, and several features are marked `experimental` (steering, checkpointing, bidirectional streaming).
  - No default turn limit, and single-agent loops have no loop detection.
  - A bare `Agent()` needs Bedrock credentials and model access.
  - The Python core pulls in MCP, OpenTelemetry SDK, uvicorn, starlette and watchdog even if you don't use them (§5.1).
  - Weak CI hygiene: only 20 of 199 GitHub Actions are SHA-pinned, and there are several `pull_request_target` workflows, though these are behind an authorization gate.
  - Low community mindshare.

### 4.2 Pydantic AI: approved alternative

- **Version and license:** `pydantic-ai-slim` 2.51.0. MIT. Built by Pydantic Inc.
- **Model:** a typed agent loop implemented as a pydantic-graph state machine, with "capabilities" as middleware.
- **Bedrock:** native (`bedrock` extra; also `bedrock-mantle`, the OpenAI-compatible Bedrock endpoint).
- **Controls:** the best of any framework reviewed.
  - `UsageLimits`: `request_limit` (default 50), token limits (cumulative and per request), `tool_calls_limit`, and **`cost_limit` in USD**. All raise `UsageLimitExceeded`.
  - Per-tool timeouts.
  - `AgentRun.enqueue()` for mid-run messages.
  - Deferred-tool HITL.
  - Durable execution through Temporal, DBOS or Prefect.
- **Supply chain:** 24 Python packages and PEP 740 attestations. Its repo pins 913 of 914 Actions to SHAs.
- **Weaknesses:**
  - 65 releases in 90 days, a heavy burden when every update must be reviewed.
  - No built-in session store; the application passes `message_history` itself.
  - No handoff primitive (you delegate through tools).
  - AgentCore coverage is limited to samples: no CLI template and no evaluations support page.
  - A new vendor relationship.

### 4.3 LangGraph / LangChain v1: conditional (not recommended)

- **Versions and license:** `langgraph` 1.2.12, `langchain` 1.4.2, `langchain-aws` 1.7.9. MIT.
- **Strengths:**
  - The most mature explicit state machine: checkpointers (SQLite, Postgres), `interrupt()`/`Command(resume)`, time travel.
  - A strong middleware set (model/tool call limits, summarization, context editing, HITL).
  - Native Bedrock support; an AgentCore CLI template and evaluations support.
- **Against:**
  - The default `recursion_limit` is **10,007**; `create_agent` sets 9,999.
  - Serialization CVEs: "LangGrinch" CVE-2025-68664, and a msgpack checkpoint deserialization issue, CVE-2026-28277.
  - OpenSSF Scorecard 5.6, with Token-Permissions 0 and Signed-Releases 0.
  - Python packages publish without PEP 740 attestations.
  - Much of the best tooling (LangSmith, Deployment) is commercial.
  - The strongest negative sentiment on HN.
  - Consider it only for teams that need explicit, checkpointed graph workflows *and* cannot express them with Strands `Graph`.

### 4.4 OpenAI Agents SDK: not for Bedrock

- **Versions and license:** `openai-agents` 0.22.3 (still pre-1.0), `@openai/agents` 0.18.0. MIT.
- **Strengths:** clean primitives (handoffs, guardrails, sessions); `max_turns=10` by default; strong provenance (PEP 740 plus npm provenance); every GitHub Action SHA-pinned.
- **Against:**
  - Bedrock is reached only through LiteLLM or `any-llm`, and **LiteLLM is excluded** (§5.3).
  - The AgentCore CLI template for this framework allows the **OpenAI provider only**.
  - No token or cost limit.
  - Tracing goes to OpenAI by default.

### 4.5 Claude Agent SDK: developer tool, not a runtime standard

- **Versions and license:** Python `claude-agent-sdk` 0.2.160 (MIT); TypeScript 0.3.283 ("see README"). The bundled Claude Code CLI is proprietary.
- **Strengths:**
  - The strongest agent harness: auto-compaction, sub-agents, skills, hooks, permission modes, an OS sandbox.
  - `max_turns` and `max_budget_usd`.
  - Native Bedrock support (`CLAUDE_CODE_USE_BEDROCK=1`).
  - AgentCore samples and evaluations support.
- **Against (decisive for our constraints):**
  - Every install ships a **241 MB opaque native binary**, which SCA tools can't inspect.
  - **No release provenance.** PyPI uploads use a long-lived API token, and npm is published from a personal account without provenance.
  - Claude models only.
  - Wraps the CLI in a subprocess.
  - 28 GHSAs against Claude Code between 2025-06 and 2026-07, including permission bypasses and sandbox escapes.
  - 50 Python and 78 npm releases in 90 days.
- **Verdict:** fine as a developer productivity tool under the existing developer-tooling policy, but not the base for agents we ship.

### 4.6 Others (brief)

| Candidate | Verdict | Key reasons |
|---|---|---|
| **CrewAI** 1.15.22 | Exclude | 142 packages, 722 MB installed, pulls in `onnxruntime`, `pyarrow`, `chromadb`/`lancedb`; no provenance; 94 releases in 90 days; enterprise features sit in a commercial product |
| **Mastra** 1.71.0 (TypeScript) | Exclude | **Compromised on npm 2026-06-17** (about 144 malicious versions); 152 packages; bundles `posthog-node`; some features under the source-available `ee/` license |
| **Vercel AI SDK** (`ai` + `@ai-sdk/amazon-bedrock`) | Watch (TypeScript) | Smallest TS footprint (20 packages) with provenance, and an AgentCore CLI template. But 240 + 177 releases in 90 days, and it is an LLM toolkit rather than an agent framework with limits and HITL |
| **Google ADK** 2.10.0 | Exclude | Gemini-first; the AgentCore template allows **Gemini only**; Bedrock only through LiteLLM; npm package has install scripts (`cpu-features`, `ssh2`); no provenance |
| **LlamaIndex** 0.14.x | Exclude | Company focus has moved to LlamaParse; 69 packages; no provenance (long-lived token); still 0.x |
| **Microsoft Agent Framework** 1.19.0 | Exclude | Azure-centric; Bedrock connector is still beta (`1.0.0b260918`) |
| **AutoGen / AG2** | Exclude | AutoGen is in maintenance mode; AG2 is a community fork |
| **smolagents** 1.26.0 | Exclude | Code-execution agents (sandbox escape CVE-2025-5120); last release May 2026; no production tooling |
| **LiteLLM** | **Ban as a dependency** | **Compromised on PyPI 2026-03-24**; about 20 proxy CVEs in April–June 2026; 92 releases in 90 days. See §5.3 |

### 4.7 Hackable harnesses: design references, not platforms

| Harness | License / language | Bedrock | Embedding surface | Why it is not our platform |
|---|---|---|---|---|
| **opencode** | MIT / TS (Bun) | Native (AI SDK) | HTTP server (OpenAPI + SSE), JS SDK, plugins | Tied to a coding workspace; 354 MB native binary installed by a **postinstall** script, which breaks with `ignore-scripts`; CVE-2026-22812 (unauthenticated HTTP server able to run commands); 1,472 npm versions |
| **pi** (pi-mono) | MIT / TS | Native (pi-ai) | `pi-agent-core` library, TS extensions, RPC mode | Deliberately **no permissions** ("YOLO") and no MCP; extensions run in-process with full OS rights; `pi-ai` always installs every provider SDK (117 packages, with install scripts). The **loop design is excellent** (§6) and worth copying |
| **Codex CLI** | Apache-2.0 / Rust | Native, but OpenAI models only | `exec`, JSON-RPC app-server, TS SDK | Single model vendor on Bedrock; a coding tool |
| **Claude Code** | Proprietary | Native, Claude only | Agent SDK | See §4.5 |
| **Goose** (Linux Foundation / AAIF) | Apache-2.0 / Rust | Native | CLI, desktop, API; MCP-only extensions | Low traction; desktop-oriented |

**What these harnesses teach us:**
- steering and queued follow-ups;
- append-only JSONL sessions with branching;
- cache-preserving context layout;
- tool-output truncation and pruning;
- detecting an agent stuck in a loop;
- sub-agents with limited nesting depth;
- OS sandboxes.

We should carry these into the Tier 1 wrapper and the platform design (§6, §9).

---

## 5. Supply-chain and dependency analysis

### 5.1 Measured dependency footprint

**Method:**
- Python: `uv pip compile` for Python 3.12 on Linux; installed size from a fresh `uv` virtualenv.
- npm: `npm install --ignore-scripts` with npm 10.9.7. npm auto-installs non-optional peer dependencies, so the Strands TS row is shown both ways.
- Counts are **transitive packages including the root**, measured on 2026-09-27.

**Python**

| Install spec | Packages | Installed size | Compiled / native extensions |
|---|---:|---:|---|
| `boto3` (baseline) | 7 | 32 MB | none |
| `ag2[bedrock]` | 21 | – | pydantic-core |
| `anthropic[bedrock]` (baseline) | 22 | – | jiter, pydantic-core |
| `bedrock-agentcore` | 20 | – | pydantic-core |
| **`pydantic-ai-slim[bedrock]`** | **24** | **52 MB** | pydantic-core |
| `mcp` (baseline) | 28 | – | cryptography, pydantic-core, rpds-py |
| `claude-agent-sdk` | 30 | **263 MB** (231 MB is the bundled binary) | cryptography, pydantic-core, rpds-py, **plus an opaque 241 MB native CLI** |
| `smolagents[bedrock]` | 34 | – | – |
| `openai-agents` | 38 | 55 MB | cryptography, jiter, pydantic-core, rpds-py |
| `langgraph langchain-aws` | 46 | 141 MB | numpy, orjson, pydantic-core, xxhash, zstandard |
| **`strands-agents`** | **48** | **75 MB** | cryptography, opentelemetry-sdk, pydantic-core, rpds-py |
| `google-adk` | 48 | 69 MB | cryptography, opentelemetry-sdk, pydantic-core, rpds-py |
| `litellm` | 55 | – | aiohttp, tiktoken, tokenizers, … |
| `strands-harness` | 59 | 89 MB | as Strands |
| `openai-agents[litellm]` | 64 | – | + tokenizers, tiktoken, numpy, aiohttp |
| `llama-index-core` + Bedrock Converse | 69 | 211 MB | numpy, sqlalchemy, greenlet, tiktoken, aiohttp |
| `strands-agents strands-agents-tools` | 75 | – | + aiohttp |
| `pydantic-ai` (full) | 99 | – | + tiktoken, opentelemetry-sdk, … |
| `crewai[bedrock]` | **142** | **722 MB** | onnxruntime, pyarrow, grpcio, tokenizers, numpy, … |

`strands-agents` pulls in these packages that `pydantic-ai-slim[bedrock]` does not: `mcp`, `mcp-types`, `opentelemetry-sdk` and instrumentation, `starlette`, `sse-starlette`, `uvicorn`, `python-multipart`, `pyjwt`, `cryptography`, `jsonschema`, `watchdog`, `pyyaml`, `wrapt`, `click`, `docstring-parser`. Much of this is MCP server and client support that a minimal agent never uses. **Action for the PoC:** ask upstream or measure whether an `extras`-based split is feasible, and track it as a risk (§10).

**npm**

| Install spec | Packages | Size | Install scripts |
|---|---:|---:|---|
| `@opencode-ai/sdk` (client only) | 7 | 2 MB | – |
| `opencode-ai` | 13 | 354 MB (native binaries) | **postinstall (required)** |
| **`ai` + `@ai-sdk/amazon-bedrock`** | **20** | 40 MB | – |
| `@openai/agents` | 25 | 78 MB | – |
| `@aws-sdk/client-bedrock-runtime` (baseline) | 28 | 17 MB | – |
| **`@strands-agents/sdk`, peers not installed** | **32** | 26 MB | – |
| `@langchain/langgraph` + core + aws | 53 | 86 MB | – |
| `@modelcontextprotocol/sdk` (baseline) | 94 | 29 MB | – |
| `@anthropic-ai/claude-agent-sdk` | 110 | 281 MB (241 MB native binary) | – |
| `@earendil-works/pi-agent-core` + `pi-ai` | 117 | 115 MB | `@google/genai`, `esbuild`, `protobufjs` |
| `@strands-agents/sdk`, peers auto-installed | 127 | 57 MB | – |
| `@mastra/core` | 152 | 131 MB | – |
| `@google/adk` | 166 | 128 MB | `@google/genai`, `cpu-features`, `protobufjs`, `ssh2` |
| `@strands-agents/harness` | 194 | 173 MB | `esbuild`, `fsevents` |

The Strands TS core declares only 5 hard dependencies (`@aws-sdk/client-bedrock-runtime`, `@smithy/fetch-http-handler`, `@types/json-schema`, `uuid`, `yaml`). Everything else (MCP, OTel, OpenAI, Anthropic, Gemini, express, zod, Cedar WASM) is an **optional peer**. Install with `legacy-peer-deps` or pnpm and add only the peers you need.

### 5.2 Provenance, ownership, CI hygiene and release cadence

Columns:
- **Provenance:** PyPI PEP 740 attestations / npm provenance.
- **90-day releases:** 2026-06-29 to 2026-09-27.
- **Actions SHA-pinned:** GitHub Actions in the repo's workflows pinned to a full commit SHA (a partial stand-in for OpenSSF Scorecard, which has not published scores for most of these repos).

| Package | Owner | Provenance | Publish method | 90-day releases | Actions SHA-pinned | Scorecard |
|---|---|---|---|---:|---|---|
| strands-agents | AWS | **PEP 740 yes** | Trusted Publishing | 15 | 20/199 | n/a |
| @strands-agents/sdk | AWS | **npm provenance yes** | trusted publisher | 14 | 0/28 (old repo) | n/a |
| pydantic-ai-slim | Pydantic | **PEP 740 yes** | Trusted Publishing | **65** | 913/914 | n/a |
| openai-agents / @openai/agents | OpenAI | **PEP 740 yes / npm yes** | Trusted Publishing | 17 / 18 | 47/47, 33/33 | n/a |
| langgraph / langchain-aws | LangChain | no PEP 740; npm yes | Trusted Publishing (no attestations) | 6 / 13 | 62/62, 0/30 | langchain 5.6 |
| claude-agent-sdk | Anthropic | **none** | **long-lived PyPI token**; npm from a personal account | 50 / 78 | 5/42 | n/a |
| crewai | CrewAI | none | – | 94 | 60/60 | n/a |
| google-adk | Google | none | uv publish | 19 | 50/50 | n/a |
| llama-index-core | LlamaIndex | none | long-lived token | 2 | 0/39 | n/a |
| @mastra/core | Mastra | npm yes (added after the incident) | – | 297 (28 stable) | 148/148 | n/a |
| ai / @ai-sdk/amazon-bedrock | Vercel | npm yes | – | 240 / 177 | 70/70 | n/a |
| pi-ai / pi-agent-core | Earendil | npm yes | – | 23 | 39/39 | n/a |
| litellm | BerriAI | none | – | 92 | 172/172 (after the incident) | 5.9 |
| mcp / @modelcontextprotocol/sdk | MCP project | PEP 740 yes / npm yes | Trusted Publishing | 11 / 2 | 44/44, 16/45 | n/a |
| boto3 | AWS | none | – | 67 (daily) | – | **7.4** |

**What this means for us:**
- Provenance lets us check automatically that a package came from the expected repo and workflow. That would have flagged Nx, whose malicious versions *lacked* provenance.
- **Strands, Pydantic AI, OpenAI Agents and MCP pass this check. Claude Agent SDK, CrewAI, ADK, LlamaIndex and LiteLLM do not.**
- A high release cadence is a separate risk. Each release is an opportunity for a malicious publish and a review burden for us. Pydantic AI and the Vercel AI SDK are the outliers.

### 5.3 Incidents relevant to this decision (2024–2026)

| Date | Incident | Relevance |
|---|---|---|
| 2024-12 | **Ultralytics (PyPI)**: crypto-miner releases through a GitHub Actions cache/injection (PYSEC-2024-154) | CI-to-registry attack pattern |
| 2025-06/07 | **MCP tooling**: MCP Inspector unauthenticated RCE CVE-2025-49596; `mcp-remote` command injection CVE-2025-6514; later MCP SDK CVEs (DNS rebinding, ReDoS, cross-client data leak) | MCP is a runtime attack surface. Use only vetted MCP servers behind AgentCore Gateway |
| 2025-08-26 | **Nx "s1ngularity"**: malicious `nx` versions with a postinstall stealer that invoked local AI CLIs with permission-skipping flags to hunt for secrets (CVE-2025-10894) | Install scripts plus AI CLIs on developer machines holding credentials is a proven attack chain |
| 2025-09 → 2026-05 | **Shai-Hulud npm worms**, including 2026 "Mini Shai-Hulud" waves that hit TanStack, **Mistral AI (npm and PyPI)**, UiPath and SAP packages | Self-propagating compromise of maintainer tokens |
| 2025-12-23 | **LangChain "LangGrinch"** serialization injection, CVE-2025-68664 | Framework-level vulnerability that can extract secrets |
| 2026-02 | **ClawHub / OpenClaw "ClawHavoc"**: hundreds of malicious agent *skills* (secondary sources) | Skill and plugin marketplaces are a supply chain too. Allowlist skills |
| 2026-03-19 | **Trivy / aquasecurity actions** ("TeamPCP"): 76 of 77 `trivy-action` tags force-pushed with a stealer (CVE-2026-33634) | **Security scanners are themselves an attack vector.** Pin scanners by digest or SHA |
| **2026-03-24** | **LiteLLM PyPI compromise**: 1.82.7/1.82.8 stole environment variables and cloud credentials; `.pth` persistence ran on any Python start; live about 40 minutes; root cause was a PyPI token stolen through Trivy in their CI (GHSA-5mg7-485q-xm76) | Direct hit on an agent-ecosystem dependency. **Basis for banning LiteLLM** |
| **2026-06-17** | **Mastra npm compromise**: a former contributor's still-active npm account published about 144 `@mastra/*` versions with a typosquat dependency whose postinstall dropped a RAT (MAL-2026-6011) | Blocking install scripts would have stopped it. Access revocation matters |
| 2025–2026 | **Harness CVEs**: 28 GHSAs against Claude Code (permission bypass, pre-trust execution, sandbox escape); Codex CLI CVE-2025-59532 and CVE-2025-61260; opencode CVE-2026-22812 and CVE-2026-22813 | Harnesses have a large attack surface. Another reason not to embed one as our runtime |
| 2026 | Framework CVEs: Pydantic AI SSRF (CVE-2026-25580 and others); Google ADK CVE-2026-4810; Vercel `ai` CVE-2025-48985. **No OSV entries** for strands-agents, openai-agents, claude-agent-sdk, crewai | "No CVEs" can also mean "little scrutiny". Plan for them anyway |

### 5.4 Required supply-chain controls, whatever framework we choose

1. **Private mirror:** AWS CodeArtifact, with upstream PyPI and npm behind an allowlist and a **cooldown**. Staff and CI resolve only through it.
2. **Cooldowns** (each would have skipped LiteLLM, Nx, Mastra and Mini Shai-Hulud):
   - uv: `exclude-newer = "7 days"`
   - pip: `--uploaded-prior-to P7D`
   - npm: `min-release-age`
   - pnpm: `minimumReleaseAge` (plus `trustPolicy`)
3. **Lock and hash-pin:**
   - Python: `uv lock` with hashes, installed via `uv sync --locked`
   - npm: `npm ci` / `pnpm install --frozen-lockfile`
   - Agent templates ship with a pre-built lockfile.
4. **Block install scripts:**
   - pnpm: default behaviour, plus an `onlyBuiltDependencies` allowlist
   - npm: `ignore-scripts=true` or the newer `allowScripts` allowlist
   - Candidates that break without scripts: only `opencode-ai`.
5. **Provenance gate:**
   - npm: `npm audit signatures` (or pnpm `trustPolicy`)
   - Python: verify PEP 740 attestations at mirror import for the frameworks that publish them
   - Alert whenever a previously attested package stops being attested.
6. **SBOM and scanning:**
   - SBOM generation: syft or CycloneDX
   - Scanners: `osv-scanner` (catches `MAL-` entries), `pip-audit`, Grype, Amazon Inspector (flagged Mastra), Socket (behavioral, install-script detection), Dependabot
   - **Pin the scanners themselves** by SHA or digest (the Trivy lesson).
7. **No opaque bundled binaries in runtime images.** This excludes Claude Agent SDK and opencode as runtime dependencies.
8. **CI hardening for our own repos:**
   - Pin Actions to SHAs, use OIDC and no long-lived tokens, least-privilege `GITHUB_TOKEN`.
   - No `pull_request_target` without a gate.
   - Revoke access when people leave (the Mastra lesson).
9. **AI coding CLIs on developer machines:** forbid permission-bypass modes on machines that hold production credentials; prefer sandboxed modes (the s1ngularity lesson).
10. **Skills, MCP servers and plugins are dependencies too.** Keep them in an internal registry and review them like code. Expose them through AgentCore Gateway, not as ad-hoc local MCP servers.

---

## 6. How state-of-the-art agents are built

This section is based on reading the **source code** of Strands, Pydantic AI, OpenAI Agents SDK, LangGraph/LangChain, pi, opencode and Codex CLI, plus the official docs for Claude Code / the Claude Agent SDK and the AgentCore managed harness. Commit SHAs are listed in §12.

### 6.1 The agent loop

Every system reviewed implements the same core loop:

```
history = [system, tools, ...previous messages, user message]
loop:
    check limits / cancellation / budget          # before each model call
    response = model(history)                      # streamed
    append(response)
    if response has no tool calls: stop            # "end_turn"
    results = execute(tool calls)                  # parallel where safe; permission-checked
    append(results)
    maybe: inject steering messages, compact context, detect loops
```

How each system implements it:

| System | What one iteration is called | Loop implementation | Parallel tools |
|---|---|---|---|
| Strands | "cycle": `event_loop_cycle()`, recursive while `stop_reason == tool_use` | recursion plus hooks | yes (`ConcurrentToolExecutor` default; sequential available) |
| Pydantic AI | graph nodes: `UserPromptNode → ModelRequestNode → CallToolsNode` | pydantic-graph state machine; step-able via `agent.iter()` | yes (`parallel` / `sequential` / `parallel_ordered_events`; per-tool `sequential=True` barrier) |
| OpenAI Agents SDK | "turn" = one model invocation including its tool calls | `while True` in `run.py` resolving `FinalOutput / Handoff / RunAgain / Interruption` | yes (asyncio; `max_function_tool_concurrency`) |
| LangGraph `create_agent` | Pregel "superstep"; model → tools ≈ 2 steps | graph `model ⇄ tools`, `Send` per tool call | yes (one task per tool call) |
| pi | "turn" = one assistant message plus its tool results | an inner loop (tools + steering) nested in an outer loop (follow-ups) | yes, unless a tool is marked sequential |
| opencode | one `streamText` step; state re-read from SQLite each step | `while(true)` in `session/prompt.ts` | via the AI SDK |
| Codex CLI | "turn" = one user submission containing N sampling requests | `loop {}` in `session/turn.rs` | RwLock: parallel-safe tools run concurrently, others exclusively |
| Claude Code | "turn" = one model round trip with tools | closed source (docs) | read-only tools concurrent; Edit/Write/Bash sequential |

**Standard for us:**
- Run read-only tools in parallel.
- Run **side-effecting tools sequentially, with idempotency keys** (payments, tickets, emails).
- Treat hitting the output-token limit mid-tool-call as a failure. pi fails every tool call in that case, because the arguments may be truncated.

### 6.2 Turns, stop conditions and results

- A run ends when the model returns no tool calls, when a limit or cancellation fires, or on an interrupt (HITL).
- Good systems return a **typed stop reason** rather than only raising an exception:
  - Strands: `end_turn`, `limit_turns`, `limit_total_tokens`, `cancelled`, `interrupt`
  - Claude Agent SDK: `terminal_reason = completed | max_turns | aborted_*`
  - OpenAI: raises `MaxTurnsExceeded`, unless an error handler turns it into a final output
- **Standard:** every agent run records `stop_reason`, token usage (input, output, cache read, cache write), cost, turn count, tool-call count and duration, and emits them as OTel attributes and an audit event.

### 6.3 User interaction and messages arriving mid-run

The user sends a message while the agent is still working. There are four strategies:

| Strategy | Meaning | Who does it |
|---|---|---|
| **Reject** | Error while a run is active | Strands (`ConcurrencyException`, default `THROW`); pi `prompt()` throws, telling you to use `steer()` / `followUp()`; LangGraph Server `multitask_strategy=reject` |
| **Steer (inject at the next boundary)** | Deliver the message after the current model response and its tool batch finish, *within the same run* | pi `steer()`; Claude Code (Enter while working, delivered "as soon as those tool calls finish, within the same turn"); Codex (`pending_input` drained at the top of the next sampling iteration); opencode (a persisted message joins the running loop at the next step); Pydantic AI `enqueue(priority="asap")` |
| **Queue (follow-up)** | Deliver only when the agent would otherwise stop | pi `followUp()`; Codex (Tab queues); Pydantic AI `enqueue(priority="when_idle")`; LangGraph Server `enqueue` |
| **Interrupt** | Abort the current run, keep what was done, start again with the new message | Esc in pi, Codex and Claude Code; OpenAI `cancel(mode="immediate" \| "after_turn")`; LangGraph Server `interrupt` / `rollback` |

**How aborts are recorded** (important for audit and correctness):
- pi saves the aborted message but **skips it when replaying** to the model, and synthesizes results for orphaned tool calls.
- Codex writes a model-visible `<turn_aborted>` marker saying tools "may have partially executed".
- opencode keeps the partial message, marked `Aborted`.
- Claude Code "keeps the work done so far".

**Standard for chat and thread agents (Slack, Teams, web chat):**
1. **One active run per thread.** The thread ID maps to the session ID.
2. **Default policy:**
   - A new message in a busy thread is **steered** in at the next tool boundary.
   - If the run is waiting on HITL approval, the message is delivered as the approval response or queued.
   - "stop" / "cancel" keywords or a button **interrupt** the run.
3. **Deduplicate inbound events** by message ID. Chat platforms retry webhooks.
4. **Multiple humans in one thread:** attribute every message to a user identity. Only users entitled to approve a pending action can approve it; others are queued. Log the approver.
5. **Record aborts explicitly** in history, Codex-style, so the model knows side effects may be partial. Never silently drop partial tool calls.
6. Strands does not do steering natively (it rejects). We implement it in the wrapper with a per-session message queue drained in a `BeforeModelCallEvent` hook, or adopt Pydantic AI's `enqueue` semantics if we use Pydantic AI. **This is a PoC item.**

### 6.4 Threads, sessions and persistence

| System | Storage | Branch / fork / resume |
|---|---|---|
| Strands | `FileSessionManager`, `S3SessionManager`, repository and snapshot managers; harness: `./.agent/sessions` | resume by session ID; experimental checkpoints |
| Pydantic AI | none built in: `message_history` in, `all_messages()` out | durable execution through Temporal / DBOS / Prefect |
| OpenAI Agents | `Session` protocol: SQLite, Redis, SQLAlchemy, Mongo, Dapr, encrypted; server-side Conversations | serializable `RunState` for HITL resume |
| LangGraph | checkpointers (memory, SQLite, Postgres) per superstep, keyed by `thread_id` | time travel, resume, fork |
| pi | **append-only JSONL tree** (`id` / `parentId`) under `~/.pi/agent/sessions/` | `branch()`, `/tree`, forks record `parentSession` |
| opencode | SQLite (`opencode.db`, Drizzle) | `fork`, revert via git snapshots, child sessions via `parentID` |
| Codex | JSONL "rollouts" (`~/.codex/sessions/YYYY/MM/DD/…`) plus a SQLite state DB | `fork_thread`, resume by replay |
| Claude Code | JSONL at `~/.claude/projects/<cwd>/*.jsonl` | `resume`, `fork_session`, `resume_session_at`, `/rewind` |
| AgentCore harness | managed: AgentCore Memory (short- and long-term); microVM filesystem persists across sessions | session ID; memory strategies |

**Standard:**
- Use **append-only**, event-sourced session storage with message IDs and parent IDs. It is audit-friendly, supports branching, and is what the leading harnesses converged on.
- Store in S3 or DynamoDB with KMS encryption, a retention policy and legal hold, or use AgentCore Memory for Tier 0.
- Persist tool calls **and** results, stop reasons, usage and approvals.
- Never persist secrets returned by tools; redact at write time.

### 6.5 Context management (compaction)

| System | Trigger | Algorithm | Old tool results |
|---|---|---|---|
| Strands (default) | reactive, on context overflow | `SlidingWindowConversationManager(window_size=40)` | truncated only on overflow |
| Strands `context_manager="auto"` (harness default) | proactive | truncate tool results over 1,500 tokens to a 750-token preview; summarize at 85% of the window; emergency truncate | offloaded to storage behind a reference |
| Pydantic AI | via `history_processors` | provider compaction (Anthropic, OpenAI) | – |
| LangGraph | middleware | `SummarizationMiddleware`, `ContextEditingMiddleware` (clear tool uses at 100k tokens, keep 3) | placeholder replacement |
| pi | `tokens > window − 16k` | cut about 20k recent tokens, summarize the rest with a structured prompt (iterative) | truncated at 2,000 lines / 50 KB |
| opencode | `tokens ≥ input limit − min(20k, max output)` | LLM summary message; older messages hidden | **pruned** beyond the most recent 40k tokens of tool output → "[Old tool result content cleared]" |
| Codex | 90% of the window | local summary plus recent user messages (≤20k), or provider-side compaction | per-model truncation policy |
| Claude Code | near the window limit | summary, then re-inject CLAUDE.md, plan, recent files and skills from disk | cleared; re-read on demand |
| AgentCore harness | configurable | `sliding_window` (default) / `summarization` / `none` | – |

**Standard:**
- Cap every tool's output at the tool boundary (around 2,000 lines or 50 KB, with a pointer to the full result in S3).
- Use Strands' `context_manager="auto"` or its equivalent.
- **Compaction must be auditable**: store the pre-compaction transcript. Summaries can lose regulatory detail, so for regulated flows prefer deterministic truncation plus retrieval over LLM summaries.

### 6.6 Prompt caching and the KV cache

**What the KV cache is:**
- During prefill, a transformer computes key/value tensors for every prompt token.
- Providers keep these for recently seen **exact token prefixes** (same model, same account). A later request that starts with the same bytes reuses them and skips recomputation.
- The saving is large: cached input costs about **0.1× the normal input price** (Anthropic and Bedrock Claude; some newer models are lower still), and latency drops.
- **One changed token invalidates everything after it.** Agents are ideal for caching because each step re-sends a long, mostly identical prefix. Manus reports an input-to-output token ratio of about 100:1.

**Bedrock prompt caching** ([docs](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html)):
- Explicit `cachePoint` blocks in the Converse API (`tools`, `system`, `messages`).
- **Up to 4 checkpoints per request.**
- A minimum of **512–4,096 tokens before a checkpoint**, depending on the model. Below the minimum the request succeeds but nothing is cached.
- **TTL 5 minutes**, reset on each hit. **1 hour** on supported newer Claude models; in one request, 1-hour entries must come before 5-minute ones.
- Processing order is tools → system → messages. **Changing tools invalidates everything after them.**
- "Simplified" mode looks back about 20 blocks from a single checkpoint.
- Usage is reported as `cacheReadInputTokens` / `cacheWriteInputTokens`.
- Cache writes cost more than normal input (1.25× for 5-minute, 2× for 1-hour on Anthropic pricing) and reads cost far less.
- Works with cross-region inference, though it may write more often under load. Not available for batch inference.

**Automatic caching support in the frameworks:**

| System | Automatic? | Mechanism |
|---|---|---|
| Strands | opt-in (`CacheConfig(strategy="auto")`); **on by default in the harness** | one moving `cachePoint` on the last user message (older ones removed); stable-prefix placement; `cache_key` derived from the session |
| Pydantic AI | opt-in | `bedrock_cache_*` / `anthropic_cache*` settings, or an explicit `CachePoint` part |
| OpenAI Agents SDK | automatic `prompt_cache_key` per run/session | no `cachePoint` / `cache_control` support |
| LangGraph | opt-in middleware (Anthropic) | Bedrock handling in langchain-aws not verified |
| pi | automatic | breakpoints on system, last tool and last message; optional 1-hour TTL; **cache warmer** re-sends at 90% of the TTL when the expected saving is ≥ $0.05; tool-set changes appended to the transcript instead of mutating the tool list |
| opencode | automatic | breakpoints on the first 2 system and last 2 messages; `promptCacheKey = sessionID`. **Anti-pattern:** the date is in the system prompt, so the cache is lost daily |
| Codex | automatic | `prompt_cache_key`; sends only incremental items (`previous_response_id`) when the prefix is strictly append-only; the current time goes into messages, not instructions |
| Claude Code | automatic, documented | stable layers (system + tools → project context → conversation); dynamic content appended as messages; lists what breaks the cache (model or effort change, adding or removing MCP servers or tools, compaction) |

**Standard (cache-friendly agent design):**
1. Order the prompt as **tools → system prompt → static context → history**, with a `cachePoint` after the static part and a moving one at the end.
2. **No timestamps, request IDs, usernames or balances in the system prompt.** Inject them as messages.
3. **Append-only history.** Never edit or reorder earlier turns.
4. **Keep the tool list fixed for the whole session.** Gate tools with policy (Cedar), not by adding and removing them.
5. Use a **1-hour TTL** where HITL pauses exceed 5 minutes.
6. Serialize tool JSON deterministically.
7. Treat compaction as a planned cache rebuild.
8. Track **cache hit ratio** (`cacheRead / (input + cacheRead + cacheWrite)`) as a platform KPI.

### 6.7 Multi-agent cooperation

**Patterns:**
- **agents-as-tools**: isolated context; the parent receives only the result;
- **orchestrator–worker / supervisor**;
- **handoffs**: control passes to another agent;
- **swarm**: peers with shared state;
- **graph / workflow**: deterministic;
- **A2A**: cross-process or cross-organization. A2A 1.0.0 is under the Linux Foundation; MCP spec 2026-07-28 is under the LF Agentic AI Foundation.

**Evidence:**
- Anthropic's multi-agent research system scored **90.2% higher** than a single agent on research tasks, but used **about 15× the tokens** of a chat (single agents use about 4×). It works poorly when agents share a lot of context or have many dependencies.
- Cognition's 2026 follow-up: extra agents help when **writes stay single-threaded**. Read-only sub-agents (search) and a context-isolated **coder↔reviewer** pair work; parallel writers do not.

**Limits in the systems reviewed:**

| System | Pattern | Limits |
|---|---|---|
| Strands | `as_tool` (resets context by default), `Swarm`, `Graph`, A2A | Swarm: `max_handoffs=20`, `max_iterations=20`, `execution_timeout=900s`, `node_timeout=300s`, repetitive-handoff detection; Graph: `max_node_executions` / `execution_timeout` (default None); harness `subagent` depth 2 |
| OpenAI Agents | handoffs, `as_tool` | handoffs share `max_turns`; `as_tool(max_turns=10)` |
| Pydantic AI | delegation through tools, pydantic-graph | pass `usage=ctx.usage` to share limits |
| LangGraph | subgraphs, `Command` handoffs, supervisor / swarm packages | bounded only by `recursion_limit` |
| Codex | `spawn_agent` / `wait_agent` / … | max 6 threads, depth 1 |
| Claude Code | `Agent` tool, forks | depth 3 by default |
| opencode | `task` tool, child sessions | no nesting by default |

**Standard:**
- Default to **one writer agent** plus **read-only sub-agents as tools**.
- Use **deterministic graphs** for regulated flows (KYC, disputes, payments).
- Use A2A only across trust or organizational boundaries, with signed Agent Cards.
- Sub-agents **inherit and count against the parent's budget**.
- Limit nesting depth to 2 or less, and fan-out to 5 or less.

### 6.8 Limits and runaway protection: what exists by default

| System | Turn/step limit (default) | Token / cost limit | Time limit | Loop / stuck detection | Retries |
|---|---|---|---|---|---|
| **Strands** | **none**; opt-in `limits={"turns"}` → `stop_reason=limit_turns` (no exception) | opt-in `total_tokens` / `output_tokens` (soft, checked each cycle); **no cost limit** | single agent: none (use `cancel_signal`); Swarm 900 s | Swarm only (repetitive handoffs); `steering` plugin | throttling only: 6 attempts, 4 s → 240 s |
| **Pydantic AI** | `request_limit=50` → `UsageLimitExceeded` | tokens (cumulative and per request), `tool_calls_limit`, **`cost_limit` (USD)**, pre-flight token counting | per-tool `timeout`; `cancel()` | none | tool/output validation retries = 1; HTTP retries opt-in |
| **OpenAI Agents** | `max_turns=10` → `MaxTurnsExceeded` | **none** (tracked only) | per-tool `timeout_seconds` | none | opt-in `ModelRetrySettings` |
| **LangGraph** | `recursion_limit` **10,007** (core) / 9,999 (`create_agent`) → `GraphRecursionError` | model/tool call-count middleware only | `step_timeout` default None | none | `RetryPolicy` 3 attempts; retry middleware (2) |
| pi | none | none | bash timeout (optional) | none | 3, backoff from 2 s |
| opencode | `agent.steps` (last step injects a "max steps" prompt) | none | shell 2 min | **doom-loop: 3 identical tool calls → ask permission** | 5, 2 s → 30 s with jitter |
| Codex | none | optional token-budget reminder | exec 10 s default; background ≤ 300 s | none | 5 (stream) / 4 (request) |
| Claude Code / SDK | `max_turns` | **`max_budget_usd`**, `task_budget` | bash 2 min (max 10) | none documented | 10 |
| **AgentCore harness** | **`maxIterations` = 75** | `maxTokens` (no default) | **`timeoutSeconds` = 3,600**; idle 900 s; max lifetime 8 h | – | managed |

**Conclusion:** no framework ships the complete set of controls a fintech needs, and the most popular one (LangGraph) is effectively unbounded by default. **Limits must be enforced by the platform** (§7), not left to each author.

---

## 7. Runaway, cost and safety controls

Controls are layered. Each layer catches what the one above misses.

| Layer | Control | Implementation |
|---|---|---|
| **L1 Agent loop** (Tier 1 wrapper) | Turn limit (default 25), total-token limit, **USD cost limit per run**, tool-call limit (overall and per tool), wall-clock timeout per run and per tool, cancellation | Strands `limits=` plus a hook-based budget enforcer in `BeforeModelCallEvent` / `BeforeToolsEvent` (checks the *projected* cost of the next call) plus `cancel_signal`. On Pydantic AI, `UsageLimits` covers most of this natively |
| L1 | **Loop / stuck detection** | Hash (tool, normalized args). Stop or escalate after 3 identical calls (opencode's rule), after N consecutive tool errors, or when the todo/plan hasn't changed for K turns. Detect repeated assistant text |
| L1 | **Side-effect safety** | Idempotency key on every mutating tool, with a dedupe store. Mutating tools run sequentially. Dry-run mode |
| L1 | **Human-in-the-loop** | Strands `interrupt()` for high-risk tools (payments over a threshold, customer communications, production changes). Thresholds live in policy, not in prompts |
| **L2 Harness / runtime** | Hard caps | AgentCore harness: `maxIterations` (75), `timeoutSeconds` (3,600), `maxTokens`. Runtime: idle timeout (15 min default), `maxLifetime` (8 h default), synchronous request timeout 15 min (fixed), 2 vCPU / 8 GB per session |
| **L3 Tool authorization** | Deterministic, outside the agent | **AgentCore Gateway + Policy (Cedar)** evaluated on every tool call: principal, tool, input parameters. Session-aware conditions (approval before transfer, run-count caps) are documented. **Verify whether that is Cedar or the separate "Dogwood" language** (§10) |
| L3 | Content safety | Bedrock Guardrails (PII, denied topics, prompt attack) on input and output |
| **L4 Account / spend** | Attribution and ceilings | One **application inference profile per agent / team / tenant** with cost-allocation tags → AWS Budgets and Cost Anomaly Detection alerts and actions; Bedrock service quotas (TPM/RPM) partitioned by account |
| L4 | **Kill switch** | A feature flag checked on every loop iteration, plus the ability to end AgentCore sessions and disable an inference profile or IAM role |
| **L5 Observability / audit** | Traces, metrics, audit | OTel → AgentCore Observability / CloudWatch; CloudTrail; persist stop reason, usage, cost, approvals; AgentCore Evaluations for regression testing |

**Mapping to OWASP:**
- **OWASP LLM Top 10 2025:**
  - LLM06 Excessive Agency is addressed by least-privilege tools, Cedar and HITL.
  - LLM10 Unbounded Consumption is addressed by L1, L2 and L4.
- **OWASP Top 10 for Agentic Applications 2026:**
  - ASI01 goal hijack: Guardrails and tool policy.
  - ASI02 tool misuse and ASI03 identity/privilege abuse: Gateway, Cedar and AgentCore Identity.
  - ASI04 agentic supply chain: §5.4.
  - ASI05 unexpected code execution: microVM and no shell tools in Tier 0 by default.
  - ASI06 memory poisoning: memory write policies.
  - ASI08 cascading failures and ASI10 rogue agents: budgets, loop detection and the kill switch.
- **Check the OWASP LLM Top 10 2026 (published 2026-08-03) for renumbering before citing these IDs in policy.**

---

## 8. Serving non-developer (vibe-coding) authors

Non-developers using AI assistants to write agent code are the riskiest authors in this program. They are most likely to:
- `pip install` whatever the assistant suggests, including typosquats and hallucinated packages;
- paste credentials into code;
- grant broad tool permissions;
- skip limits.

The design principle is therefore **make the safe path the easy path.**

1. **Tier 0 first: agents as configuration.**
   - The AgentCore managed harness: model, instructions, skills, and tools chosen **only from an approved catalog** (AgentCore Gateway targets, curated skills).
   - No code and no dependencies. Platform-level caps (§7) apply automatically.
   - Changes go through a PR on a config repo with policy linting (for example, no mutating tool without HITL, and turn and budget limits within org maxima).
2. **Tier 1: code templates.** An internal `agent-template` (Python, Strands) with:
   - a pre-locked `uv.lock` that resolves only through CodeArtifact, with a cooldown;
   - the wrapper package (`org-agents`), which sets default limits, budget hooks, loop detection, idempotent tool decorator, telemetry, redaction and the thread-message policy;
   - `AGENTS.md` / `CLAUDE.md` guidance files that tell AI assistants which APIs to use and forbid new dependencies without approval;
   - CI that runs the SBOM, `osv-scanner` / Inspector, the provenance check, a lint for missing limits, and the evaluations suite.
3. **Assistant-friendly APIs.** Strands' `Agent(...)` + `@tool` shape is short and well represented in AI assistants' training data, and AWS ships an MCP docs server for it. Measure how well assistants generate correct code in the PoC (§11).
4. **Graduation path.** Agents move Tier 0 → Tier 1 when they need custom logic. The primitives are the same (Strands underneath both), so there is no rewrite.

---

## 9. Recommendation

### 9.1 Decision

1. **Adopt Amazon Bedrock AgentCore as the agent platform.** Use the managed harness for Tier 0 and Runtime for Tier 1. Add Gateway + Policy for tools, Identity, Memory, Observability and Evaluations.
2. **Adopt Strands Agents (Python) as the standard code-level framework.** Adopt Strands TypeScript for TS teams, installed without auto-installed peers.
3. **Add Pydantic AI (`pydantic-ai-slim[bedrock]`) as the single approved alternative**, for teams that need its native budget and cost limits or durable execution. It must be pinned behind the same cooldown and mirror controls.
4. **Ban LiteLLM, CrewAI and Mastra as dependencies.** Do not use Claude Agent SDK, opencode, pi or Codex as runtime platforms (developer-tool use falls under a separate policy).
5. **Build the thin internal wrapper `org-agents`.** Its job is to enforce limits, budgets, loop detection, idempotency, the thread-message policy, redaction and telemetry. It adds no new third-party dependencies.
6. **Consequences of the AWS commitment (2026-09-27):**
   - **Prefer AWS-native building blocks** over framework-bundled or third-party equivalents:
     - AgentCore Memory, or S3/DynamoDB with KMS, rather than framework session stores;
     - AgentCore Gateway + Policy rather than ad-hoc MCP servers;
     - AgentCore Observability/CloudWatch rather than LangSmith or Logfire;
     - Bedrock Guardrails;
     - application inference profiles and AWS Budgets for cost control;
     - AWS Step Functions for long-running, deterministic orchestration, rather than Temporal or DBOS.
   - **Model choice = the Bedrock catalog.** Only frameworks with a native Bedrock provider qualify. This confirms excluding the OpenAI Agents SDK and Google ADK, which reach Bedrock only through LiteLLM.
   - **Pydantic AI's case as the alternative narrows.** Its durable-execution integrations (Temporal, DBOS, Prefect) matter less, so the remaining reason to choose it is native budget and cost limits. Reassess after the PoC. If the `org-agents` wrapper gives Strands equivalent limits, drop the alternative and keep a single standard.
   - **Engage AWS directly** (account team / Strands maintainers) on:
     - trimming Strands' mandatory dependencies;
     - SHA-pinning the GitHub Actions in its repo;
     - native mid-run message steering;
     - clarifying the language AgentCore Policy uses for temporal conditions.

### 9.2 Why Strands over the alternatives

| Criterion | Strands | Pydantic AI | LangGraph | OpenAI Agents |
|---|---|---|---|---|
| R1 Bedrock / AgentCore native | ●●● (default everywhere) | ●● (native provider; samples only) | ●●● (template, evals) | ● (LiteLLM only; OpenAI-only template) |
| R2 Few dependencies | ●● (48 Py / 32 TS) | ●●● (24) | ●● (46) | ●● (38) |
| R3 Provenance / trust | ●●● (AWS; PEP 740 + npm) | ●●● (PEP 740) | ●● (npm only) | ●●● |
| R3 Release cadence | ●● (15 in 90 days) | ● (65) | ●●● (6) | ●● (17) |
| R6 Runaway defaults | ● (none by default; wrapper needed) | ●●● | ● (10,007) | ●● (10 turns, no budget) |
| R5 HITL / sessions | ●●● | ●● | ●●● | ●● |
| R7 Non-developer path | ●●● (same stack as the AgentCore harness) | ● | ● | ● |
| R10 Vendor alignment (AWS commitment) | ●●● (AWS-owned; AgentCore reference framework) | ●● | ●● | ● |

Strands' weak points are runaway defaults, the dependency set, experimental churn and CI hygiene. The wrapper and the supply-chain controls address them, and none of them is decisive. Pydantic AI is technically cleaner on dependencies and limits, but its release cadence, its thinner AgentCore integration and the lack of a no-code path make it the alternative, not the default.

### 9.3 Reference architecture

```
                 ┌──────────────── Authors ────────────────┐
                 │ Tier 0: config PR       Tier 1: template │
                 └──────┬──────────────────────────┬────────┘
                        │ policy lint, evals        │ CI: SBOM, osv/Inspector, provenance,
                        ▼                           ▼     limit-lint, evals (CodeArtifact + cooldown)
   ┌──────────────────────────────┐   ┌──────────────────────────────────────┐
   │ AgentCore managed harness    │   │ AgentCore Runtime (microVM/session)  │
   │ maxIterations / timeout /    │   │ Strands + org-agents wrapper         │
   │ maxTokens                    │   │ limits, budget, loop-detect, HITL,   │
   └──────────────┬───────────────┘   │ idempotency, thread policy, OTel     │
                  │                   └───────────────────┬──────────────────┘
                  └──────────────┬────────────────────────┘
                                 ▼
      Bedrock (application inference profile per agent/team, tagged; Guardrails; prompt caching)
      AgentCore Gateway (approved MCP tools) ── AgentCore Policy (Cedar) ── Identity
      AgentCore Memory / S3+KMS sessions (append-only)    Observability → CloudWatch / CloudTrail
      AWS Budgets + Anomaly Detection per profile tag      Kill switch (flag + session termination)
```

---

## 10. Risks and open questions

| # | Risk / question | Mitigation / next step |
|---|---|---|
| 1 | **Strands has low community mindshare** (11 HN comment mentions) and depends on AWS's continued investment | AWS-internal use ("thousands of agents") and AgentCore alignment reduce the risk; with the AWS commitment, AWS's own stack is the lowest-risk bet. Keep the wrapper's *agent-authoring* API thin so Pydantic AI stays a viable fallback **inside** AgentCore Runtime |
| 2 | **Strands churn**: weekly releases, `experimental` features, the repo rename, and deprecations (`structured_output()`) | Allow only non-experimental APIs in the wrapper. Quarterly upgrade cadence behind the cooldown. Contract tests in the PoC |
| 3 | **Strands Python mandatory dependencies** (MCP, OTel SDK, uvicorn, starlette, watchdog) | Measure the actual import surface. Engage AWS about extras. Accept for now: all are mainstream, high-scrutiny packages |
| 4 | **Weak CI hygiene in the Strands repo** (few SHA-pinned Actions; `pull_request_target`) | Rely on PEP 740 / npm provenance verification plus a cooldown. Raise with AWS through our account team |
| 5 | **No native steering in Strands** (mid-run messages throw) | Implement a queue and a `BeforeModelCallEvent` injection in the wrapper (PoC). Otherwise use the reject-or-queue policy |
| 6 | **AgentCore Policy temporal conditions**: the docs mention "Dogwood" alongside Cedar | Verify the language and GA status before relying on it for approvals or budgets |
| 7 | **Vendor-reported benchmark** (Strands harness uses 28% fewer tokens) is disputed | Run our own token and cost comparison in the PoC |
| 8 | ~~Lock-in to AWS AgentCore~~ **Accepted** (decision of 2026-09-27) | We use AgentCore-native services (harness, Gateway, Policy, Identity, Memory, Observability, Evaluations) as first-class parts of the architecture, with no abstraction layers built for portability. Exposing tools as MCP is kept for **reuse across agents and teams**, not for portability. What remains is **dependence on AWS's roadmap**. Mitigate it through the AWS account team, preview/GA tracking and the §11 PoC |
| 9 | **Compaction vs. record-keeping**: summaries may drop regulatory detail | Persist pre-compaction transcripts. Prefer deterministic truncation for regulated flows |
| 10 | Items not verified directly: Scorecard scores for most repos (not published); some ClawHub and CHAINDROP figures (secondary sources); LangGraph Server's default `multitask_strategy`; Bedrock caching in langchain-aws; the exact Bedrock cache prices (see the pricing page) | Close these out during the PoC |

---

## 11. Proof-of-concept plan

**Goal:** confirm the recommendation with evidence from our own environment. Timebox: 3–4 weeks.

1. **Reference agents.** Build the same two agents in Strands, Pydantic AI and (as a control) LangGraph, all on Bedrock through CodeArtifact:
   - (a) a read-mostly "analyst" agent that uses 3 MCP tools through AgentCore Gateway;
   - (b) an autonomous "operations" agent with one mutating tool behind HITL and idempotency.
2. **Tier 0.** Build agent (a) as an AgentCore managed-harness config, with a Cedar policy.
3. **Measure:**
   - lines of code;
   - dependency count and SBOM findings;
   - image size and cold start;
   - tokens, cost and **cache hit ratio**;
   - p50/p95 latency;
   - task success on a 30-case eval set (AgentCore Evaluations).
4. **Runaway tests.** Force an infinite tool loop, a huge tool output, a throttling storm, a hung tool and a budget overrun. Each must stop within its configured limit with the correct `stop_reason` and an audit event.
5. **Thread tests.** Double messages, a message mid-tool-call, cancel during a mutating tool, and two users approving. Verify the steer/queue/interrupt semantics and that the audit trail is complete.
6. **Supply-chain drills.**
   - A mirror cooldown blocks a freshly published version.
   - `npm audit signatures` and the PEP 740 checks fail closed on an unattested package.
   - An install-script package is blocked.
   - Pinned scanners run in CI.
7. **Vibe-coding trial.** 3–5 non-developers build a small agent from the template with an AI assistant. Measure how many dependencies were added, policy violations, time to first working agent, and how many support tickets they raised.
8. **Decision gate.** Confirm or adjust §9. Publish the `org-agents` wrapper v0.1 and the templates.

---

## 12. Appendix: method, raw data, sources

### 12.1 Method

- **Popularity:** HN Algolia API queries, exact word matching, 2026-09-26. GitHub star counts via GitHub search.
- **Versions:** PyPI JSON API and `npm view`, 2026-09-26/27.
- **Dependencies:** `uv 0.8.17` (`uv pip compile`, Python 3.12, Linux x86_64) and `npm 10.9.7 --ignore-scripts` in clean directories, 2026-09-27.
- **Provenance and CI:** PyPI integrity/provenance endpoints, `npm view --json` (`dist.attestations`), the OpenSSF Scorecard API (most repos unscored), and sparse clones of each repo's `.github/workflows`.
- **Incidents:** GHSA / OSV / PYSEC / MAL advisories and vendor postmortems.
- **Loop internals:** read directly from source at these commits:
  - Strands `strands-agents/harness-sdk@c56b7de`
  - Pydantic AI `pydantic/pydantic-ai@ed2ff7b`
  - OpenAI Agents `openai/openai-agents-python@588826c`
  - LangGraph `langchain-ai/langgraph@7daa3ab` (v1.2.12)
  - LangChain `langchain-ai/langchain@80b7409`
  - pi `earendil-works/pi@2b0a123`
  - opencode `anomalyco/opencode@b471c2b`
  - Codex `openai/codex@67a7096`
  - Claude Agent SDK `anthropics/claude-agent-sdk-python@36f9548`
  - AgentCore CLI `aws/agentcore-cli@805f342` (v0.30.0)
  - AgentCore samples `awslabs/agentcore-samples@e1a55b3`
- **AWS documentation** was read directly from docs.aws.amazon.com on 2026-09-26/27.

Some code-level claims were spot-checked by hand. For example, `DEFAULT_RECURSION_LIMIT = int(getenv("LANGGRAPH_DEFAULT_RECURSION_LIMIT", "10007"))` was confirmed in the published langgraph 1.2.12 wheel.

### 12.2 Key sources

**AWS**
- AgentCore harness: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness.html
- AgentCore harness limits: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-operations.html
- AgentCore quotas: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/bedrock-agentcore-limits.html
- AgentCore Policy: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/policy.html
- Frameworks supported by AgentCore Evaluations: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/supported-frameworks.html
- AgentCore Runtime with any framework: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/using-any-agent-framework.html
- Bedrock Agents Classic maintenance mode: https://docs.aws.amazon.com/bedrock/latest/userguide/agents-classic-maintenance-mode.html
- Bedrock prompt caching: https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html
- Application inference profiles: https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-create.html
- AgentCore CLI: https://github.com/aws/agentcore-cli (`docs/frameworks.md`, `src/schema/constants.ts`)
- AgentCore samples: https://github.com/awslabs/agentcore-samples

**Frameworks**
- Strands: https://github.com/strands-agents/harness-sdk · https://strandsagents.com
- Pydantic AI: https://github.com/pydantic/pydantic-ai
- OpenAI Agents SDK: https://github.com/openai/openai-agents-python
- LangGraph: https://github.com/langchain-ai/langgraph
- Claude Agent SDK: https://github.com/anthropics/claude-agent-sdk-python · https://code.claude.com/docs
- pi: https://github.com/earendil-works/pi
- opencode: https://github.com/anomalyco/opencode
- Codex: https://github.com/openai/codex

**Context engineering and multi-agent**
- Anthropic, Effective context engineering for AI agents: https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- Anthropic, How we built our multi-agent research system: https://www.anthropic.com/engineering/multi-agent-research-system
- Manus, Context Engineering for AI Agents: https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus
- Cognition, Don't Build Multi-Agents: https://cognition.ai/blog/dont-build-multi-agents
- Cognition, Multi-Agents: What's Actually Working: https://cognition.ai/blog/multi-agents-working
- A2A specification: https://a2a-protocol.org/latest/specification/
- MCP specification versioning: https://modelcontextprotocol.io/specification/versioning
- Agentic AI Foundation (AAIF) announcement: https://www.linuxfoundation.org/press/linux-foundation-announces-the-formation-of-the-agentic-ai-foundation

**Security**
- LiteLLM March 2026 security update: https://docs.litellm.ai/blog/security-update-march-2026 (GHSA-5mg7-485q-xm76)
- Microsoft Security Blog on the Trivy compromise: https://www.microsoft.com/en-us/security/blog/2026/03/24/detecting-investigating-defending-against-trivy-supply-chain-compromise/ (CVE-2026-33634)
- Mastra compromise: https://github.com/mastra-ai/mastra/issues/18048 (MAL-2026-6011)
- Nx s1ngularity postmortem: https://nx.dev/blog/s1ngularity-postmortem (CVE-2025-10894)
- Mistral advisory MAI-2026-002: https://docs.mistral.ai/resources/security-advisories/MAI-2026-002
- OWASP LLM Top 10: https://genai.owasp.org/llm-top-10/
- OWASP Top 10 for Agentic Applications 2026: https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/

**Hacker News threads cited**
- Strands Harness: https://news.ycombinator.com/item?id=49817289
- Pi – A minimal terminal coding harness: https://news.ycombinator.com/item?id=47143754
- OpenCode – Open source AI coding agent: https://news.ycombinator.com/item?id=47460525
- Claude Code vs OpenCode token overhead: https://news.ycombinator.com/item?id=48883275
- Why we no longer use LangChain: https://news.ycombinator.com/item?id=40739982
- The canonical agent architecture: a while loop with tools: https://news.ycombinator.com/item?id=45158559
