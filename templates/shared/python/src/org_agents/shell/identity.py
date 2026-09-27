"""Caller identity (shell): JWT claims from headers, the user directory, and the resolver.

AgentCore Runtime has already validated the Auth0 JWT (signature, issuer, audience) before the
request reaches the container; here we only decode its claims and parse them into domain types.
"""

from __future__ import annotations

import base64
import json
import sqlite3
import threading
import uuid
from collections.abc import Callable, Mapping
from typing import Protocol

from org_agents.domain import PrincipalId
from org_agents.identity import (
    Caller,
    ClaimNames,
    DirectoryEntry,
    EmailAddress,
    HumanUser,
    PersonName,
    UserId,
    parse_claims,
    resolve_caller,
)
from org_agents.parsing import ParseError

LOCAL_USER = HumanUser(
    user_id=UserId("usr_local_dev"),
    subject=PrincipalId("local-dev"),
    email=EmailAddress("local-dev@example.com"),
    given_name=PersonName("Local"),
    family_name=PersonName("Developer"),
)


def jwt_claims_from_headers(headers: Mapping[str, str]) -> object | None:
    """The decoded (unverified here, verified upstream) JWT payload, or ``None`` without a token."""
    auth = next((v for k, v in headers.items() if k.lower() == "authorization"), None)
    if auth is None or not auth.lower().startswith("bearer "):
        return None
    parts = auth[7:].strip().split(".")
    if len(parts) != 3:
        raise ParseError("$.headers.authorization", "is not a JWT")
    padded = parts[1] + "=" * (-len(parts[1]) % 4)
    try:
        claims: object = json.loads(base64.urlsafe_b64decode(padded))
    except (ValueError, json.JSONDecodeError) as exc:
        raise ParseError("$.headers.authorization", "has an undecodable payload") from exc
    return claims


def new_user_id() -> UserId:
    return UserId(f"usr_{uuid.uuid4().hex}")


class UserDirectory(Protocol):
    def get(self, subject: PrincipalId) -> DirectoryEntry | None: ...
    def put(self, entry: DirectoryEntry) -> None: ...


class InMemoryUserDirectory:
    def __init__(self) -> None:
        self._entries: dict[PrincipalId, DirectoryEntry] = {}
        self._lock = threading.Lock()

    def get(self, subject: PrincipalId) -> DirectoryEntry | None:
        with self._lock:
            return self._entries.get(subject)

    def put(self, entry: DirectoryEntry) -> None:
        with self._lock:
            self._entries[entry.subject] = entry


class SqliteUserDirectory:
    """Local/dev directory. In production use a shared store (e.g. DynamoDB keyed by ``sub``) so the
    same user id is used across sessions and microVMs, or have the Auth0 Action mint the id."""

    def __init__(self, path: str = ":memory:") -> None:
        self._db = sqlite3.connect(path, check_same_thread=False)
        self._lock = threading.Lock()
        with self._lock:
            self._db.execute(
                "CREATE TABLE IF NOT EXISTS users (subject TEXT PRIMARY KEY, user_id TEXT NOT NULL,"
                " email TEXT NOT NULL, given_name TEXT, family_name TEXT)"
            )

    def get(self, subject: PrincipalId) -> DirectoryEntry | None:
        with self._lock:
            row = self._db.execute(
                "SELECT user_id, email, given_name, family_name FROM users WHERE subject = ?",
                (subject.value,),
            ).fetchone()
        if row is None:
            return None
        # Stored values are parsed back into domain types (a corrupted row fails loudly here).
        return DirectoryEntry(
            subject=subject,
            user_id=UserId.parse(row[0], "$.users.user_id"),
            email=EmailAddress.parse(row[1], "$.users.email"),
            given_name=PersonName.parse(row[2], "$.users.given_name") if row[2] else None,
            family_name=PersonName.parse(row[3], "$.users.family_name") if row[3] else None,
        )

    def put(self, entry: DirectoryEntry) -> None:
        with self._lock, self._db:
            self._db.execute(
                "INSERT INTO users VALUES (?, ?, ?, ?, ?) ON CONFLICT(subject) DO UPDATE SET"
                " user_id = excluded.user_id, email = excluded.email,"
                " given_name = excluded.given_name, family_name = excluded.family_name",
                (
                    entry.subject.value,
                    entry.user_id.value,
                    entry.email.value,
                    entry.given_name.value if entry.given_name else None,
                    entry.family_name.value if entry.family_name else None,
                ),
            )


class IdentityResolver:
    def __init__(
        self,
        names: ClaimNames,
        directory: UserDirectory,
        mint: Callable[[], UserId] = new_user_id,
        local_user: Caller | None = LOCAL_USER,
    ) -> None:
        self._names = names
        self._directory = directory
        self._mint = mint
        self._local_user = local_user

    def resolve(self, headers: Mapping[str, str]) -> Caller:
        """Raises ``ParseError`` for malformed claims or a human without an email address.
        Without a token, returns the local development user (set ``local_user=None`` to refuse)."""
        raw = jwt_claims_from_headers(headers)
        if raw is None:
            if self._local_user is None:
                raise ParseError("$.headers.authorization", "a bearer token is required")
            return self._local_user
        claims = parse_claims(raw, self._names)
        known = self._directory.get(claims.subject)
        caller, update = resolve_caller(claims, known, self._mint())
        if update is not None:
            self._directory.put(update)
        return caller
