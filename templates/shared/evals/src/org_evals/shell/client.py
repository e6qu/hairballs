"""HTTP client for the AgentCore ``/invocations`` contract (shell).

Locally the agent decodes the bearer token without verifying it (AgentCore Runtime verifies it in
AWS), so the runner signs nothing: it sends an unsigned token carrying the actor's claims. This only
works against local processes, which is the point: evals never run as a real user.
"""

from __future__ import annotations

import base64
import json
import time
import urllib.error
import urllib.request

from org_agents.identity import ClaimNames

from org_evals.domain import Actor, ObservedReply

SESSION_HEADER = "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id"
_UNSIGNED_HEADER = json.dumps({"alg": "none"}).encode()


def unsigned_token(actor: Actor, claims: ClaimNames) -> str:
    payload: dict[str, object] = {"sub": actor.subject.value, claims.email: actor.email.value}
    if actor.given_name is not None:
        payload[claims.given_name] = actor.given_name.value
    if actor.family_name is not None:
        payload[claims.family_name] = actor.family_name.value
    return f"{_b64(_UNSIGNED_HEADER)}.{_b64(json.dumps(payload).encode())}.eval"


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


class TransportError(RuntimeError):
    pass


class AgentClient:
    def __init__(self, base_url: str, claims: ClaimNames, timeout_seconds: int) -> None:
        self._url = base_url.rstrip("/") + "/invocations"
        self._claims = claims
        self._timeout = timeout_seconds

    def send(self, session: str, actor: Actor, payload: dict[str, object]) -> ObservedReply:
        request = urllib.request.Request(
            self._url,
            data=json.dumps(payload).encode(),
            method="POST",
            headers={
                "Content-Type": "application/json",
                SESSION_HEADER: session,
                "Authorization": f"Bearer {unsigned_token(actor, self._claims)}",
            },
        )
        started = time.monotonic()
        try:
            with urllib.request.urlopen(request, timeout=self._timeout) as response:
                body: object = json.loads(response.read())
        except urllib.error.HTTPError as exc:
            raise TransportError(f"HTTP {exc.code}: {exc.read()[:300]!r}") from exc
        except (OSError, json.JSONDecodeError) as exc:
            raise TransportError(f"{type(exc).__name__}: {exc}") from exc
        return ObservedReply.parse(body, int((time.monotonic() - started) * 1000))
