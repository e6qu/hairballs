"""The helpdesk agent with its thread in AgentCore Memory and the prompt cache on."""

import os
from collections.abc import AsyncIterator

from bedrock_agentcore.memory.integrations.strands.config import AgentCoreMemoryConfig
from bedrock_agentcore.memory.integrations.strands.session_manager import (
    AgentCoreMemorySessionManager,
)
from bedrock_agentcore.runtime import BedrockAgentCoreApp, RequestContext
from strands import Agent
from strands.models import BedrockModel, CacheConfig

MEMORY_ID = os.environ["MEMORY_HELPDESK_MEMORY_ID"]  # set by `agentcore add memory` or Terraform
MODEL_ID = "global.anthropic.claude-haiku-4-5-20251001-v1:0"
SYSTEM_PROMPT = """You are the internal IT and expenses helpdesk for Fintech Ltd.
Answer policy questions briefly. Never reveal credentials or personal data."""

app = BedrockAgentCoreApp()
agents: dict[str, Agent] = {}


def agent_for(user_id: str, session_id: str) -> Agent:
    """One agent per session. Its messages are loaded from, and saved to, Memory."""
    if session_id not in agents:
        thread = AgentCoreMemorySessionManager(
            AgentCoreMemoryConfig(memory_id=MEMORY_ID, actor_id=user_id, session_id=session_id),
            region_name="eu-west-1",
        )
        model = BedrockModel(model_id=MODEL_ID, cache_config=CacheConfig(strategy="auto"))
        agents[session_id] = Agent(model=model, system_prompt=SYSTEM_PROMPT, session_manager=thread)
    return agents[session_id]


@app.entrypoint
async def invoke(payload: dict[str, str], context: RequestContext) -> AsyncIterator[str]:
    # Who is calling. The default lets `agentcore invoke` work; tutorial 06 takes the verified
    # user id from the Auth0 token instead.
    user_id = payload.get("user_id", "anonymous")
    agent = agent_for(user_id, context.session_id or "local")
    async for event in agent.stream_async(payload["prompt"]):
        if "data" in event:
            yield event["data"]


if __name__ == "__main__":
    app.run()
