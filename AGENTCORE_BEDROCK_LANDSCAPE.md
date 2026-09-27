# AgentCore and Bedrock: a developer's introduction

This page explains what AWS gives you for building agents by **building one**:
1. create an agent with the `agentcore` CLI;
2. give it a skill and some tools;
3. prompt it;
4. see what runs where;
5. turn it into code when configuration isn't enough.

After that it covers the platform pieces, what you pay for, and how this fits a self-service agent platform.

The CLI output and generated files shown here come from running `@aws/agentcore` 0.30.0 on 2026-09-27. Prices come from the AWS pricing pages on the same date.

---

## 1. Three layers

| Layer | What it is | Who writes it |
|---|---|---|
| **Bedrock** | The models. You send messages; you get text or tool calls back (the `Converse` API) | AWS / model providers |
| **Strands Agents** | An open-source **library** (Python, TypeScript) containing the **agent loop**: call the model → run the tools it asked for → call the model again → until it answers | You import it, like LangGraph or Pydantic AI |
| **AgentCore** | Where agents **run**, and the services they plug into (tools, identity, memory, policy, traces) | AWS |

AgentCore has two ways to run an agent:

- **Runtime.** A serverless server for **your agent code**. You deploy a container or zip that answers `POST /invocations`. Each conversation (session) gets its own small VM, which stays alive between messages for up to 8 hours. Runtime does not contain an agent loop; your code does, whether that is Strands, LangGraph, or anything else.
- **Harness.** **AWS's own Strands agent, pre-built and running in Runtime.** You don't write code; you give it a JSON config (model, prompt, tools, skills). It is the closest thing AWS has to a managed, remote Claude Code: an agent loop with a shell, a filesystem and skills, in a sandbox you don't operate.

```mermaid
flowchart TB
  subgraph H["Harness (you write JSON)"]
    CFG["harness.json: model, prompt, tools, skills"] --> SA["AWS-built Strands agent"]
  end
  subgraph R["Runtime (you write code)"]
    CODE["your agent code: Strands, LangGraph, Pydantic AI, pi, opencode…"]
  end
  SA --> VM["AgentCore Runtime: one microVM per session"]
  CODE --> VM
  VM -->|"Converse"| BR["Bedrock models"]
  VM -->|"MCP"| TOOLS["Tools: MCP servers, AgentCore Gateway,<br/>Code Interpreter, Browser"]
```

So: **the harness is a Runtime agent that AWS wrote for you.** Step 7 shows this literally: the CLI can export a harness as the Strands code it runs.

---

## 2. Walkthrough: from nothing to a prompted agent

### Step 1: create a project

```bash
npm install -g @aws/agentcore        # Node 20+; also needs uv for Python agents
agentcore create --project-name helpdesk --defaults
cd helpdesk
```

The default project is a **harness**. The CLI generated these files:

```
helpdesk/
├── agentcore/
│   ├── agentcore.json        # the project: lists harnesses, runtimes, gateways, memories…
│   ├── aws-targets.json      # which account/region to deploy to
│   └── cdk/                  # CDK app the CLI uses to deploy (you rarely touch it)
└── app/helpdesk/
    ├── harness.json          # the agent
    └── system-prompt.md      # its instructions
```

`app/helpdesk/harness.json`:

```json
{
  "name": "helpdesk",
  "model": { "provider": "bedrock", "modelId": "global.anthropic.claude-sonnet-4-6" },
  "tools": [],
  "skills": [],
  "memory": { "mode": "disabled" }
}
```

### Step 2: write the instructions

Edit `app/helpdesk/system-prompt.md`:

```markdown
You are the internal IT and expenses helpdesk for Fintech Ltd.
Answer policy questions from the skills you have. Open a ticket only when the user asks for one.
Never reveal credentials or personal data.
```

To use a cheaper model while developing, change `modelId` to `global.anthropic.claude-haiku-4-5-20251001-v1:0`.

### Step 3: give it a skill

A **skill** is a folder with a `SKILL.md` file (name and description in front matter, then instructions). It can also hold `scripts/`, `references/` and `assets/`. This is the open AgentSkills.io format, the same one Claude Code uses.

