"""Score one helpdesk session with built-in evaluators (on-demand evaluation)."""

import sys

import boto3
from bedrock_agentcore.evaluation import EvaluationClient

HARNESS_ID = "helpdesk-AbCdEf1234"
EVALUATORS = ["Builtin.GoalSuccessRate", "Builtin.Helpfulness"]


def runtime_id(harness_id: str) -> str:
    """A harness runs on a Runtime agent; its traces are under that runtime's id."""
    control = boto3.client("bedrock-agentcore-control", region_name="eu-west-1")
    harness = control.get_harness(harnessId=harness_id)["harness"]
    return harness["environment"]["agentCoreRuntimeEnvironment"]["agentRuntimeId"]


if __name__ == "__main__":
    evaluations = EvaluationClient(region_name="eu-west-1")
    results = evaluations.run(
        evaluator_ids=EVALUATORS,
        session_id=sys.argv[1],
        # Spans come from aws/spans and /aws/bedrock-agentcore/runtimes/<id>-DEFAULT.
        agent_id=runtime_id(HARNESS_ID),
    )
    for result in results:
        print(result["evaluatorId"], result.get("value"), result.get("label"))
        print("  ", result.get("explanation", "")[:200])
