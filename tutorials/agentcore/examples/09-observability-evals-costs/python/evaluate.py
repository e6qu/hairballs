"""Score one helpdesk session with built-in evaluators (the imperative shell).

Usage: uv run python evaluate.py <session-id>
"""

from __future__ import annotations

import sys

import boto3
from bedrock_agentcore.evaluation import EvaluationClient

from core import render_evaluation
from domain import (
    EvaluatorId,
    HarnessId,
    ParseError,
    RuntimeId,
    SessionId,
    parse_evaluation,
    parse_runtime_id,
)

HARNESS_ID = "helpdesk-AbCdEf1234"
EVALUATORS = ["Builtin.GoalSuccessRate", "Builtin.Helpfulness"]


def runtime_of(harness: HarnessId) -> RuntimeId:
    """A harness runs on a Runtime agent; its traces are stored under that runtime's id."""
    control = boto3.client("bedrock-agentcore-control", region_name="eu-west-1")
    return parse_runtime_id(control.get_harness(harnessId=harness.value))


def main(argv: list[str]) -> int:
    try:
        session = SessionId.parse(argv[1] if len(argv) > 1 else "")
        harness = HarnessId.parse(HARNESS_ID)
        evaluators = [EvaluatorId.parse(e) for e in EVALUATORS]
    except ParseError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    results = EvaluationClient(region_name="eu-west-1").run(
        evaluator_ids=[e.value for e in evaluators],
        session_id=session.value,
        # Spans come from aws/spans and /aws/bedrock-agentcore/runtimes/<id>-DEFAULT.
        agent_id=runtime_of(harness).value,
    )
    for raw in results:
        print(render_evaluation(parse_evaluation(raw)))  # outside data -> domain type
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
