"""The helpdesk agent with its thread in AgentCore Memory and the prompt cache on (the shell)."""

from __future__ import annotations

import os
from collections.abc import AsyncIterator

from bedrock_agentcore.memory.integrations.strands.config import AgentCoreMemoryConfig
from bedrock_agentcore.memory.integrations.strands.session_manager import (
    AgentCoreMemorySessionManager,
)
from bedrock_agentcore.runtime import BedrockAgentCoreApp, RequestContext
from strands import Agent
from strands.models import BedrockModel, CacheConfig

from domain import ActorId, MemoryId, SessionId, parse_invocation

# Set by `agentcore add memory` or Terraform; parsed once, at startup.
MEMORY = MemoryId.parse(os.environ.get("MEMORY_HELPDESK_MEMORY_ID"))
MODEL_ID = "global.anthropic.claude-haiku-4-5-20251001-v1:0"
SYSTEM_PROMPT = """You are the internal IT and expenses helpdesk for Fintech Ltd.
Answer policy questions briefly. Never reveal credentials or personal data."""

app = BedrockAgentCoreApp()
agents: dict[SessionId, Agent] = {}


def agent_for(actor: ActorId, session: SessionId) -> Agent:
    """One agent per session. Its messages are loaded from, and saved to, Memory."""
    if session not in agents:
        config = AgentCoreMemoryConfig(
            memory_id=MEMORY.value, actor_id=actor.value, session_id=session.value
        )
        thread = AgentCoreMemorySessionManager(config, region_name="eu-west-1")
        model = BedrockModel(model_id=MODEL_ID, cache_config=CacheConfig(strategy="auto"))
        agents[session] = Agent(model=model, system_prompt=SYSTEM_PROMPT, session_manager=thread)
    return agents[session]


@app.entrypoint
async def invoke(payload: object, context: RequestContext) -> AsyncIterator[str]:
    # Who is calling: user_id defaults to "anonymous" so that `agentcore invoke` works;
    # tutorial 06 takes the verified user id from the Auth0 token instead.
    invocation = parse_invocation(payload)  # outside data -> domain types, right here
    session = SessionId.parse(context.session_id)
    async for event in agent_for(invocation.actor, session).stream_async(invocation.prompt):
        data = event.get("data")
        if isinstance(data, str):
            yield data


if __name__ == "__main__":
    app.run()
