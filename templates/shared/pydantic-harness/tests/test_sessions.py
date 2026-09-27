"""Session snapshot codec: domain thread state + framework message history."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from org_agents.core.messages import AwaitingApproval, Idle, Running
from org_agents.core.thread import QueuedPrompt, ThreadState
from org_agents.domain import ApprovalId, MessageId, PrincipalId, Prompt, SessionId
from org_agents.parsing import ParseError
from pydantic_ai.messages import ModelRequest, ModelResponse, TextPart, UserPromptPart

from org_pydantic_harness.shell.sessions import (
    JsonFileSessionStore,
    SessionSnapshot,
    parse_snapshot,
    parse_thread,
    snapshot_to_json,
    thread_to_json,
)

ALICE = PrincipalId("auth0|alice")
SESSION = SessionId("thread/with:odd-chars")


@pytest.mark.parametrize(
    "status",
    [
        Idle(),
        Running(ALICE),
        AwaitingApproval(ALICE, ApprovalId("call-0-0"), frozenset({PrincipalId("auth0|lead")})),
    ],
)
def test_thread_round_trip(status: Idle | Running | AwaitingApproval) -> None:
    state = ThreadState(status, frozenset({MessageId("m1")}), (QueuedPrompt(ALICE, Prompt("later")),))
    assert parse_thread(json.loads(json.dumps(thread_to_json(state)))) == state


def test_file_store_round_trip(tmp_path: Path) -> None:
    store = JsonFileSessionStore(tmp_path)
    messages = (ModelRequest(parts=[UserPromptPart("hi")]), ModelResponse(parts=[TextPart("hello")]))
    store.save(SESSION, SessionSnapshot(ThreadState.initial(), messages))
    loaded = store.load(SESSION)
    assert loaded is not None and loaded.thread == ThreadState.initial()
    assert [type(m) for m in loaded.messages] == [ModelRequest, ModelResponse]
    assert store.load(SessionId("other")) is None


def test_snapshot_is_parsed_at_the_boundary() -> None:
    doc = snapshot_to_json(SESSION, SessionSnapshot(ThreadState.initial(), ()))
    with pytest.raises(ParseError, match=r"\$\.session"):
        parse_snapshot(doc, SessionId("someone-else"))
    with pytest.raises(ParseError, match=r"\$\.version"):
        parse_snapshot({**doc, "version": 99}, SESSION)
    with pytest.raises(ParseError, match=r"\$\.messages"):
        parse_snapshot({**doc, "messages": [{"kind": "nonsense"}]}, SESSION)
    with pytest.raises(ParseError, match=r"\$\.thread\.status\.kind"):
        parse_snapshot({**doc, "thread": {"status": {"kind": "?"}, "seen": [], "follow_ups": []}}, SESSION)