The agent sees only each skill's one-line description until it decides the skill is relevant. Then it loads the full instructions through a tool call. So you can attach many skills without filling the context.

```
expense-policy/
├── SKILL.md
└── scripts/
    └── per_diem.py
```

```markdown
---
name: expense-policy
description: Fintech Ltd expense rules (hotel, meals, claim deadlines) and how to compute per-diem totals.
---
# Expense policy
- Hotels: up to 180 EUR per night in major cities.
- Meals: up to 60 EUR per day.
- Claims must be submitted within 30 days with itemised receipts.

To compute a trip allowance, run `python scripts/per_diem.py --days N --city-class major`.
```

Upload the folder to S3 and attach it:

```bash
aws s3 sync expense-policy/ s3://fintech-agent-skills/expense-policy/
agentcore add skill --harness helpdesk --s3 s3://fintech-agent-skills/expense-policy/
```

Skills can also come from Git (`--git`), from AWS's pre-built skills (`--aws-skills`), or from a path already inside the agent's VM (`--path`).

This is where **scripts** fit in. A skill's scripts run **inside the agent's own VM** when the agent calls its shell tool. That is deterministic code the model triggers, with no extra service needed.

### Step 4: give it tools

```bash
# an existing MCP server (e.g. our ticketing tools)
agentcore add tool --harness helpdesk --type remote_mcp --name tickets --url https://tools.fintech.example/mcp

# a sandbox for running code
agentcore add tool --harness helpdesk --type agentcore_code_interpreter --name code
```

`harness.json` now reads:

```json
{
  "name": "helpdesk",
  "model": { "provider": "bedrock", "modelId": "global.anthropic.claude-sonnet-4-6" },
  "tools": [
    { "type": "remote_mcp", "name": "tickets", "config": { "remoteMcp": { "url": "https://tools.fintech.example/mcp" } } },
    { "type": "agentcore_code_interpreter", "name": "code" }
  ],
  "skills": [ { "s3Uri": "s3://fintech-agent-skills/expense-policy/" } ],
  "memory": { "mode": "disabled" }
}
```

The harness also always has a built-in **shell** tool and a **file** tool, which work in its VM. Other tool types:
- `agentcore_gateway`: all tools behind an AgentCore Gateway (§4);
- `agentcore_browser`: a managed headless Chrome;
- `inline_function`: a tool your calling application executes.

Settings you will want soon:

```bash
agentcore add harness --help   # shows, among others:
#   --max-iterations, --max-tokens, --timeout       limits per invocation (cost control)
#   --memory-mode managed --memory-strategies ...   remember users across sessions
#   --truncation-strategy sliding_window|summarization
#   --network-mode VPC --subnets ... --security-groups ...
#   --idle-timeout, --max-lifetime                  how long a session VM lives
```

### Step 5: deploy

```bash
agentcore deploy
```

The CLI turns `agentcore.json` into a CDK app and deploys it as a CloudFormation stack. For this project the stack holds:
- the **harness** resource (`AWS::BedrockAgentCore::Harness`);
- an **IAM execution role**, the agent's AWS permissions: calling the model, reading the skill bucket, writing logs;
- anything else you added (memory, gateway, credentials).

The agent also gets a **workload identity** automatically. Nothing runs yet, and nothing costs money until someone invokes it.

### Step 6: prompt it

```bash
agentcore invoke --session-id "$(uuidgen)" "How much can I claim for meals on a 4-day trip to Paris?"
```

What happens:

```mermaid
sequenceDiagram
    autonumber
    participant C as agentcore invoke (or your app)
    participant AC as AgentCore
    participant VM as Session microVM
    participant B as Bedrock
    participant T as Tools
    C->>AC: InvokeHarness(session id, message)
    AC->>VM: start a microVM for this session (or reuse it)
    VM->>VM: load harness.json, fetch skills from S3 (first call only)
    loop Strands agent loop
        VM->>B: Converse(system prompt + skill descriptions + tools + history)
        B-->>VM: "use skill expense-policy" / "run shell: per_diem.py" / tool call
        VM->>T: run the tool (shell in the VM, MCP server, Code Interpreter)
        T-->>VM: result
    end
    VM-->>C: streamed answer: "4 days × 60 EUR = 240 EUR"
    Note over VM: VM stays warm for the next message in this session,<br/>then stops after 15 min idle (max 8 h)
```

