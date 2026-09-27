"""Pure logic: no AWS, no HTTP, no clock. Easy to test and to read."""

from __future__ import annotations

from urllib.parse import quote

from domain import (
    AgentFailed,
    AgentRuntimeArn,
    AnswerEvent,
    AnswerText,
    Caller,
    HumanUser,
    Prompt,
    ServiceClient,
    Subject,
    TicketRequest,
)


def owns(owner: Subject, caller: Caller) -> bool:
    """Runtime doesn't tie sessions to users, so the agent does: only the starter may continue."""
    return caller.subject == owner


def first_message(caller: Caller, prompt: Prompt) -> str:
    """Per-user details go in the first message, never in the system prompt (keeps the cache)."""
    match caller:
        case HumanUser(first_name=str(name)):
            return f"[Context: you are assisting {name}.]\n\n{prompt.text}"
        case _:
            return prompt.text


def requester(caller: Caller) -> str:
    """Who a ticket is for: our user id for people, the client for services."""
    match caller:
        case HumanUser(user_id=user_id):
            return user_id.value
        case ServiceClient(subject=subject):
            return subject.value


def ticket_body(request: TicketRequest, caller: Caller) -> dict[str, str]:
    """The tickets API request. The requester comes from the token, never from the model."""
    return {
        "title": request.title,
        "description": request.description,
        "requester_id": requester(caller),
    }


def invocation_url(agent: AgentRuntimeArn, region: str) -> str:
    return (
        f"https://bedrock-agentcore.{region}.amazonaws.com/runtimes/"
        f"{quote(agent.value, safe='')}/invocations?qualifier=DEFAULT"
    )


def render(event: AnswerEvent) -> str:
    match event:
        case AnswerText(text=text):
            return text
        case AgentFailed(message=message):
            return f"\n[error: {message}]\n"
