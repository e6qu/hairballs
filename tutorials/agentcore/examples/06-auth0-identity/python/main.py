"""The helpdesk agent behind an Auth0 JWT authorizer: it knows who is calling (the shell)."""

from __future__ import annotations

from collections.abc import AsyncIterator

from bedrock_agentcore.runtime import BedrockAgentCoreApp, RequestContext
from strands import Agent, tool

from core import first_message, owns
from domain import (
    Caller,
    SessionId,
    Subject,
    TicketRequest,
    claims_of,
    parse_caller,
    parse_invocation,
)
from tickets import open_ticket

MODEL_ID = "global.anthropic.claude-haiku-4-5-20251001-v1:0"
SYSTEM_PROMPT = """You are the internal IT and expenses helpdesk for Fintech Ltd.
Answer policy questions briefly. Open a ticket only when the user asks for one.
Never reveal credentials or personal data."""

app = BedrockAgentCoreApp()
agents: dict[SessionId, tuple[Subject, Agent]] = {}  # session -> (owner, agent)


def new_agent(caller: Caller) -> Agent:
    @tool
    async def create_ticket(title: str, description: str) -> str:
        """Open an IT helpdesk ticket for the current user and return its id.

        Args:
            title: One-line summary of the problem.
            description: What the user needs, in their own words.
        """
        ticket = await open_ticket(TicketRequest.parse(title, description), caller)
        return ticket.value

    return Agent(model=MODEL_ID, system_prompt=SYSTEM_PROMPT, tools=[create_ticket])


@app.entrypoint
async def invoke(payload: object, context: RequestContext) -> AsyncIterator[str]:
    headers = context.request_headers or {}
    caller = parse_caller(claims_of(headers.get("Authorization")))  # on the header allowlist
    session = SessionId.parse(context.session_id)
    prompt = parse_invocation(payload)
    if session not in agents:
        agents[session] = (caller.subject, new_agent(caller))
        text = first_message(caller, prompt)
    else:
        text = prompt.text
    owner, agent = agents[session]
    if not owns(owner, caller):
        raise PermissionError("this session belongs to another caller")
    async for event in agent.stream_async(text):
        data = event.get("data")
        if isinstance(data, str):
            yield data


if __name__ == "__main__":
    app.run()