**Things to know:**
- **Sessions.** The same `--session-id` means the same VM and the same conversation. A new id means a fresh VM. There is no shared state between sessions unless you add Memory.
- **Deterministic commands, no model.** You can run commands in the session VM directly, with no model involved (no tokens):

  ```bash
  agentcore invoke --exec --session-id "$SID" "ls -la /tmp && python --version"
  ```

  Use this to prepare a workspace (clone a repo, install packages) before prompting, or to collect results afterwards.
- **Logs and traces:** `agentcore logs`, `agentcore traces list`. Every model call, tool call and shell command is a span in CloudWatch.

### Step 7: it's just an API, and underneath it's Strands

The CLI is a thin wrapper. The same agent via the plain AWS CLI:

```bash
aws bedrock-agentcore-control create-harness \
  --harness-name helpdesk \
  --execution-role-arn arn:aws:iam::111122223333:role/helpdesk-agent \
  --model '{"bedrockModelConfig":{"modelId":"global.anthropic.claude-sonnet-4-6"}}' \
  --system-prompt '[{"text":"You are the internal IT and expenses helpdesk for Fintech Ltd. ..."}]' \
  --skills '[{"s3":{"uri":"s3://fintech-agent-skills/expense-policy/"}}]' \
  --max-iterations 20 --max-tokens 200000

aws bedrock-agentcore invoke-harness \
  --harness-arn arn:aws:bedrock-agentcore:eu-west-1:111122223333:harness/helpdesk-… \
  --runtime-session-id "$SID" \
  --messages '[{"role":"user","content":[{"text":"How much can I claim for meals on a 4-day trip?"}]}]'
```

Most of these fields (model, prompt, tools, skills, limits) can also be **overridden per invocation**.

**Export the harness to see what it runs:**

```bash
agentcore export harness --name helpdesk
```

This writes `app/helpdeskAgent/`, a normal Python project that depends on `strands-agents`, `strands-agents-tools`, `bedrock-agentcore` and `mcp`. Its `main.py`, shortened:

```python
from strands import Agent, AgentSkills, tool
from strands_tools.code_interpreter import AgentCoreCodeInterpreter
from bedrock_agentcore.runtime import BedrockAgentCoreApp

app = BedrockAgentCoreApp()          # the HTTP server Runtime talks to (/invocations, /ping)

tools = [AgentCoreCodeInterpreter().code_interpreter, shell, file_operations]   # built-ins
tools += get_all_remote_mcp_clients()                                           # "tickets" MCP server

@app.entrypoint
async def invoke(payload, context):
    skills = resolve_s3_skills(["s3://fintech-agent-skills/expense-policy/"])   # download SKILL.md folders
    agent = get_or_create_agent(context.session_id, [AgentSkills(skills=skills)])  # one Strands Agent per session
    async for event in agent.stream_async(payload["prompt"]):                   # the Strands loop
        yield event                                                             # streamed back to the caller

if __name__ == "__main__":
    app.run()
```

This is the whole picture:
- **`BedrockAgentCoreApp`** makes it a Runtime agent.
- **`strands.Agent`** is the loop.
- The tools and skills are the ones you configured.

Once exported, the harness is a **Runtime agent with code you own**. Change anything (add hooks, custom tools, guards), then `agentcore deploy` again.

### Step 8: write your own agent from the start

Skip the harness when you need things configuration can't express:
- your own approval flow;
- budgets and loop detection;
- custom state;
- a different framework.

```bash
agentcore create --project-name helpdesk2 --framework Strands --model-provider Bedrock --build CodeZip
# or --framework LangChain_LangGraph | OpenAIAgents | GoogleADK | VercelAI, --language TypeScript, --build Container
agentcore dev        # run locally on :8080
agentcore deploy
agentcore invoke "hello"
```

The contract your code must meet is small:
- serve `POST /invocations` and `GET /ping` on port 8080;
- run on ARM64 (the build handles this);
- read the session id from the request.

