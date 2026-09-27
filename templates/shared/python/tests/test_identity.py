import base64
import json

import pytest

from org_agents.conversation import ApprovalNeeded, ApprovalPolicy, ApprovalRequested
from org_agents.core.thread import ThreadState, finish
from org_agents.domain import ApprovalId, PrincipalId, ToolName
from org_agents.identity import (
    DEFAULT_CLAIMS,
    DirectoryEntry,
    EmailAddress,
    HumanClaims,
    HumanUser,
    PersonName,
    ServiceClient,
    UserId,
    first_prompt_preamble,
    parse_claims,
    resolve_caller,
)
from org_agents.parsing import ParseError
from org_agents.shell.identity import LOCAL_USER, IdentityResolver, SqliteUserDirectory
from org_agents.shell.replies import render

NS = "https://fintech.example/"


def jwt(claims: dict[str, object]) -> dict[str, str]:
    body = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
    return {"Authorization": f"Bearer eyJhbGciOiJub25lIn0.{body}.sig"}


def test_email_is_required_names_optional() -> None:
    with pytest.raises(ParseError) as err:
        parse_claims({"sub": "auth0|1"}, DEFAULT_CLAIMS)
    assert err.value.path == f"$.jwt.{NS}email"
    claims = parse_claims({"sub": "auth0|1", f"{NS}email": "Jane.Doe@Fintech.EXAMPLE"}, DEFAULT_CLAIMS)
    assert isinstance(claims, HumanClaims)
    assert claims.email == EmailAddress("Jane.Doe@fintech.example")  # domain lower-cased
    assert claims.given_name is None and claims.user_id is None


def test_standard_claims_are_fallbacks_and_names_are_cleaned() -> None:
    claims = parse_claims(
        {"sub": "auth0|1", "email": "j@x.io", "given_name": "  Jane   Ann ", "family_name": "Doe"},
        DEFAULT_CLAIMS,
    )
    assert isinstance(claims, HumanClaims) and claims.given_name == PersonName("Jane Ann")
    with pytest.raises(ParseError):
        parse_claims({"sub": "auth0|1", "email": "j@x.io", "given_name": "<script>"}, DEFAULT_CLAIMS)
    with pytest.raises(ParseError):
        parse_claims({"sub": "auth0|1", "email": "not-an-email"}, DEFAULT_CLAIMS)


def test_service_clients_have_no_profile() -> None:
    claims = parse_claims({"sub": "abc@clients", "gty": "client-credentials"}, DEFAULT_CLAIMS)
    caller, update = resolve_caller(claims, None, UserId("usr_new"))
    assert caller == ServiceClient(PrincipalId("abc@clients")) and update is None


def test_user_id_precedence_claim_then_known_then_minted() -> None:
    base = {"sub": "auth0|1", f"{NS}email": "j@x.io"}
    minted = UserId("usr_minted")
    caller, update = resolve_caller(parse_claims(base, DEFAULT_CLAIMS), None, minted)
    assert isinstance(caller, HumanUser) and caller.user_id == minted and update is not None
    caller2, _ = resolve_caller(parse_claims(base, DEFAULT_CLAIMS), update, UserId("usr_other"))
    assert isinstance(caller2, HumanUser) and caller2.user_id == minted  # remembered
    claimed = {**base, f"{NS}user_id": "emp-42"}
    caller3, _ = resolve_caller(parse_claims(claimed, DEFAULT_CLAIMS), update, UserId("usr_other"))
    assert isinstance(caller3, HumanUser) and caller3.user_id == UserId("emp-42")  # IdP-assigned wins


def test_email_and_name_change_keep_user_id() -> None:
    resolver = IdentityResolver(DEFAULT_CLAIMS, SqliteUserDirectory(), mint=lambda: UserId("usr_1"))
    first = resolver.resolve(jwt({"sub": "auth0|1", f"{NS}email": "old@x.io", f"{NS}given_name": "Jane"}))
    later = resolver.resolve(
        jwt(
            {
                "sub": "auth0|1",
                f"{NS}email": "new@x.io",
                f"{NS}given_name": "Janet",
                f"{NS}family_name": "Roe",
            }
        )
    )
    assert isinstance(first, HumanUser) and isinstance(later, HumanUser)
    assert first.user_id == later.user_id == UserId("usr_1")
    assert later.email.value == "new@x.io" and later.display_name == "Janet Roe"


def test_known_entry_unchanged_means_no_write() -> None:
    entry = DirectoryEntry(PrincipalId("auth0|1"), UserId("usr_1"), EmailAddress("j@x.io"), None, None)
    _, update = resolve_caller(
        parse_claims({"sub": "auth0|1", "email": "j@x.io"}, DEFAULT_CLAIMS), entry, UserId("x1")
    )
    assert update is None


def test_local_dev_and_strict_mode() -> None:
    assert IdentityResolver(DEFAULT_CLAIMS, SqliteUserDirectory()).resolve({}) == LOCAL_USER
    with pytest.raises(ParseError):
        IdentityResolver(DEFAULT_CLAIMS, SqliteUserDirectory(), local_user=None).resolve({})


def test_preamble_uses_first_name_only() -> None:
    assert first_prompt_preamble(LOCAL_USER) == "[Context: you are assisting Local.]"
    assert first_prompt_preamble(ServiceClient(PrincipalId("abc@clients"))) is None


def test_approval_reply_shows_requester_to_approvers() -> None:
    policy = ApprovalPolicy(self_approval=False, approvers=frozenset({PrincipalId("lead")}))
    requester = HumanUser(
        UserId("usr_1"), PrincipalId("auth0|1"), EmailAddress("jane@x.io"), PersonName("Jane"), None
    )
    _, reply = finish(
        ThreadState.initial(),
        ApprovalNeeded(ApprovalId("ap"), ToolName("create_ticket"), "x"),
        requester.subject,
        policy,
        requester,
    )
    assert isinstance(reply, ApprovalRequested)
    assert render(reply)["requester"] == {
        "kind": "user",
        "user_id": "usr_1",
        "name": "Jane",
        "email": "jane@x.io",
    }
