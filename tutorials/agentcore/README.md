# AgentCore tutorials

Ten short tutorials. Each teaches one thing and builds on the one before. The running example is **helpdesk**, an internal assistant for expense and IT questions that can open tickets.

Every tutorial shows:

- **application code** side by side, **Python | TypeScript**;
- **infrastructure** side by side, **agentcore CLI | AWS CLI | Terraform**.

The full, checked source for each tutorial is in [`examples/`](examples/).

Start with [the developer introduction](../../AGENTCORE_BEDROCK_LANDSCAPE.md) if you haven't read it: it explains what Runtime, the harness and Strands are.

| # | Tutorial | You learn |
|---|---|---|
| 01 | [Your first agent](01-first-agent.md) | Create, deploy and prompt a harness agent. Invoke it from code |
| 02 | [Skills](02-skills.md) | Give the agent knowledge and scripts it loads on demand |
| 03 | [Tools and the Gateway](03-tools-and-gateway.md) | Connect MCP tools; put tools behind one governed Gateway |
| 04 | [Your own code](04-your-own-code.md) | Write the agent with Strands and host it on Runtime |
| 05 | [Conversations and caching](05-conversations-and-caching.md) | Sessions, Memory, forking threads, prompt caching |
| 06 | [Auth0 identity](06-auth0-identity.md) | Users and services sign in with Auth0; agents call APIs with managed credentials |
| 07 | [Policy](07-policy.md) | Allow or deny tool calls with Cedar rules on Auth0 claims |
| 08 | [Events and schedules](08-events-and-schedules.md) | Run agents from EventBridge events and cron via Lambda |
| 09 | [Observability, evals and costs](09-observability-evals-costs.md) | Traces, evaluations, token usage, per-agent cost tracking |
| 10 | [A coding agent](10-coding-agent.md) | Workspace storage, git with short-lived tokens, running tests |

## Before you start

- **An AWS account** with Bedrock and AgentCore available in your region. The tutorials use `eu-west-1`.
- **Tools:**
  - Node.js 20+ and `npm install -g @aws/agentcore@0.30.0`;
  - Python 3.12 with [uv](https://docs.astral.sh/uv/);
  - AWS CLI v2;
  - Terraform 1.16+.
- **Model access.** All Bedrock models are callable by default. Your organisation may restrict them with an SCP. The tutorials use Claude Haiku 4.5 (`global.anthropic.claude-haiku-4-5-20251001-v1:0`) to keep costs low. Use an `eu.` profile if data must stay in the EU.
- **Auth0** (from tutorial 06): a tenant where you can create an API, applications and an Action.

## Versions used

| | Python | TypeScript |
|---|---|---|
| Agent loop | `strands-agents` 1.57.1, `strands-agents-tools` 0.8.9 | `@strands-agents/sdk` 1.19.0 |
| Runtime app and clients | `bedrock-agentcore` 1.23.1 | `bedrock-agentcore` 0.4.4 |
| AWS SDK | `boto3` 1.43.103 | `@aws-sdk/client-bedrock-agentcore`, `@aws-sdk/client-bedrock-agentcore-control` 3.1141.0 |

Infrastructure: `@aws/agentcore` CLI 0.30.0, and Terraform with the `hashicorp/aws` provider ~> 6.66.

**How the examples are checked:** no example is run against AWS. [`check.sh`](check.sh) runs:

| What | Checks |
|---|---|
| Python | `ruff format --check`, `ruff check`, `mypy --strict` |
| TypeScript | `tsc --noEmit` (strict), `prettier --check` |
| Terraform | `terraform fmt -check`, `terraform validate` |
| `cli.sh` | `shellcheck` |
| Tutorials | `markdownlint`, plus a test that every code line shown in a tutorial exists in its checked example files |

AWS CLI commands were also checked against the botocore 1.43.103 API models.

```bash
tutorials/agentcore/check.sh              # all tutorials
tutorials/agentcore/check.sh 01-first-agent
```

Anything that needs a real account to confirm is marked **[verify]**.

## Cost

Agents cost nothing while idle. A tutorial run with Haiku costs cents. Each tutorial ends with a **Clean up** step; run it.
