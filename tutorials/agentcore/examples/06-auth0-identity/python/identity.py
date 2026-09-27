"""Who is calling: the claims of the caller's Auth0 access token."""

import base64
import json
from dataclasses import dataclass

NS = "https://fintech.example/"  # the claim namespace set by the Auth0 post-login Action


@dataclass(frozen=True)
class Caller:
    subject: str  # Auth0 `sub`: who signed in; use it for authorization and audit
    user_id: str | None  # our stable user id; None for services
    first_name: str | None


def claims_of(authorization: str) -> dict[str, object]:
    """Decode the token's payload. Runtime has already checked signature, issuer and audience."""
    payload = authorization.removeprefix("Bearer ").split(".")[1]
    claims: dict[str, object] = json.loads(base64.urlsafe_b64decode(payload + "=="))
    return claims


def caller_of(authorization: str) -> Caller:
    claims = claims_of(authorization)
    subject = str(claims["sub"])
    if subject.endswith("@clients"):  # an M2M (client credentials) token: a service, no profile
        return Caller(subject, None, None)
    first_name = claims.get(f"{NS}given_name")
    return Caller(
        subject,
        str(claims[f"{NS}user_id"]),
        str(first_name) if first_name else None,
    )
