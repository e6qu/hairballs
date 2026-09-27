"""AgentCore Runtime entrypoint (shell): HTTP ``/invocations`` + ``/ping`` via ``bedrock-agentcore``.

Run locally:  ``uv run python -m generic_agent_pydantic_harness.shell.app``  (serves 0.0.0.0:8080)
Deploy:       ``agentcore deploy`` (see README).

Sessions are persisted by the harness. ``SESSIONS_DIR`` selects the JSON-file store (for example
AgentCore Runtime session storage); without it, sessions are kept in memory for the microVM's life.
"""

from __future__ import annotations

import os
import threading
from collections.abc import Mapping
from pathlib import Path

from bedrock_agentcore.runtime import BedrockAgentCoreApp
from bedrock_agentcore.runtime.context import RequestContext
from generic_tools.shell.backends import LocalCorpus, SqliteTicketStore
from generic_tools.shell.service import GenericTools
from org_agents.domain import SessionId
from org_agents.parsing import ParseError
from org_agents.shell.audit import JsonLinesAuditSink
from org_agents.shell.clock import SystemClock
from org_agents.shell.config import kill_switch_from
from org_agents.shell.invocation import parse_incoming, principal_from_headers
from org_agents.shell.replies import render
from org_agents.shell.settings import Settings, load_settings
from org_pydantic_harness.shell import (
    ContextPolicy,
    Harness,
    InMemorySessionStore,
    JsonFileSessionStore,
    SessionStore,
    bedrock_model,
    create_harness,
    load_context_policy,
)

from generic_agent_pydantic_harness.shell.tools import build_tools


class Registry:
    """One harness per session. AgentCore gives each session its own microVM, so this is small."""

    def __init__(self, settings: Settings, context: ContextPolicy, env: Mapping[str, str]) -> None:
        self._settings = settings
        self._context = context
        self._harnesses: dict[SessionId, Harness] = {}
        self._lock = threading.Lock()
        self._tools = build_tools(
            GenericTools(LocalCorpus(), SqliteTicketStore(env.get("TICKETS_DB", ":memory:")))
        )
        sessions_dir = env.get("SESSIONS_DIR")
        self._store: SessionStore = (
            JsonFileSessionStore(Path(sessions_dir)) if sessions_dir else InMemorySessionStore()
        )

    def harness(self, session: SessionId) -> Harness:
        with self._lock:
            if session not in self._harnesses:
                cfg = self._settings.agent
                self._harnesses[session] = create_harness(
                    self._settings,
                    self._tools,
                    bedrock_model(cfg.model_id, cfg.region),  # prompt caching on where supported
                    session=session,
                    clock=SystemClock(),
                    audit=JsonLinesAuditSink(),
                    kill_switch=lambda: kill_switch_from(os.environ),
                    store=self._store,
                    context=self._context,
                )
            return self._harnesses[session]


app = BedrockAgentCoreApp()
_registry: Registry | None = None


def registry() -> Registry:
    global _registry
    if _registry is None:
        _registry = Registry(load_settings(os.environ), load_context_policy(os.environ), os.environ)
    return _registry


@app.entrypoint
def invoke(payload: object, context: RequestContext) -> dict[str, object]:
    try:
        session = SessionId.parse(context.session_id or "local-session-0000000000000000000000", "$.session")
        sender = principal_from_headers(context.request_headers or {})
        incoming = parse_incoming(payload, sender)
    except ParseError as exc:
        return {"status": "invalid_request", "path": exc.path, "error": exc.message}
    return render(registry().harness(session).handle(incoming))


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080)
