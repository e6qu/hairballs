"""Backends (shell): local, offline implementations. Swap for AWS-backed ones via configuration."""

from __future__ import annotations

import sqlite3
import threading
from importlib import resources
from pathlib import Path
from typing import Protocol

from generic_tools.domain import (
    Document,
    DocumentId,
    Ticket,
    TicketDescription,
    TicketId,
    TicketPriority,
    TicketTitle,
)

# ---------------------------------------------------------------- knowledge


class KnowledgeSource(Protocol):
    def documents(self) -> list[Document]: ...


class LocalCorpus:
    """Markdown files; the first ``# Heading`` is the title. Defaults to the bundled sample corpus."""

    def __init__(self, directory: Path | None = None) -> None:
        self._directory = directory

    def documents(self) -> list[Document]:
        if self._directory is not None:
            files = sorted(self._directory.glob("*.md"))
            return [self._parse(f.stem, f.read_text(encoding="utf-8")) for f in files]
        bundled = resources.files("generic_tools").joinpath("data/corpus")
        return [
            self._parse(entry.name.removesuffix(".md"), entry.read_text(encoding="utf-8"))
            for entry in sorted(bundled.iterdir(), key=lambda e: e.name)
            if entry.name.endswith(".md")
        ]

    @staticmethod
    def _parse(stem: str, text: str) -> Document:
        lines = text.strip().splitlines()
        title = lines[0].lstrip("# ").strip() if lines and lines[0].startswith("#") else stem
        body = "\n".join(lines[1:]) if lines and lines[0].startswith("#") else text
        return Document(DocumentId(stem), title, body.strip())


# ---------------------------------------------------------------- tickets


class TicketStore(Protocol):
    def by_key(self, key: str) -> Ticket | None: ...
    def get(self, ticket_id: TicketId) -> Ticket | None: ...
    def next_number(self) -> int: ...
    def save(self, ticket: Ticket, key: str) -> None: ...


class SqliteTicketStore:
    """SQLite ticket store (``:memory:`` for tests and local runs). Unique on idempotency key."""

    def __init__(self, path: str = ":memory:") -> None:
        self._db = sqlite3.connect(path, check_same_thread=False)
        self._lock = threading.Lock()
        with self._lock:
            self._db.execute(
                "CREATE TABLE IF NOT EXISTS tickets (id TEXT PRIMARY KEY, idem_key TEXT UNIQUE NOT NULL,"
                " title TEXT NOT NULL, description TEXT NOT NULL, priority TEXT NOT NULL,"
                " requested_by TEXT NOT NULL)"
            )

    def _row_to_ticket(self, row: tuple[str, str, str, str, str]) -> Ticket:
        # Rows come from our own writes, but they are still parsed back into domain types.
        return Ticket(
            id=TicketId(row[0]),
            title=TicketTitle(row[1]),
            description=TicketDescription(row[2]),
            priority=TicketPriority(row[3]),
            requested_by=row[4],
        )

    def by_key(self, key: str) -> Ticket | None:
        with self._lock:
            row = self._db.execute(
                "SELECT id, title, description, priority, requested_by FROM tickets WHERE idem_key = ?",
                (key,),
            ).fetchone()
        return self._row_to_ticket(row) if row else None

    def get(self, ticket_id: TicketId) -> Ticket | None:
        with self._lock:
            row = self._db.execute(
                "SELECT id, title, description, priority, requested_by FROM tickets WHERE id = ?",
                (ticket_id.value,),
            ).fetchone()
        return self._row_to_ticket(row) if row else None

    def next_number(self) -> int:
        with self._lock:
            (count,) = self._db.execute("SELECT COUNT(*) FROM tickets").fetchone()
        return int(count) + 1

    def save(self, ticket: Ticket, key: str) -> None:
        with self._lock, self._db:
            self._db.execute(
                "INSERT INTO tickets VALUES (?, ?, ?, ?, ?, ?)",
                (
                    ticket.id.value,
                    key,
                    ticket.title.text,
                    ticket.description.text,
                    ticket.priority.value,
                    ticket.requested_by,
                ),
            )
