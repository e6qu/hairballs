"""Steering: deliver a mid-run message from the run owner to the running agent (shell).

The org thread state machine returns ``Steer(prompt)`` for a message from the run owner while a
run is busy. The harness maps it to Pydantic AI's native pending-message queue:
``AgentRun.enqueue(text, priority="asap")`` (``pydantic_ai/run.py``, thread-safe, added in the
2.x line and present in the pinned 2.46). ``asap`` messages are prepended to the next model
request, or redirect the run into one more request if it would otherwise end.

If the installed version lacked ``AgentRun.enqueue``, the fallback would be a history processor
that appends the queued text to the last ``ModelRequest`` before each model call (this is what the
Strands variant does with a ``BeforeModelCall`` hook). It is not needed with the pinned version.

Edge cases handled here:

* a steer that arrives after ``handle`` marked the thread running but before ``agent.iter`` has
  started is buffered and enqueued as soon as the run is attached;
* a steer that lands after the run produced its final result (so it was never drained) is carried
  over and delivered at the start of the thread's next run.

Framework behaviour to know: an ``asap`` message delivered while a tool call is waiting for
approval makes the run continue instead of pausing; the unapproved call is closed as
``interrupted`` and never executed, and the model may ask again (which needs approval again).
"""

from __future__ import annotations

import threading
from typing import Any

from pydantic_ai.run import AgentRun

from org_pydantic_harness.shell.deps import HarnessDeps

STEER_PREFIX = "[Message from the user while you were working]"


def steering_text(text: str) -> str:
    return f"{STEER_PREFIX} {text}"


class Steering:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        # AgentRun's output type parameter is irrelevant here (only enqueue/cancel are used).
        self._run: AgentRun[HarnessDeps, Any] | None = None
        self._buffer: list[str] = []
        self._enqueued: dict[str, str] = {}
        self._cancel_pending = False

    def steer(self, text: str) -> None:
        with self._lock:
            if self._run is None:
                self._buffer.append(text)
                return
            self._enqueue_locked(self._run, text)

    def cancel(self) -> None:
        """Cancel the active run. The harness calls this only while its thread is running; a cancel
        that arrives before the run is attached is applied on :meth:`attach`."""
        with self._lock:
            if self._run is None:
                self._cancel_pending = True
            else:
                self._run.cancel()

    def end_run(self) -> None:
        """The thread's run finished: forget a cancel that no run picked up."""
        with self._lock:
            self._cancel_pending = False

    def attach(self, run: AgentRun[HarnessDeps, Any]) -> None:
        with self._lock:
            self._run = run
            for text in self._buffer:
                self._enqueue_locked(run, text)
            self._buffer.clear()
            if self._cancel_pending:
                self._cancel_pending = False
                run.cancel()

    def detach(self, run: AgentRun[HarnessDeps, Any]) -> None:
        with self._lock:
            undelivered = {pending.enqueue_id for pending in run.pending_messages}
            self._buffer.extend(text for eid, text in self._enqueued.items() if eid in undelivered)
            self._enqueued.clear()
            self._run = None

    def _enqueue_locked(self, run: AgentRun[HarnessDeps, Any], text: str) -> None:
        enqueue_id = run.enqueue(steering_text(text), priority="asap")
        if enqueue_id is not None:
            self._enqueued[enqueue_id] = text
