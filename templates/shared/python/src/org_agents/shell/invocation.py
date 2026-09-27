"""Parsing AgentCore ``/invocations`` requests into domain messages.

Payload shapes accepted (all fields untyped until parsed here)::

    {"prompt": "...", "message_id": "..."}                       -> ChatMessage
    {"cancel": true, "message_id": "..."}                        -> CancelRequest
    {"approval": {"id": "...", "decision": "approve"}, "message_id": "..."} -> ApprovalResponse

The sender comes from the (already validated) Auth0 JWT forwarded by AgentCore Runtime in the
``Authorization`` header; locally it defaults to ``local-dev``.
"""

from __future__ import annotations

import base64
import json
import uuid
from collections.abc import Mapping

from org_agents.core.messages import ApprovalResponse, CancelRequest, ChatMessage, Incoming
from org_agents.domain import ApprovalDecision, ApprovalId, MessageId, PrincipalId, Prompt
from org_agents.parsing import ParseError, expect_bool, expect_mapping, field

LOCAL_PRINCIPAL = PrincipalId("local-dev")


def principal_from_headers(headers: Mapping[str, str]) -> PrincipalId:
    """Read ``sub`` from the Bearer JWT. AgentCore Runtime has already validated the token;
    we only decode its claims. Without a token (local development) the principal is ``local-dev``."""
    auth = next((v for k, v in headers.items() if k.lower() == "authorization"), None)
    if auth is None or not auth.lower().startswith("bearer "):
        return LOCAL_PRINCIPAL
    parts = auth[7:].strip().split(".")
    if len(parts) != 3:
        raise ParseError("$.headers.authorization", "is not a JWT")
    padded = parts[1] + "=" * (-len(parts[1]) % 4)
    try:
        claims: object = json.loads(base64.urlsafe_b64decode(padded))
    except (ValueError, json.JSONDecodeError) as exc:
        raise ParseError("$.headers.authorization", "has an undecodable payload") from exc
    return PrincipalId.parse(field(expect_mapping(claims, "$.jwt"), "sub", "$.jwt"), "$.jwt.sub")


def parse_incoming(raw: object, sender: PrincipalId) -> Incoming:
    body = expect_mapping(raw, "$")
    message_id = (
        MessageId.parse(body["message_id"], "$.message_id")
        if "message_id" in body
        else MessageId(f"auto-{uuid.uuid4()}")
    )
    if "cancel" in body and expect_bool(body["cancel"], "$.cancel"):
        return CancelRequest(message_id, sender)
    if "approval" in body:
        approval = expect_mapping(body["approval"], "$.approval")
        return ApprovalResponse(
            message_id,
            sender,
            ApprovalId.parse(field(approval, "id", "$.approval"), "$.approval.id"),
            ApprovalDecision.parse(field(approval, "decision", "$.approval"), "$.approval.decision"),
        )
    return ChatMessage(message_id, sender, Prompt.parse(field(body, "prompt", "$"), "$.prompt"))
