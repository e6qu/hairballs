"""Domain types for the helpdesk behind Auth0.

Outside data (the Authorization header and its JWT claims, the HTTP payload, the session header,
tool arguments, API and Auth0 responses, the environment, server-sent events) is parsed into these
types at the boundary. After that, a value that exists is valid: no code downstream re-checks it.
"""

from __future__ import annotations

import base64
import binascii
import json
import re
from collections.abc import Mapping
from dataclasses import dataclass

NS = "https://fintech.example/"  # the claim namespace set by the Auth0 post-login Action

_USER_ID = re.compile(r"usr_[0-9a-f]{32}")
_EMAIL = re.compile(r"[^@\s]+@[^@\s]+\.[^@\s]+")
_RUNTIME_ARN = re.compile(
    r"arn:aws[a-z-]*:bedrock-agentcore:[a-z0-9-]+:\d{12}:runtime/[A-Za-z][A-Za-z0-9_]*-[A-Za-z0-9]+"
)


class ParseError(ValueError):
    """Outside data that does not fit the domain."""


def _fields(raw: object, path: str) -> Mapping[str, object]:
    if not isinstance(raw, Mapping):
        raise ParseError(f"{path} must be an object")
    return raw


def _text(raw: object, path: str) -> str:
    if not isinstance(raw, str) or not raw.strip():
        raise ParseError(f"{path} must be a non-empty string")
    return raw.strip()


@dataclass(frozen=True, slots=True)
class Subject:
    """Auth0 `sub`: who signed in. Use it for authorization and audit."""

    value: str


@dataclass(frozen=True, slots=True)
class UserId:
    """Our stable user id, minted once by the Action. Also a valid Memory actor id."""

    value: str

    @classmethod
    def parse(cls, raw: object) -> UserId:
        if not isinstance(raw, str) or not _USER_ID.fullmatch(raw):
            raise ParseError(f"not a user id: {raw!r}")
        return cls(raw)


@dataclass(frozen=True, slots=True)
class EmailAddress:
    value: str

    @classmethod
    def parse(cls, raw: object) -> EmailAddress:
        if not isinstance(raw, str) or not _EMAIL.fullmatch(raw):
            raise ParseError("a person's token must carry an email address")
        return cls(raw)


@dataclass(frozen=True, slots=True)
class HumanUser:
    subject: Subject
    user_id: UserId
    email: EmailAddress
    first_name: str | None


@dataclass(frozen=True, slots=True)
class ServiceClient:
    """An M2M (client credentials) caller: a service, with no profile."""

    subject: Subject


Caller = HumanUser | ServiceClient


def claims_of(authorization: str | None) -> Mapping[str, object]:
    """The claims in a `Bearer <JWT>` header. Runtime has already checked signature, issuer,
    expiry and audience; this only decodes the payload."""
    parts = (authorization or "").removeprefix("Bearer ").split(".")
    if len(parts) != 3:
        raise ParseError("the Authorization header must hold a bearer JWT")
    try:
        claims: object = json.loads(base64.urlsafe_b64decode(parts[1] + "=="))
    except (binascii.Error, ValueError) as exc:
        raise ParseError("the JWT payload is not JSON") from exc
    return _fields(claims, "$jwt")


def parse_caller(claims: Mapping[str, object]) -> Caller:
    subject = Subject(_text(claims.get("sub"), "$jwt.sub"))
    if subject.value.endswith("@clients") or claims.get("gty") == "client-credentials":
        return ServiceClient(subject)
    first_name = claims.get(f"{NS}given_name")
    return HumanUser(
        subject,
        UserId.parse(claims.get(f"{NS}user_id")),
        EmailAddress.parse(claims.get(f"{NS}email")),
        first_name if isinstance(first_name, str) and first_name.strip() else None,
    )


@dataclass(frozen=True, slots=True)
class SessionId:
    """Same id = same session VM and conversation. AgentCore requires 33 to 256 characters."""

    value: str

    @classmethod
    def parse(cls, raw: str | None) -> SessionId:
        if raw is None or not 33 <= len(raw) <= 256:
            raise ParseError("a session id must be 33 to 256 characters (use a UUID)")
        return cls(raw)


@dataclass(frozen=True, slots=True)
class Prompt:
    text: str

    @classmethod
    def parse(cls, raw: object) -> Prompt:
        return cls(_text(raw, "$.prompt"))


def parse_invocation(raw: object) -> Prompt:
    """The /invocations body: {"prompt": "..."}."""
    return Prompt.parse(_fields(raw, "$").get("prompt"))


@dataclass(frozen=True, slots=True)
class TicketRequest:
    title: str
    description: str

    @classmethod
    def parse(cls, title: str, description: str) -> TicketRequest:
        return cls(_text(title, "title"), _text(description, "description"))


@dataclass(frozen=True, slots=True)
class TicketId:
    value: str


def parse_ticket_created(raw: object) -> TicketId:
    """The tickets API's reply: {"id": "..."}."""
    return TicketId(_text(_fields(raw, "$").get("id"), "$.id"))


@dataclass(frozen=True, slots=True)
class AccessToken:
    """A JWT access token: three dot-separated parts."""

    value: str

    @classmethod
    def parse(cls, raw: object) -> AccessToken:
        token = _text(raw, "access token")
        if token.count(".") != 2:
            raise ParseError("an access token must be a JWT")
        return cls(token)


def parse_token_response(raw: object) -> AccessToken:
    """Auth0's /oauth/token reply: {"access_token": "...", ...}."""
    return AccessToken.parse(_fields(raw, "$").get("access_token"))


@dataclass(frozen=True, slots=True)
class AgentRuntimeArn:
    value: str

    @classmethod
    def parse(cls, raw: str) -> AgentRuntimeArn:
        if not _RUNTIME_ARN.fullmatch(raw):
            raise ParseError(f"not an agent runtime ARN: {raw!r}")
        return cls(raw)


@dataclass(frozen=True, slots=True)
class AnswerText:
    text: str


@dataclass(frozen=True, slots=True)
class AgentFailed:
    message: str


AnswerEvent = AnswerText | AgentFailed


def parse_sse_line(line: str) -> AnswerEvent | None:
    """A `data: ...` line of the /invocations stream, or None for other lines."""
    if not line.startswith("data: "):
        return None
    try:
        data: object = json.loads(line.removeprefix("data: "))
    except json.JSONDecodeError as exc:
        raise ParseError(f"not JSON: {line!r}") from exc
    if isinstance(data, str):
        return AnswerText(data)
    if isinstance(data, Mapping) and isinstance(data.get("error"), str):
        return AgentFailed(str(data["error"]))
    raise ParseError(f"unexpected event: {line!r}")
