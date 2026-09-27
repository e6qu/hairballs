"""Local processes under evaluation (shell): an agent variant or a helper service.

The agent's stdout carries the org audit log as JSON lines (the same stream AgentCore Runtime ships
to CloudWatch). The runner collects those lines per session to see which tools were called and what
the model used, without changing the agent.
"""

from __future__ import annotations

import collections
import contextlib
import json
import os
import signal
import socket
import subprocess
import threading
import time
import urllib.request
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import IO


class ProcessError(RuntimeError):
    pass


class ManagedProcess:
    def __init__(
        self,
        name: str,
        command: Sequence[str],
        cwd: Path,
        env: Mapping[str, str],
        port: int,
        ping_path: str | None,
    ) -> None:
        self._name = name
        self._command = list(command)
        self._cwd = cwd
        self._env = dict(env)
        self._port = port
        self._ping_path = ping_path
        self._proc: subprocess.Popen[str] | None = None
        self._lock = threading.Lock()
        self._audit: dict[str, list[tuple[str, object]]] = collections.defaultdict(list)
        self._tail: collections.deque[str] = collections.deque(maxlen=60)
        self._threads: list[threading.Thread] = []

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self._port}"

    def start(self, ready_timeout: float) -> None:
        if _port_open(self._port):
            raise ProcessError(
                f"{self._name}: port {self._port} is already in use (another run still going?)"
            )
        try:
            self._proc = subprocess.Popen(
                self._command,
                cwd=self._cwd,
                env=self._env,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                bufsize=1,
                start_new_session=True,  # so stop() also ends children (uv -> python, node -> opencode)
            )
        except OSError as exc:
            raise ProcessError(f"{self._name}: cannot start {self._command[0]!r}: {exc}") from exc
        assert self._proc.stdout is not None and self._proc.stderr is not None
        for stream, audit in ((self._proc.stdout, True), (self._proc.stderr, False)):
            thread = threading.Thread(target=self._read, args=(stream, audit), daemon=True)
            thread.start()
            self._threads.append(thread)
        self._wait_ready(ready_timeout)

    def _read(self, stream: IO[str], audit: bool) -> None:
        for line in stream:
            line = line.rstrip("\n")
            with self._lock:
                self._tail.append(line)
            if not audit or not line.startswith("{"):
                continue
            try:
                record: object = json.loads(line)
            except json.JSONDecodeError:
                continue
            if (
                isinstance(record, dict)
                and record.get("audit") is True
                and isinstance(record.get("session"), str)
            ):
                with self._lock:
                    self._audit[record["session"]].append((line, record))

    def _wait_ready(self, timeout: float) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self._proc is not None and self._proc.poll() is not None:
                raise ProcessError(f"{self._name} exited with {self._proc.returncode}:\n{self.output_tail()}")
            if self._ready():
                return
            time.sleep(0.25)
        raise ProcessError(f"{self._name} was not ready after {timeout:.0f}s:\n{self.output_tail()}")

    def _ready(self) -> bool:
        if self._ping_path is None:
            return _port_open(self._port)
        try:
            with urllib.request.urlopen(self.base_url + self._ping_path, timeout=2) as response:
                return bool(response.status == 200)
        except OSError:
            return False

    def audit_for(
        self, session: str, settle_seconds: float = 0.3, max_wait: float = 3.0
    ) -> list[tuple[str, object]]:
        """The session's audit records, once the stream has been quiet for ``settle_seconds``."""
        deadline = time.monotonic() + max_wait
        last = -1
        while time.monotonic() < deadline:
            with self._lock:
                count = len(self._audit.get(session, []))
            if count == last:
                break
            last = count
            time.sleep(settle_seconds)
        with self._lock:
            return list(self._audit.get(session, []))

    def output_tail(self) -> str:
        with self._lock:
            return "\n".join(self._tail)

    def stop(self) -> None:
        proc = self._proc
        if proc is None or proc.poll() is not None:
            return
        try:
            os.killpg(proc.pid, signal.SIGTERM)
            proc.wait(timeout=10)
        except (ProcessLookupError, subprocess.TimeoutExpired):
            with contextlib.suppress(ProcessLookupError):
                os.killpg(proc.pid, signal.SIGKILL)
            proc.wait(timeout=5)


def _port_open(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.5)
        return sock.connect_ex(("127.0.0.1", port)) == 0
