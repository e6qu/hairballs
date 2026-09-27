# hairballs

Research on standardizing agent frameworks for a fintech. The fintech is committed to **AWS**: **Amazon Bedrock** for models and **Amazon Bedrock AgentCore** as the agent platform.

| Document | What it covers |
|---|---|
| [`AGENTIC_FRAMEWORK_SCOPING.md`](AGENTIC_FRAMEWORK_SCOPING.md) | Main scoping study, including the recommendation (AgentCore managed harness for Tier 0, Strands on AgentCore Runtime for Tier 1). Also covers: HN / GitHub landscape; candidate profiles; head-to-head of Strands, LangGraph, Pydantic AI, pi, opencode and Hermes; supply chain; agent-loop internals; runaway controls; reference architecture; PoC plan |
| [`AGENTS_BUILDING_BLOCKS.md`](AGENTS_BUILDING_BLOCKS.md) | 37 agent building blocks, and which framework, harness or AgentCore service provides each one. Also: headless and autonomous operation of pi, opencode and Hermes |
| [`AGENT_IDENTITY_AUTH0.md`](AGENT_IDENTITY_AUTH0.md) | Auth0 with AgentCore Identity: inbound JWT, workload identity, Token Vault, OBO, Cedar policies on Auth0 claims, CIBA approvals |
| [`AGENT_PI_BEDROCK.md`](AGENT_PI_BEDROCK.md) | Running pi and pi extensions autonomously on Bedrock and AgentCore Runtime |
| [`AGENTS_OPENCODE_BEDROCK.md`](AGENTS_OPENCODE_BEDROCK.md) | Running opencode agents and plugins autonomously on Bedrock and AgentCore Runtime |

All diagrams are Mermaid embedded in Markdown and target the **current** AgentCore (the `@aws/agentcore` CLI), not the legacy Starter Toolkit or Bedrock Agents Classic. Facts were verified on 2026-09-26/27. Anything unverified is marked "verify in PoC".
