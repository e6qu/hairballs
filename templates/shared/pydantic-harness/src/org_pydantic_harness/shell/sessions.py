"""Session persistence (shell): the thread state plus the Pydantic AI message history.

A snapshot holds two things:

* the org ``ThreadState`` (status, seen message ids, queued follow-ups), serialized by the small
  ``thread_to_json`` / ``parse_thread`` pair below (domain in, JSON out, parsed back into domain
  types; no DTO mirror classes);
* who the thread's pending work is for: the ``Caller`` of the run owner and of queued senders
  (so an approval or follow-up after a restart still knows its requester), and the speaker the
  model was last introduced to. Callers carry PII (name, email); the store holds the conversation
  anyway, so it must be protected like it. Callers are parsed back into domain types on load;
* the framework's own message history, serialized with Pydantic AI's ``ModelMessagesTypeAdapter``
  (``pydantic_ai/messages.py``). That format belongs to the framework, so the framework's adapter
  is the right parser for it; it never leaves this module and the harness.

Stores: ``InMemorySessionStore`` (tests, single process) and ``JsonFileSessionStore`` (one JSON file
per session, atomic replace). For AgentCore Runtime, point the file store at persistent session
storage, or implement ``SessionStore`` over DynamoDB/S3.
"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
import threading
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from org_agents.core.messages import AwaitingApproval, Idle, Running, ThreadStatus
from org_agents.core.thread import QueuedPrompt, ThreadState
from org_agents.domain import ApprovalId, MessageId, PrincipalId, Prompt, SessionId
from org_agents.identity import Caller, EmailAddress, HumanUser, PersonName, ServiceClient, UserId
from org_agents.parsing import ParseError, expect_int, expect_mapping, expect_sequence, expect_str, field
from pydantic import ValidationError
from pydantic_ai.messages import ModelMessage, ModelMessagesTypeAdapter

_FORMAT_VERSION = 2
_READABLE_VERSIONS = frozenset({1, _FORMAT_VERSION})  # version 1 had no callers


@dataclass(frozen=True, slots=True)
class SessionSnapshot:
    thread: ThreadState
    messages: tuple[ModelMessage, ...]
    callers: tuple[Caller, ...] = ()  # at most one per subject
    introduced: PrincipalId | None = None  # the speaker the model was last told it is assisting


class SessionStore(Protocol):
    def load(self, session: SessionId) -> SessionSnapshot | None: ...

    def save(self, session: SessionId, snapshot: SessionSnapshot) -> None: ...


# ---------------------------------------------------------------- thread state <-> JSON


def _status_to_json(status: ThreadStatus) -> dict[str, object]:
    match status:
        case Idle():
            return {"kind": "idle"}
        case Running(owner=owner):
            return {"kind": "running", "owner": owner.value}
        case AwaitingApproval(owner=owner, approval_id=aid, approvers=approvers):
            return {
                "kind": "awaiting_approval",
                "owner": owner.value,
                "approval_id": aid.value,
                "approvers": sorted(p.value for p in approvers),
            }


def thread_to_json(state: ThreadState) -> dict[str, object]:
    return {
        "status": _status_to_json(state.status),
        "seen": sorted(m.value for m in state.seen),
        "follow_ups": [{"sender": q.sender.value, "prompt": q.prompt.text} for q in state.follow_ups],
    }


def _parse_status(raw: object, path: str) -> ThreadStatus:
    fields = expect_mapping(raw, path)
    kind = expect_str(field(fields, "kind", path), f"{path}.kind")
    if kind == "idle":
        return Idle()
    if kind not in {"running", "awaiting_approval"}:
        raise ParseError(f"{path}.kind", "must be idle, running or awaiting_approval")
    owner = PrincipalId.parse(field(fields, "owner", path), f"{path}.owner")
    if kind == "running":
        return Running(owner)
    approvers = expect_sequence(field(fields, "approvers", path), f"{path}.approvers")
    return AwaitingApproval(
        owner,
        ApprovalId.parse(field(fields, "approval_id", path), f"{path}.approval_id"),
        frozenset(PrincipalId.parse(a, f"{path}.approvers[{i}]") for i, a in enumerate(approvers)),
    )


def parse_thread(raw: object, path: str = "$.thread") -> ThreadState:
    fields = expect_mapping(raw, path)
    seen = expect_sequence(field(fields, "seen", path), f"{path}.seen")
    follow_ups = expect_sequence(field(fields, "follow_ups", path), f"{path}.follow_ups")

    def queued(item: object, at: str) -> QueuedPrompt:
        entry = expect_mapping(item, at)
        return QueuedPrompt(
            PrincipalId.parse(field(entry, "sender", at), f"{at}.sender"),
            Prompt.parse(field(entry, "prompt", at), f"{at}.prompt"),
        )

    return ThreadState(
        status=_parse_status(field(fields, "status", path), f"{path}.status"),
        seen=frozenset(MessageId.parse(m, f"{path}.seen[{i}]") for i, m in enumerate(seen)),
        follow_ups=tuple(queued(q, f"{path}.follow_ups[{i}]") for i, q in enumerate(follow_ups)),
    )


# ---------------------------------------------------------------- callers <-> JSON


def caller_to_json(caller: Caller) -> dict[str, object]:
    match caller:
        case HumanUser(user_id=user_id, subject=subject, email=email, given_name=given, family_name=family):
            return {
                "kind": "user",
                "subject": subject.value,
                "user_id": user_id.value,
                "email": email.value,
                "given_name": given.value if given else None,
                "family_name": family.value if family else None,
            }
        case ServiceClient(subject=subject):
            return {"kind": "service", "subject": subject.value}


def parse_caller(raw: object, path: str) -> Caller:
    fields = expect_mapping(raw, path)
    kind = expect_str(field(fields, "kind", path), f"{path}.kind")
    subject = PrincipalId.parse(field(fields, "subject", path), f"{path}.subject")
    if kind == "service":
        return ServiceClient(subject)
    if kind != "user":
        raise ParseError(f"{path}.kind", "must be user or service")
    given, family = fields.get("given_name"), fields.get("family_name")
    return HumanUser(
        user_id=UserId.parse(field(fields, "user_id", path), f"{path}.user_id"),
        subject=subject,
        email=EmailAddress.parse(field(fields, "email", path), f"{path}.email"),
        given_name=PersonName.parse(given, f"{path}.given_name") if given is not None else None,
        family_name=PersonName.parse(family, f"{path}.family_name") if family is not None else None,
    )


def needed_callers(thread: ThreadState, callers: Iterable[Caller]) -> tuple[Caller, ...]:
    """The callers a restarted process needs: the run owner's and queued senders'. Nobody else's
    profile is persisted (data minimisation)."""
    status = thread.status
    wanted = {q.sender for q in thread.follow_ups}
    if isinstance(status, Running | AwaitingApproval):
        wanted.add(status.owner)
    return tuple(sorted((c for c in callers if c.subject in wanted), key=lambda c: c.subject.value))


# ---------------------------------------------------------------- snapshot <-> JSON


def snapshot_to_json(session: SessionId, snapshot: SessionSnapshot) -> dict[str, object]:
    messages: object = ModelMessagesTypeAdapter.dump_python(list(snapshot.messages), mode="json")
    return {
        "version": _FORMAT_VERSION,
        "session": session.value,
        "thread": thread_to_json(snapshot.thread),
        "callers": [caller_to_json(c) for c in snapshot.callers],
        "introduced": snapshot.introduced.value if snapshot.introduced else None,
        "messages": messages,
    }


def parse_snapshot(raw: object, session: SessionId) -> SessionSnapshot:
    doc = expect_mapping(raw, "$")
    if expect_int(field(doc, "version", "$"), "$.version") not in _READABLE_VERSIONS:
        raise ParseError("$.version", f"unsupported session format (expected {_FORMAT_VERSION})")
    if SessionId.parse(field(doc, "session", "$"), "$.session") != session:
        raise ParseError("$.session", "belongs to a different session")
    try:
        messages = ModelMessagesTypeAdapter.validate_python(field(doc, "messages", "$"))
    except ValidationError as exc:
        raise ParseError("$.messages", f"invalid message history: {exc.error_count()} error(s)") from exc
    callers = expect_sequence(doc.get("callers", []), "$.callers")
    introduced = doc.get("introduced")
    return SessionSnapshot(
        parse_thread(field(doc, "thread", "$")),
        tuple(messages),
        tuple(parse_caller(c, f"$.callers[{i}]") for i, c in enumerate(callers)),
        PrincipalId.parse(introduced, "$.introduced") if introduced is not None else None,
    )


# ---------------------------------------------------------------- stores


class InMemorySessionStore:
    """Keeps snapshots in process memory (tests; single-process development)."""

    def __init__(self) -> None:
        self._snapshots: dict[SessionId, SessionSnapshot] = {}
        self._lock = threading.Lock()

    def load(self, session: SessionId) -> SessionSnapshot | None:
        with self._lock:
            return self._snapshots.get(session)

    def save(self, session: SessionId, snapshot: SessionSnapshot) -> None:
        with self._lock:
            self._snapshots[session] = snapshot


class JsonFileSessionStore:
    """One JSON file per session under ``directory``; writes are atomic (temp file + rename)."""

    def __init__(self, directory: Path) -> None:
        self._directory = directory
        self._lock = threading.Lock()

    def path_for(self, session: SessionId) -> Path:
        # Session ids may contain '/' or ':'; the file name is a digest, the id is stored inside.
        return self._directory / f"{hashlib.sha256(session.value.encode()).hexdigest()[:40]}.json"

    def load(self, session: SessionId) -> SessionSnapshot | None:
        path = self.path_for(session)
        with self._lock:
            if not path.exists():
                return None
            text = path.read_text(encoding="utf-8")
        try:
            raw: object = json.loads(text)
        except json.JSONDecodeError as exc:
            raise ParseError("$", f"session file is not JSON: {exc.msg}") from exc
        return parse_snapshot(raw, session)

    def save(self, session: SessionId, snapshot: SessionSnapshot) -> None:
        text = json.dumps(snapshot_to_json(session, snapshot), separators=(",", ":"))
        with self._lock:
            self._directory.mkdir(parents=True, exist_ok=True)
            handle, tmp = tempfile.mkstemp(dir=self._directory, suffix=".tmp")
            try:
                with os.fdopen(handle, "w", encoding="utf-8") as out:
                    out.write(text)
                os.replace(tmp, self.path_for(session))
            except BaseException:
                Path(tmp).unlink(missing_ok=True)
                raise


def snapshot(
    thread: ThreadState,
    messages: Sequence[ModelMessage],
    callers: Iterable[Caller] = (),
    introduced: PrincipalId | None = None,
) -> SessionSnapshot:
    return SessionSnapshot(thread, tuple(messages), needed_callers(thread, callers), introduced)
