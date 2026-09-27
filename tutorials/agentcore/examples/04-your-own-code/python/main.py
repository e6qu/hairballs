"""The helpdesk agent as code: a Strands agent inside an AgentCore Runtime app (the shell)."""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator

from bedrock_agentcore.runtime import BedrockAgentCoreApp, RequestContext
from strands import Agent, tool

from core import new_ticket_id, ticket_log_line
from domain import SessionId, TicketRequest, parse_agent_text, parse_invocation

MODEL_ID = "global.anthropic.claude-haiku-4-5-20251001-v1:0"
SYSTEM_PROMPT = """You are the internal IT and expenses helpdesk for Fintech Ltd.
Answer policy questions briefly. Open a ticket only when the user asks for one.
Never reveal credentials or personal data."""

app = BedrockAgentCoreApp()
agents: dict[SessionId, Agent] = {}


@tool
def create_ticket(title: str, description: str) -> str:
    """Open an IT helpdesk ticket and return its id.

    Args:
        title: One-line summary of the problem.
        description: What the user needs, in their own words.
    """
    request = TicketRequest.parse(title, description)  # the model's arguments -> domain type
    ticket = new_ticket_id(uuid.uuid4().hex)
    print(ticket_log_line(ticket, request))
    return ticket.value


def agent_for(session: SessionId) -> Agent:
    """One agent (and so one conversation) per session."""
    if session not in agents:
        agents[session] = Agent(model=MODEL_ID, system_prompt=SYSTEM_PROMPT, tools=[create_ticket])
    return agents[session]


@app.entrypoint
async def invoke(payload: object, context: RequestContext) -> AsyncIterator[str]:
    prompt = parse_invocation(payload)  # outside data -> domain types, right here
    session = SessionId.parse(context.session_id)
    async for event in agent_for(session).stream_async(prompt.text):
        text = parse_agent_text(event)
        if text is not None:
            yield text


if __name__ == "__main__":
    app.run()  # serves /invocations and /ping on port 8080
