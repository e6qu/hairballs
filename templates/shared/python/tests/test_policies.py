from org_agents.core.idempotency import idempotency_key
from org_agents.core.messages import (
    ApprovalResponse,
    AwaitingApproval,
    BusyPolicy,
    CancelRequest,
    CancelRun,
    ChatMessage,
    DeliverApproval,
    Idle,
    IgnoreDuplicate,
    QueueFollowUp,
    Reject,
    Running,
    StartRun,
    Steer,
    on_message,
)
from org_agents.core.redaction import Finding, redact
from org_agents.core.tool_policy import Allowed, Denied, NeedsApproval, decide_tool
from org_agents.domain import (
    ApprovalDecision,
    ApprovalId,
    Fingerprint,
    MessageId,
    PrincipalId,
    Prompt,
    SessionId,
    ToolName,
    ToolPattern,
    ToolPolicy,
)

ALICE, BOB = PrincipalId("alice"), PrincipalId("bob")
P = Prompt("hello")


def chat(mid: str, who: PrincipalId = ALICE) -> ChatMessage:
    return ChatMessage(MessageId(mid), who, P)


def test_message_policy() -> None:
    seen: set[MessageId] = {MessageId("m0")}
    assert on_message(Idle(), chat("m0"), seen, BusyPolicy.STEER) == IgnoreDuplicate()
    assert on_message(Idle(), chat("m1"), seen, BusyPolicy.STEER) == StartRun(P)
    assert on_message(Running(ALICE), chat("m1"), seen, BusyPolicy.STEER) == Steer(P)
    assert on_message(Running(ALICE), chat("m1"), seen, BusyPolicy.QUEUE) == QueueFollowUp(P)
    assert on_message(Running(ALICE), chat("m1", BOB), seen, BusyPolicy.STEER) == QueueFollowUp(P)
    assert (
        on_message(Running(ALICE), CancelRequest(MessageId("c"), ALICE), seen, BusyPolicy.STEER)
        == CancelRun()
    )
    assert isinstance(
        on_message(Running(ALICE), CancelRequest(MessageId("c"), BOB), seen, BusyPolicy.STEER), Reject
    )


def test_approval_only_from_approver() -> None:
    aid = ApprovalId("ap-1")
    status = AwaitingApproval(ALICE, aid, frozenset({BOB}))
    ok = ApprovalResponse(MessageId("a1"), BOB, aid, ApprovalDecision.APPROVE)
    assert on_message(status, ok, set(), BusyPolicy.STEER) == DeliverApproval(
        aid, ApprovalDecision.APPROVE, BOB
    )
    self_approve = ApprovalResponse(MessageId("a2"), ALICE, aid, ApprovalDecision.APPROVE)
    assert isinstance(on_message(status, self_approve, set(), BusyPolicy.STEER), Reject)


def test_tool_policy() -> None:
    policy = ToolPolicy((ToolPattern("calculate"), ToolPattern("create_*")), (ToolPattern("create_*"),))
    assert decide_tool(ToolName("calculate"), policy) == Allowed()
    assert isinstance(decide_tool(ToolName("create_ticket"), policy), NeedsApproval)
    assert isinstance(decide_tool(ToolName("delete_all"), policy), Denied)


def test_redaction() -> None:
    text = "card 4111 1111 1111 1111, iban GB82 WEST 1234 5698 7654 32, mail a.b@example.com, key AKIAABCDEFGHIJKLMNOP, id 1234567890123"
    result = redact(text)
    assert "4111" not in result.text and "GB82" not in result.text
    assert result.findings[Finding.CARD_NUMBER] == 1
    assert result.findings[Finding.IBAN] == 1
    assert result.findings[Finding.EMAIL] == 1
    assert result.findings[Finding.AWS_ACCESS_KEY] == 1
    assert "1234567890123" in result.text  # fails Luhn → not a card number


def test_idempotency_key_is_stable() -> None:
    fp = Fingerprint("b" * 64)
    k1 = idempotency_key(SessionId("s1"), ToolName("create_ticket"), fp)
    assert k1 == idempotency_key(SessionId("s1"), ToolName("create_ticket"), fp)
    assert k1 != idempotency_key(SessionId("s2"), ToolName("create_ticket"), fp)
