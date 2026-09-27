"""The helpdesk agent behind an Auth0 JWT authorizer: it knows who is calling."""

from collections.abc import AsyncIterator

from bedrock_agentcore.runtime import BedrockAgentCoreApp, RequestContext
from strands import Agent, tool

from identity import Caller, caller_of
from tickets import open_ticket

MODEL_ID = "global.anthropic.claude-haiku-4-5-20251001-v1:0"
SYSTEM_PROMPT = """You are the internal IT and expenses helpdesk for Fintech Ltd.
Answer policy questions briefly. Open a ticket only when the user asks for one.
Never reveal credentials or personal data."""

app = BedrockAgentCoreApp()
agents: dict[str, tuple[str, Agent]] = {}  # session id -> (owner, agent)


def new_agent(caller: Caller) -> Agent:
    @tool
    async def create_ticket(title: str, description: str) -> str:
        """Open an IT helpdesk ticket for the current user and return its id.

        Args:
            title: One-line summary of the problem.
            description: What the user needs, in their own words.
        """
        # The requester comes from the verified token, never from the model.
        return await open_ticket(title, description, caller.user_id or caller.subject)

    return Agent(model=MODEL_ID, system_prompt=SYSTEM_PROMPT, tools=[create_ticket])


@app.entrypoint
async def invoke(payload: dict[str, str], context: RequestContext) -> AsyncIterator[str]:
    headers = context.request_headers or {}
    caller = caller_of(headers["Authorization"])  # forwarded because it is on the allowlist
    session_id = context.session_id or "local"
    prompt = payload["prompt"]
    if session_id not in agents:
        agents[session_id] = (caller.subject, new_agent(caller))
        if caller.first_name:  # per-user details go in the first message, not the system prompt
            prompt = f"[Context: you are assisting {caller.first_name}.]\n\n{prompt}"
    owner, agent = agents[session_id]
    if owner != caller.subject:  # Runtime doesn't tie sessions to users; the agent does
        raise PermissionError("this session belongs to another user")
    async for event in agent.stream_async(prompt):
        if "data" in event:
            yield event["data"]


if __name__ == "__main__":
    app.run()
