"""Outbound serialization of replies: the only place the /invocations response JSON is defined."""

from __future__ import annotations

from org_agents.conversation import (
    Acknowledged,
    Answer,
    ApprovalRequested,
    Refused,
    Reply,
    RunFailed,
    RunHalted,
)


def render(reply: Reply) -> dict[str, object]:
    """Outbound serialization of replies (the only place the response JSON shape is defined)."""
    match reply:
        case Answer(texts=texts):
            return {"status": "completed", "answers": list(texts)}
        case ApprovalRequested(approval_id=aid, tool=tool, reason=reason, approvers=approvers):
            return {
                "status": "approval_required",
                "approval_id": aid.value,
                "tool": tool.value,
                "reason": reason,
                "approvers": sorted(p.value for p in approvers),
            }
        case RunHalted(stop=stop, text=text):
            return {"status": "stopped", "reason": stop.reason.value, "detail": stop.detail, "answer": text}
        case Acknowledged(ack=ack):
            return {"status": ack.value}
        case RunFailed(error=error):
            return {"status": "failed", "error": error}
        case Refused(reason=reason):
            return {"status": "refused", "reason": reason}
