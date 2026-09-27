#!/usr/bin/env bash
# Tutorial 01 with the AWS CLI: the helpdesk harness without the agentcore CLI.
# Usage: ./cli.sh up | ./cli.sh down   (run from this folder; needs AWS CLI v2 and jq)
set -euo pipefail

export AWS_REGION=eu-west-1
ACCOUNT=111122223333
ROLE=helpdesk-harness
MODEL=global.anthropic.claude-haiku-4-5-20251001-v1:0

harness_id() {
  aws bedrock-agentcore-control list-harnesses \
    --query "harnesses[?harnessName=='helpdesk'].harnessId" --output text
}

up() {
  # The execution role: what the agent may do in AWS.
  aws iam create-role --role-name "$ROLE" \
    --assume-role-policy-document file://iam/trust-policy.json
  aws iam put-role-policy --role-name "$ROLE" --policy-name harness \
    --policy-document file://iam/harness-policy.json
  sleep 10 # IAM changes take a few seconds to apply

  # The agent: model, instructions and limits.
  aws bedrock-agentcore-control create-harness \
    --harness-name helpdesk \
    --execution-role-arn "arn:aws:iam::$ACCOUNT:role/$ROLE" \
    --model "{\"bedrockModelConfig\":{\"modelId\":\"$MODEL\"}}" \
    --system-prompt "$(jq -n --rawfile t harness/system-prompt.md '[{text: $t}]')" \
    --memory '{"disabled":{}}' \
    --max-iterations 20 --timeout-seconds 300

  local id
  id=$(harness_id)
  until [ "$(aws bedrock-agentcore-control get-harness --harness-id "$id" \
    --query harness.status --output text)" = READY ]; do sleep 5; done
  aws bedrock-agentcore-control get-harness --harness-id "$id" --query harness.arn --output text
}

down() {
  aws bedrock-agentcore-control delete-harness --harness-id "$(harness_id)"
  aws iam delete-role-policy --role-name "$ROLE" --policy-name harness
  aws iam delete-role --role-name "$ROLE"
}

"${1:?usage: $0 up|down}"
