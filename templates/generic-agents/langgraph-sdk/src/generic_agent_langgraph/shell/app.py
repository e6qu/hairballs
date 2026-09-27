"""AgentCore Runtime entrypoint (shell): HTTP ``/invocations`` + ``/ping`` via ``bedrock-agentcore``.

Run locally:  ``uv run python -m generic_agent_langgraph.shell.app``  (serves 0.0.0.0:8080)
Deploy:       ``agentcore deploy`` (see README).
"""

from __future__ import annotations

import os
import threading
from collections.abc import Mapping

from bedrock_agentcore.runtime import BedrockAgentCoreApp
from bedrock_agentcore.runtime.context import RequestContext
from generic_tools.shell.backends import LocalCorpus, SqliteTicketStore
from generic_tools.shell.service import GenericTools
from langchain_aws import ChatBedrockConverse
from org_agents.domain import SessionId
from org_agents.parsing import ParseError
from org_agents.shell.audit import JsonLinesAuditSink
from org_agents.shell.clock import SystemClock
from org_agents.shell.config import kill_switch_from
from org_agents.shell.invocation import parse_incoming, principal_from_headers
from org_agents.shell.replies import render
from org_agents.shell.settings import Settings, load_settings

from generic_agent_langgraph.shell.runner import SessionRunner


def _chat_model(settings: Settings, env: Mapping[str, str]) -> ChatBedrockConverse:
    cfg = settings.agent
    # For an application inference profile ARN, set BEDROCK_BASE_MODEL_ID (e.g.
    # "anthropic.claude-sonnet-4-6") so langchain-aws can detect the provider features and caching.
    base = env.get("BEDROCK_BASE_MODEL_ID")
    if base:
        return ChatBedrockConverse(model=cfg.model_id.value, region_name=cfg.region.value, base_model=base)
    return ChatBedrockConverse(model=cfg.model_id.value, region_name=cfg.region.value)


class Registry:
    """One runner per session. AgentCore gives each session its own microVM, so this is small."""

    def __init__(self, settings: Settings, env: Mapping[str, str]) -> None:
        self._settings = settings
        self._env = env
        self._runners: dict[SessionId, SessionRunner] = {}
        self._lock = threading.Lock()
        self._tools = GenericTools(LocalCorpus(), SqliteTicketStore(env.get("TICKETS_DB", ":memory:")))

    def runner(self, session: SessionId) -> SessionRunner:
        with self._lock:
            if session not in self._runners:
                self._runners[session] = SessionRunner(
                    session,
                    self._settings,
                    _chat_model(self._settings, self._env),
                    self._tools,
                    SystemClock(),
                    JsonLinesAuditSink(),
                    lambda: kill_switch_from(os.environ),
                )
            return self._runners[session]


app = BedrockAgentCoreApp()
_registry: Registry | None = None


def registry() -> Registry:
    global _registry
    if _registry is None:
        _registry = Registry(load_settings(os.environ), os.environ)
    return _registry


@app.entrypoint
def invoke(payload: object, context: RequestContext) -> dict[str, object]:
    try:
        session = SessionId.parse(context.session_id or "local-session-0000000000000000000000", "$.session")
        sender = principal_from_headers(context.request_headers or {})
        incoming = parse_incoming(payload, sender)
    except ParseError as exc:
        return {"status": "invalid_request", "path": exc.path, "error": exc.message}
    return render(registry().runner(session).handle(incoming))


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080)
