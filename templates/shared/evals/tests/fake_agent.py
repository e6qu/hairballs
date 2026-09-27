"""A stand-in agent for runner tests: serves the AgentCore contract and writes org audit lines.

Behaviour is keyed on the prompt: "ticket" asks for approval (four-eyes), "0.1 + 0.2" calls the
calculator, "leak" writes the caller's email into the audit log (a bug the evals must catch).
"""

from __future__ import annotations

import base64
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

OWNERS: dict[str, str] = {}
LOCK = threading.Lock()


def audit(session: str, kind: str, **fields: object) -> None:
    record = {"audit": True, "session": session, "at": "2026-01-01T00:00:00+00:00", "type": kind, **fields}
    sys.stdout.write(json.dumps(record) + "\n")
    sys.stdout.flush()


def usage(session: str) -> None:
    audit(session, "usage", input_tokens=1000, output_tokens=100, cache_read_tokens=0, cache_write_tokens=0)


def claims(header: str) -> dict[str, object]:
    token = header.removeprefix("Bearer ").split(".")[1]
    decoded: dict[str, object] = json.loads(base64.urlsafe_b64decode(token + "=" * (-len(token) % 4)))
    return decoded


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format: str, *args: object) -> None:
        pass

    def _reply(self, body: dict[str, object]) -> None:
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:
        self._reply({"status": "Healthy"})

    def do_POST(self) -> None:
        session = self.headers["X-Amzn-Bedrock-AgentCore-Runtime-Session-Id"]
        caller = claims(self.headers["Authorization"])
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        audit(session, "run_started")
        if "approval" in body:
            with LOCK:
                owner = OWNERS.get(session)
            if caller["sub"] == owner:
                self._reply({"status": "refused", "reason": "the requester cannot approve their own request"})
                return
            if body["approval"]["decision"] == "approve":
                audit(session, "tool_decision", tool="create_ticket", outcome="allowed", reason="")
                usage(session)
                self._reply({"status": "completed", "answers": ["Ticket TCK-000001 created."]})
            else:
                usage(session)
                self._reply({"status": "completed", "answers": ["The ticket was not created."]})
            return
        prompt = body["prompt"]
        if "leak" in prompt:
            audit(session, "tool_decision", tool="search_knowledge", outcome="allowed", reason=str(caller))
        if "ticket" in prompt:
            with LOCK:
                OWNERS[session] = str(caller["sub"])
            audit(
                session, "tool_decision", tool="create_ticket", outcome="needs_approval", reason="four eyes"
            )
            usage(session)
            self._reply(
                {
                    "status": "approval_required",
                    "approval_id": "ap-1",
                    "tool": "create_ticket",
                    "reason": "four eyes",
                }
            )
            return
        if "0.1 + 0.2" in prompt:
            audit(session, "tool_decision", tool="calculate", outcome="allowed", reason="")
            usage(session)
            self._reply({"status": "completed", "answers": ["0.1 + 0.2 = 0.3"]})
            return
        usage(session)
        self._reply(
            {
                "status": "completed",
                "answers": [f"hello {caller.get('https://fintech.example/given_name', '')}"],
            }
        )


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", int(os.environ["FAKE_PORT"])), Handler).serve_forever()
