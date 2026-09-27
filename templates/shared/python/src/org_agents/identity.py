"""Who is calling: domain types, claim parsing and user resolution (pure).

Two identifiers, two jobs:

* ``PrincipalId`` (the Auth0 ``sub``) is the **authorization** key: thread ownership, four-eyes
  approval, Cedar policies at the Gateway. It never changes for a login.
* ``UserId`` is the org's **stable business identifier** for a person (tickets, records). It is
  accepted from a token claim when present (e.g. minted by the Auth0 post-login Action and kept
  in ``app_metadata``), otherwise created once and remembered, so a user can change their
  email address or name without breaking ownership, approvals or history.

Profile data (email, names) is refreshed from every token. Email is required for human users;
first and last names are optional. Machine-to-machine callers (``<client_id>@clients``) have
no profile.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass

from org_agents.domain import PrincipalId
from org_agents.parsing import ParseError, expect_mapping, expect_non_empty_str, expect_str, field

_USER_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
# Deliberately conservative: one @, no spaces/quotes/angle brackets, a dotted domain with a letter TLD.
_EMAIL = re.compile(r"^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@(?=.{1,253}$)([A-Za-z0-9-]+\.)+[A-Za-z]{2,63}$")
DEFAULT_CLAIM_NAMESPACE = "https://fintech.example/"
_NAME_FORBIDDEN = re.compile(r"[\x00-\x1f\x7f<>{}\[\]\\]")


# ---------------------------------------------------------------- value types


@dataclass(frozen=True, slots=True)
class UserId:
    value: str

    def __post_init__(self) -> None:
        if not _USER_ID.match(self.value):
            raise ValueError("invalid user id")

    @classmethod
    def parse(cls, raw: object, path: str) -> UserId:
        text = expect_non_empty_str(raw, path, max_length=128)
        if not _USER_ID.match(text):
            raise ParseError(path, "must be 1-128 of [A-Za-z0-9._:-], starting alphanumeric")
        return cls(text)


@dataclass(frozen=True, slots=True)
class EmailAddress:
    """An email address; the domain part is lower-cased. Compared case-insensitively on the domain."""

    value: str

    def __post_init__(self) -> None:
        if len(self.value) > 254 or not _EMAIL.match(self.value):
            raise ValueError("invalid email address")

    @classmethod
    def parse(cls, raw: object, path: str) -> EmailAddress:
        text = expect_non_empty_str(raw, path, max_length=254)
        local, sep, domain = text.rpartition("@")
        candidate = f"{local}{sep}{domain.lower()}"
        if not sep or len(candidate) > 254 or not _EMAIL.match(candidate):
            raise ParseError(path, "is not a valid email address")
        return cls(candidate)


@dataclass(frozen=True, slots=True)
class PersonName:
    """A given or family name: 1-100 printable characters, no markup or control characters."""

    value: str

    def __post_init__(self) -> None:
        if not 1 <= len(self.value) <= 100 or _NAME_FORBIDDEN.search(self.value):
            raise ValueError("invalid name")

    @classmethod
    def parse(cls, raw: object, path: str) -> PersonName:
        text = " ".join(expect_non_empty_str(raw, path, max_length=100).split())
        if _NAME_FORBIDDEN.search(text):
            raise ParseError(path, "contains characters that are not allowed in a name")
        return cls(text)


# ---------------------------------------------------------------- callers


@dataclass(frozen=True, slots=True)
class HumanUser:
    user_id: UserId
    subject: PrincipalId
    email: EmailAddress
    given_name: PersonName | None
    family_name: PersonName | None

    @property
    def display_name(self) -> str:
        parts = [p.value for p in (self.given_name, self.family_name) if p is not None]
        return " ".join(parts) if parts else self.email.value


@dataclass(frozen=True, slots=True)
class ServiceClient:
    """A machine-to-machine caller (Auth0 client credentials); ``subject`` is ``<client_id>@clients``."""

    subject: PrincipalId

    @property
    def display_name(self) -> str:
        return f"service {self.subject.value}"


Caller = HumanUser | ServiceClient


# ---------------------------------------------------------------- claims


@dataclass(frozen=True, slots=True)
class ClaimNames:
    """Which JWT claims carry the profile. Auth0 access tokens need namespaced custom claims added by
    a post-login Action; ID-token style standard claims (``email``, ``given_name``...) are fallbacks."""

    email: str
    given_name: str
    family_name: str
    user_id: str

    @classmethod
    def namespaced(cls, namespace: str) -> ClaimNames:
        return cls(
            email=f"{namespace}email",
            given_name=f"{namespace}given_name",
            family_name=f"{namespace}family_name",
            user_id=f"{namespace}user_id",
        )

    @classmethod
    def parse(cls, raw: object, path: str = "$.identity") -> ClaimNames:
        fields = expect_mapping(raw, path)
        where = f"{path}.claim_namespace"
        namespace = expect_str(fields.get("claim_namespace", DEFAULT_CLAIM_NAMESPACE), where)
        if namespace and not namespace.startswith(("https://", "http://")):
            raise ParseError(where, "must be a URL (Auth0 requires namespaced custom claims)")
        return cls.namespaced(namespace)


@dataclass(frozen=True, slots=True)
class HumanClaims:
    subject: PrincipalId
    email: EmailAddress
    given_name: PersonName | None
    family_name: PersonName | None
    user_id: UserId | None  # present when the IdP already assigns the org user id


@dataclass(frozen=True, slots=True)
class ServiceClaims:
    subject: PrincipalId


CallerClaims = HumanClaims | ServiceClaims


def _first_present(claims: Mapping[str, object], *names: str) -> tuple[str, object] | None:
    for name in names:
        value = claims.get(name)
        if value is not None and value != "":
            return name, value
    return None


def parse_claims(raw: object, names: ClaimNames) -> CallerClaims:
    """Parse already-validated JWT claims (AgentCore Runtime verified signature/audience)."""
    claims = expect_mapping(raw, "$.jwt")
    subject = PrincipalId.parse(field(claims, "sub", "$.jwt"), "$.jwt.sub")
    if subject.value.endswith("@clients") or claims.get("gty") == "client-credentials":
        return ServiceClaims(subject)

    email_claim = _first_present(claims, names.email, "email")
    if email_claim is None:
        raise ParseError(f"$.jwt.{names.email}", "is required for human users (add it in the Auth0 Action)")
    given = _first_present(claims, names.given_name, "given_name")
    family = _first_present(claims, names.family_name, "family_name")
    user_id = _first_present(claims, names.user_id)
    return HumanClaims(
        subject=subject,
        email=EmailAddress.parse(email_claim[1], f"$.jwt.{email_claim[0]}"),
        given_name=PersonName.parse(given[1], f"$.jwt.{given[0]}") if given else None,
        family_name=PersonName.parse(family[1], f"$.jwt.{family[0]}") if family else None,
        user_id=UserId.parse(user_id[1], f"$.jwt.{user_id[0]}") if user_id else None,
    )


# ---------------------------------------------------------------- resolution


@dataclass(frozen=True, slots=True)
class DirectoryEntry:
    """What the org remembers about a login: its stable user id and last-seen profile."""

    subject: PrincipalId
    user_id: UserId
    email: EmailAddress
    given_name: PersonName | None
    family_name: PersonName | None


def resolve_caller(
    claims: CallerClaims, known: DirectoryEntry | None, minted: UserId
) -> tuple[Caller, DirectoryEntry | None]:
    """Decide the caller and the directory entry to store (``None`` = nothing to write).

    User id precedence: token claim > remembered id > newly ``minted`` id (supplied by the shell,
    which owns randomness). The profile always comes from the latest token, so email and name
    changes are picked up while the user id stays the same.
    """
    match claims:
        case ServiceClaims(subject=subject):
            return ServiceClient(subject), None
        case HumanClaims(subject=subject, email=email, given_name=given, family_name=family, user_id=claimed):
            user_id = claimed or (known.user_id if known else minted)
            entry = DirectoryEntry(subject, user_id, email, given, family)
            user = HumanUser(user_id, subject, email, given, family)
            return user, (None if entry == known else entry)


def first_prompt_preamble(caller: Caller) -> str | None:
    """Context for the model at the start of a thread. Only the first name is shared with the model
    (and never in the system prompt, so the prompt cache stays shared across users)."""
    match caller:
        case HumanUser(given_name=given) if given is not None:
            return f"[Context: you are assisting {given.value}.]"
        case _:
            return None


DEFAULT_CLAIMS = ClaimNames.namespaced(DEFAULT_CLAIM_NAMESPACE)