That is what all eight of our templates in `templates/generic-agents/` do, in Strands, LangGraph, Pydantic AI, pi and opencode. They add the org controls the harness doesn't have: run budgets, loop detection, four-eyes approvals, idempotent tools, a PII-free audit log and Auth0 caller identity.

**Which to use:**

| Choose | When |
|---|---|
| **Harness** | Non-developers; standard assistants; you want model, prompt, tools and skills as config; approvals via hook Lambdas are enough |
| **Runtime + your code** | You need control over the loop, custom guards, a non-Strands framework, or our org templates |

---

## 3. Strands in five minutes

Strands is the loop both options above run on (the harness always; Runtime if you choose it).

```python
from strands import Agent, tool

@tool
def calculate(expression: str) -> str:
    """Evaluate an arithmetic expression exactly."""
    ...

agent = Agent(
    model="global.anthropic.claude-haiku-4-5-20251001-v1:0",   # Bedrock by default
    system_prompt="You are a helpful assistant.",
    tools=[calculate],
)
result = agent("What is 0.1 + 0.2?")
```

**What `agent(...)` does:**
1. It sends the prompt, the system prompt and the tool schemas to the model.
2. If the model asks for tools, it runs them and appends the results.
3. It calls the model again, until the model stops asking for tools.

That cycle is the whole "agent".

**What you can plug into it:**

