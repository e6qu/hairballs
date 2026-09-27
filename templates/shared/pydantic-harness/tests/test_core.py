"""Pure core tests: no framework, no fakes."""

from __future__ import annotations

import pytest
from org_agents.core.messages import AwaitingApproval, Idle, Running
from org_agents.core.thread import ThreadState
from org_agents.domain import ApprovalId, PositiveInt, PrincipalId
from org_agents.parsing import ParseError

from org_pydantic_harness.core.context import (
    ContextPolicy,
    MessageKind,
    MessageShape,
    Truncated,
    Unchanged,
    truncate_output,
    window_start,
)
from org_pydantic_harness.core.session import recover

SMALL = ContextPolicy(PositiveInt(300), PositiveInt(100), PositiveInt(50), PositiveInt(6), PositiveInt(3))


def user(*answers: str) -> MessageShape:
    return MessageShape(MessageKind.REQUEST, True, frozenset(), frozenset(answers))


def results(*answers: str) -> MessageShape:
    return MessageShape(MessageKind.REQUEST, False, frozenset(), frozenset(answers))


def reply(*calls: str) -> MessageShape:
    return MessageShape(MessageKind.RESPONSE, False, frozenset(calls), frozenset())


# ---------------------------------------------------------------- truncation


def test_short_output_is_unchanged() -> None:
    assert truncate_output("x" * 300, SMALL) == Unchanged()


def test_long_output_keeps_head_and_tail() -> None:
    text = "H" * 100 + "M" * 1000 + "T" * 50
    result = truncate_output(text, SMALL)
    assert isinstance(result, Truncated)
    assert result.text.startswith("H" * 100) and result.text.endswith("T" * 50)
    assert "M" not in result.text and "1000 characters omitted" in result.text
    assert result.omitted_chars == 1000


def test_truncation_is_idempotent() -> None:
    once = truncate_output("z" * 10_000, SMALL)
    assert isinstance(once, Truncated)
    assert truncate_output(once.text, SMALL) == Unchanged()


def test_policy_invariants() -> None:
    with pytest.raises(ValueError):
        ContextPolicy(PositiveInt(100), PositiveInt(60), PositiveInt(60), PositiveInt(6), PositiveInt(3))
    with pytest.raises(ValueError):
        ContextPolicy(PositiveInt(300), PositiveInt(10), PositiveInt(10), PositiveInt(6), PositiveInt(6))


def test_policy_parse_defaults_and_errors() -> None:
    assert ContextPolicy.parse({}) == ContextPolicy.default()
    assert ContextPolicy.parse({"max_messages": 10, "keep_messages": 4}).keep_messages == PositiveInt(4)
    with pytest.raises(ParseError, match=r"\$\.context"):
        ContextPolicy.parse({"max_messages": 4, "keep_messages": 4})
    with pytest.raises(ParseError, match="max_tool_output_chars"):
        ContextPolicy.parse({"max_tool_output_chars": "lots"})


# ---------------------------------------------------------------- sliding window


def test_short_history_is_kept() -> None:
    assert window_start([user(), reply(), user(), reply()], SMALL) == 0


def test_window_starts_at_a_user_turn() -> None:
    shapes = [user(), reply(), user(), reply(), user(), reply(), user(), reply()]
    start = window_start(shapes, SMALL)
    assert start == 6 and shapes[start].has_user_prompt


def test_window_never_splits_a_tool_call_from_its_result() -> None:
    shapes = [
        user(),
        reply("a"),
        results("a"),
        reply(),
        user(),
        reply("b"),
        results("b"),
        reply("c"),
        results("c"),
        reply(),
    ]
    # target = 10 - 3 = 7 (a response); the first safe start at/after 7 does not exist, so it
    # moves back to the user turn at 4, which keeps both b and c with their results.
    assert window_start(shapes, SMALL) == 4


def test_request_with_orphan_result_is_not_a_safe_start() -> None:
    # A user prompt merged with a tool result (e.g. steering) cannot start the window.
    shapes = [user(), reply("a"), user("a"), reply(), user(), reply(), user(), reply()]
    assert window_start(shapes, SMALL) == 6
    shapes = [user(), reply(), user(), reply(), user(), reply("a"), user("a"), reply()]
    assert window_start(shapes, SMALL) == 4


def test_no_safe_start_keeps_everything() -> None:
    shapes = [user(), reply("a"), results("a"), reply("b"), results("b"), reply("c"), results("c")]
    assert window_start(shapes, SMALL) == 0


# ---------------------------------------------------------------- session recovery


def test_recover_turns_running_into_idle_and_keeps_approvals() -> None:
    alice = PrincipalId("auth0|alice")
    running = ThreadState(Running(alice), frozenset(), ())
    assert recover(running).status == Idle()
    waiting = ThreadState(AwaitingApproval(alice, ApprovalId("call-1"), frozenset()), frozenset(), ())
    assert recover(waiting) == waiting
