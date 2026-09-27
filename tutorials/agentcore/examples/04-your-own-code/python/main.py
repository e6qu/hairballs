"""The helpdesk agent as code: a Strands agent inside an AgentCore Runtime app."""

import uuid
from collections.abc import AsyncIterator

from bedrock_agentcore.runtime import BedrockAgentCoreApp, RequestContext
from strands import Agent, tool

MODEL_ID = "global.anthropic.claude-haiku-4-5-20251001-v1:0"
SYSTEM_PROMPT = """You are the internal IT and expenses helpdesk for Fintech Ltd.
Answer policy questions briefly. Open a ticket only when the user asks for one.
Never reveal credentials or personal data."""

app = BedrockAgentCoreApp()
agents: dict[str, Agent] = {}


@tool
def create_ticket(title: str, description: str) -> str:
    """Open an IT helpdesk ticket and return its id.

    Args:
        title: One-line summary of the problem.
        description: What the user needs, in their own words.
    """
    ticket_id = f"TCK-{uuid.uuid4().hex[:8]}"
    print(f"ticket {ticket_id}: {title} ({len(description)} chars)")
    return ticket_id


def agent_for(session_id: str) -> Agent:
    """One agent (and so one conversation) per session."""
    if session_id not in agents:
        agents[session_id] = Agent(
            model=MODEL_ID, system_prompt=SYSTEM_PROMPT, tools=[create_ticket]
        )
    return agents[session_id]


@app.entrypoint
async def invoke(payload: dict[str, str], context: RequestContext) -> AsyncIterator[str]:
    agent = agent_for(context.session_id or "local")
    async for event in agent.stream_async(payload["prompt"]):
        if "data" in event:
            yield event["data"]


if __name__ == "__main__":
    app.run()  # serves /invocations and /ping on port 8080