| Piece | What it's for |
|---|---|
| `model=` | Bedrock (default), Anthropic, OpenAI, Gemini, LiteLLM, Ollama… |
| `tools=` | `@tool` functions, MCP clients (a whole MCP server's tools), the `strands-agents-tools` package (shell, files, Code Interpreter, Browser…) |
| `hooks=` | Callbacks before and after model calls and tool calls. **This is where guards go**: our templates block disallowed tools, enforce budgets and pause for approvals here |
| `conversation_manager=` | What to do when history grows: sliding window, summarizing, or none |
| `session_manager=` | Persist conversations: file, S3, or **AgentCore Memory** |
| `plugins=[AgentSkills(...)]` | Skills |
| Multi-agent | Agents as tools, swarm, graph, workflow, A2A |
| Tracing | OpenTelemetry spans out of the box, which is what AgentCore Observability shows |

---

## 4. The platform pieces you add next

Each piece is independent. You add them with `agentcore add …` and connect them to a harness or runtime.

### Gateway: one front door for tools (and agents)

An AgentCore **Gateway** is a managed MCP endpoint (`agentcore add gateway`, `agentcore add gateway-target`).

**What it can put behind itself as tools:**
- Lambda functions;
- REST APIs (from an OpenAPI spec);
- existing MCP servers;
- API Gateway stages;
- Bedrock Knowledge Bases;
- web search;
- other agents.

**What it adds on every call:**
- inbound auth (Auth0 JWT);
- outbound credentials;
- request/response Lambda interceptors (for redaction and audit);
- rate limits per user, tool or model;
- WAF;
- **Policy**.

Every agent, in any framework, then sees the same governed tools through one URL (`--type agentcore_gateway` on a harness, or an MCP client in code).

### Identity: users sign in with Auth0; agents get their own identity

Setup for our Auth0 tenant `fintech.eu.auth0.com`, with the agents API audience `https://agents.fintech.example`:

| Who | Auth0 side | AgentCore side |
|---|---|---|
| **A user** (Alice) | Signs in to the agent portal (Authorization Code + PKCE, audience = agents API). A post-login Action adds `https://fintech.example/email`, `given_name`, `family_name`, `user_id` and `role` claims | The Runtime or Gateway **JWT authorizer**: discovery URL `https://fintech.eu.auth0.com/.well-known/openid-configuration`, `allowedAudience` = the agents API |
| **Automation** (a schedule, an event) | An M2M application per workload (e.g. `agent-scheduler`), client credentials. Tokens have `sub = <client_id>@clients` | Same authorizer. Our templates treat it as a service client with no profile |
| **The agent itself** | – | A **workload identity**, created automatically. The agent gets downstream credentials from the **token vault** (credential providers, e.g. `Auth0Oauth2`) and never holds a secret |
| **The agent acting as Alice** | On-behalf-of token exchange (RFC 8693) to e.g. `https://payments.fintech.example`, with narrower scopes | A `CustomOauth2` credential provider with token exchange. **[verify in PoC]** that the Auth0 tenant has the OBO feature |
| **An approver** | A user with an approver role; CIBA push (Auth0 Guardian) for high-risk actions | Our templates' four-eyes approval, or a Gateway tool waiting on CIBA |

The full Auth0 setup is in [`AGENT_IDENTITY_AUTH0.md`](AGENT_IDENTITY_AUTH0.md).

### Policy: who may call which tool

A **Policy engine** attached to the Gateway checks every tool call against **Cedar** rules. Every Auth0 claim becomes a tag you can test:

```cedar
permit(principal, action == AgentCore::Action::"Payments___transfer", resource)
when {
  principal.hasTag("https://fintech.example/role") &&
  principal.getTag("https://fintech.example/role") == "treasury" &&
  context.input.amount < 10000
};
```

- Start in `LOG_ONLY` mode, then switch to `ENFORCE`.
- Bedrock **Guardrails** (content filters, prompt-injection detection, PII masking) can run inside the same policy step on tool inputs and outputs.

### Memory

**AgentCore Memory** (`--memory-mode managed` on a harness, or the Memory session manager in Strands) has two parts:
- **Short-term:** stores the conversation per user and session.
- **Long-term:** extracts facts, preferences, summaries and episodes, which the agent retrieves in later sessions.

Key it by our stable user id, not the email address.

### Built-in sandboxes

- **Code Interpreter:** run Python or JS code and shell commands in an isolated sandbox, which can be network-free.
- **Browser:** a managed headless Chrome, with live view and recording.

Both are tools the agent calls; they are separate from the agent's own VM.

### Observability and evaluations

- **Traces.** OpenTelemetry traces land in CloudWatch automatically for the harness. With your own code you get them through the Strands, LangGraph or Pydantic AI instrumentation.
- **Evals before merge.** Our `org-evals` suite runs scenario tests locally ([`templates/shared/evals`](templates/shared/evals/README.md)).
- **Evals after deploy.** AgentCore **Evaluations** scores real traces with built-in judges (correctness, tool selection, goal success…) or your own (`agentcore run eval`, online evals). **A/B tests** split Gateway traffic between two configurations.

### Registry

The **AWS Agent Registry** is a catalogue of approved agents, tools, skills and MCP servers, with an approval step. In a self-service platform it is the list of what people may use (§6).

---

## 5. What you pay for

**Nothing is charged while an agent sits idle.** Costs start when a session runs. In practice, **model tokens are 80–96% of the bill**.

| Item | Price (us-east-1 = eu-west-1) | Billed when |
|---|---|---|
| **Model tokens** (Bedrock, global profile, per 1M tokens) | Haiku 4.5: $1 in / $5 out. Sonnet 4.6: $3 / $15. Sonnet 5: $2 / $10. Opus 5.5: $4 / $20. Cache reads cost about 10% of input; 5-minute cache writes cost 125% of input | Every model call. **Geo profiles (`eu.`) cost 10% more**; batch costs 50% less |
| **Runtime** (your session VMs; also what a harness runs on) | $0.0895 per vCPU-hour + $0.00945 per GB-hour, per second | CPU only while actually computing (**not** while waiting for the model); memory while the session is alive |
| **Harness** | **Free** | You pay for the Runtime, model, tools and memory it uses |
| **Gateway** | $0.005 per 1,000 tool calls | Each tool call |
| **Policy** | $0.000025 per authorization | Each checked tool call |
| **Identity** | Free through Runtime or Gateway | – |
| **Memory** | $0.25 per 1,000 events; $0.75 per 1,000 stored long-term records per month; $0.50 per 1,000 retrievals | Writes, storage, reads |
| **Guardrails** | $0.15 per 1,000 text units (content filters, topics); $0.10 (PII) | Each checked input or output |
| **Code Interpreter / Browser** | Same rate as Runtime | While in use |
| **CloudWatch** | Log ingestion ($0.50–0.57/GB) and spans | Always on |
| **Evaluations** | Built-in judges: $2.40 in / $12 out per 1M tokens; batch 25% off | When you run evaluations |

**Worked examples (per month):**

| Scenario | Model | Total | Of which model tokens |
|---|---|---|---|
| Internal chat assistant: 200 users × 20 conversations × 6 turns, 2 model calls per turn, 8k input (60% cached) + 600 output tokens per call | Sonnet 4.6 | **≈ $1,045** | $962 (92%). Next: guardrails $38, memory $32, Runtime $9 |
| The same | Haiku 4.5 | **≈ $403** | $321 (80%) |
| Scheduled agent, hourly, 5 model calls per run | Haiku 4.5 | **≈ $22** | $21 (96%) |

**Cost levers, biggest first:**
1. **The model** (Haiku vs Sonnet: about 2.5× on the example).
2. **Prompt-cache hit rate** (60% → 90% saves about $300 on the Sonnet example).
3. **Guardrail scope.** Scan new input and the final answer ($38) rather than the whole prompt on every call ($672).
4. **Output tokens and model calls per turn.**
5. **Global vs geo profiles** (10%).
6. **Batch** for offline work.

Runtime, Gateway, Policy and Identity are rounding errors by comparison.

**Knowing who spent what:**
- one **application inference profile per agent**, tagged (agent, team, cost centre);
- IAM-principal cost allocation in CUR 2.0;
- per-run budgets in our templates' guard;
- AWS Budgets alerts and Cost Anomaly Detection.

---

## 6. Putting it together: a self-service agent platform

**Goal:**
- Employees create agents themselves, from harness configs or our templates.
- Users sign in with Auth0.
- Agents have their own identity.
- Every agent can run from live prompts, chat messages, events or a schedule.
- Costs are visible and capped.

```mermaid
flowchart TB
  AUTH["Author: portal (harness config) or template repo"] --> CI["CI: tests, scans, org-evals, review"]
  CI --> DEP["agentcore deploy (tags, inference profile, limits)"]
  CI --> REG["Agent Registry (approved agents, tools, skills)"]
  USER["User (Auth0 login)"] -->|"JWT"| GW
  CHAT["Slack / Teams bot"] -->|"user's Auth0 token"| GW
  EVT["EventBridge rule"] --> SF["Step Functions"]
  CRON["EventBridge Scheduler (cron)"] --> SF
  SF -->|"Auth0 M2M token"| GW
  GW["AgentCore Gateway: auth, rate limits, WAF, Policy"] --> RT["Harness or Runtime agent (one VM per session)"]
  DEP --> RT
  RT -->|"Converse"| BR["Bedrock (per-agent inference profile, guardrails)"]
  RT -->|"MCP"| GW
  GW --> TOOLS["Internal APIs, Knowledge Bases, SaaS (token vault)"]
  RT -.-> OBS["CloudWatch traces → Evaluations; cost reports per tag"]
```

**How each way of running works:**

| Mode | Path |
|---|---|
| **Live prompt** (web, IDE) | User signs in with Auth0 → Gateway → agent; answers stream back. One session per conversation |
| **Chat message** (Slack, Teams) | The bot verifies the message, maps the chat user to their Auth0 user (they link accounts once) and calls the Gateway with that user's token |
| **Event** | EventBridge rule → Step Functions → Gateway with the Auth0 M2M token of that workload. Or use the native Step Functions **harness step**, which authenticates with IAM. Step Functions gives retries, timeouts and a human-approval wait |
| **Schedule** | EventBridge Scheduler (cron) → Step Functions → as for events. AgentCore has no built-in scheduler |

**Rules we apply:**
- **One front door.** The Gateway, with runtimes set to accept only Gateway traffic. Rate limits, WAF, Policy and audit then apply to everyone.
- **Automation identity.** Scheduled and event runs act as their own Auth0 M2M application, never with a stored user token. If a trigger carries a user, the agent uses on-behalf-of exchange for that user.
- **Registry approval.** Nothing appears in the portal until its Registry record is approved. Publishing needs a second person.
- **Budgets on every agent:**
  - run limits (`--max-iterations`, `--max-tokens` on a harness; `RunGuard` in our templates);
  - Gateway rate limits per user;
  - an AWS Budget per agent tag;
  - a kill switch.
- **Model allowlist.** Every Bedrock model can be called by default, so an SCP allows only approved models. Use geo (`eu.`) profiles where data residency matters.

---

## 7. How the other vendors compare

| Part | AWS | Google Cloud | Microsoft Azure | Anthropic | OpenAI |
|---|---|---|---|---|---|
| Host your own agent code | **Runtime** (microVM per session, up to 8 h) | **Agent Runtime** (formerly Agent Engine): managed containers, no per-session VM | Foundry **hosted agents** (VM sandbox per session, ≤ 2 vCPU, Python/C#) | – | – (the Agents API can run tools on your compute) |
| Managed agent loop | **Harness** (Strands; shell, files, skills) | Managed Agents API (preview, "not for production") | Foundry prompt agents (no shell or files) | **Claude Managed Agents** (beta) | **Agents API** (beta, Codex loop) |
| Open-source agent library | Strands | ADK | Microsoft Agent Framework | Claude Agent SDK (runs the Claude Code binary) | Agents SDK |
| Tool gateway / MCP | **Gateway** | **Agent Gateway**, about 119 Google-managed MCP servers, Apigee | API Management + Foundry toolboxes | – | – |
| Agent identity + delegation | **Identity** (token vault, OBO; works with Auth0) | **Agent Identity** (SPIFFE, token vault) | **Entra Agent ID** (inbound Entra only) | Workload identity federation | Workload identity federation |
| Tool-call policy | **Cedar Policy** | IAM policies (CEL) at the Agent Gateway + Model Armor | Guardrails (mostly preview), APIM policies | – | – |
| Models | Many, incl. Claude and OpenAI | Gemini, Claude, others | OpenAI, Claude, others | Claude | OpenAI |
| EU data residency | Yes (geo profiles) | Yes (`eu` endpoint) | Yes (data zones) | **No** (global or US) | Yes (EU region, +10%) |

**Takeaway for us:**
- **Full stacks.** AWS, Google and Azure each offer the whole set: hosting your own code, a tool gateway, agent identity and tool-call policy.
- **Where AWS stands out:** per-session VM isolation and a GA managed loop. Google's governance (identity, gateway policies) is strong, but its managed loop is still preview.
- **Azure's catch:** inbound auth is tied to Entra, so Auth0 would need a gateway in front.
- **Anthropic and OpenAI:** their managed agents are betas without EU residency or zero data retention. Use their models through Bedrock, not their platforms.

---

## 8. Don't use

- **Bedrock Agents ("Agents Classic")**: closed to new customers. Use the harness or Runtime.
- **The Starter Toolkit CLI** (`pip install bedrock-agentcore-starter-toolkit`): unsupported. Both it and the new CLI install a command called `agentcore`, so uninstall it.
- **`bedrock-mantle` endpoint**: its traffic isn't in invocation logs, and it has no guardrails, no geo profiles and no application inference profiles. Stay on `bedrock-runtime` (Converse).
- **The Registry APIs under `bedrock-agentcore`**: they shut down 2026-10-30. Use `agent-registry`.
- **Knowledge-base type Kendra, Provisioned Throughput, latency-optimized inference, prompt routing**: legacy or unmaintained.
- **AgentCore Payments** (crypto wallets): out of scope unless compliance approves.

---

**Further reading:**
- [AgentCore developer guide](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/): [harness vs Runtime](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-vs-runtime.html), [skills](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-skills.html)
- [AgentCore pricing](https://aws.amazon.com/bedrock/agentcore/pricing/)
- [Bedrock user guide](https://docs.aws.amazon.com/bedrock/latest/userguide/)
- [Strands Agents](https://strandsagents.com/)
- [AgentCore CLI](https://github.com/aws/agentcore-cli)

In this repo:
- [`AGENT_IDENTITY_AUTH0.md`](AGENT_IDENTITY_AUTH0.md): Auth0 in depth
- [`templates/`](templates/README.md): our agent templates and evals
