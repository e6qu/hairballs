#!/usr/bin/env bash
# Tutorial 02 with the AWS CLI: add the expense-policy skill to tutorial 01's harness.
# Usage: ./cli.sh up | draft | down   (run from this folder, after ../01-first-agent/cli.sh up)
set -euo pipefail

export AWS_REGION=eu-west-1
BUCKET=fintech-agent-skills
ROLE=helpdesk-harness

harness_id() {
  aws bedrock-agentcore-control list-harnesses \
    --query "harnesses[?harnessName=='helpdesk'].harnessId" --output text
}

up() {
  # Store the skill in S3.
  aws s3api create-bucket --bucket "$BUCKET" \
    --create-bucket-configuration LocationConstraint="$AWS_REGION"
  aws s3 sync expense-policy/ "s3://$BUCKET/expense-policy/"

  # Let the harness read it, then attach it. --skills replaces the whole list.
  aws iam put-role-policy --role-name "$ROLE" --policy-name skills \
    --policy-document file://iam/skills-policy.json
  aws bedrock-agentcore-control update-harness --harness-id "$(harness_id)" \
    --skills "[{\"s3\":{\"uri\":\"s3://$BUCKET/expense-policy/\"}}]"
}

draft() {
  # Upload an edited copy to try it on one call (step 5). The harness is not changed.
  aws s3 sync expense-policy/ "s3://$BUCKET/drafts/expense-policy/"
}

down() {
  aws bedrock-agentcore-control update-harness --harness-id "$(harness_id)" --skills '[]'
  aws iam delete-role-policy --role-name "$ROLE" --policy-name skills
  aws s3 rm "s3://$BUCKET" --recursive
  aws s3api delete-bucket --bucket "$BUCKET"
}

"${1:?usage: $0 up|draft|down}"
