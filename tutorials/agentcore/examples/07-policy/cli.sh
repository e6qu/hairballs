#!/usr/bin/env bash
# Tutorial 07: Cedar policies on the helpdesk Gateway, with the AWS CLI. Needs jq.
set -euo pipefail

REGION=eu-west-1
GATEWAY_ID=helpdesk-tools-abc123xyz # from tutorial 03 (agentcore status)
POLICY_DIR="$(dirname "$0")/policies"
POLICIES=(tickets_for_users no_m2m_create_ticket treasury_transfer)

GATEWAY=$(aws bedrock-agentcore-control get-gateway --region "$REGION" --gateway-identifier "$GATEWAY_ID")
GATEWAY_ARN=$(jq -r .gatewayArn <<<"$GATEWAY")

create_engine_and_policies() {
  ENGINE_ID=$(aws bedrock-agentcore-control create-policy-engine --region "$REGION" \
    --name helpdesk_policies --description "Who may call which helpdesk tool" \
    --query policyEngineId --output text)
  until [ "$(aws bedrock-agentcore-control get-policy-engine --region "$REGION" --policy-engine-id "$ENGINE_ID" --query status --output text)" = ACTIVE ]; do sleep 5; done

  for name in "${POLICIES[@]}"; do
    statement=$(sed "s|\${gateway_arn}|$GATEWAY_ARN|" "$POLICY_DIR/$name.cedar")
    aws bedrock-agentcore-control create-policy --region "$REGION" \
      --policy-engine-id "$ENGINE_ID" --name "$name" \
      --validation-mode FAIL_ON_ANY_FINDINGS \
      --definition "$(jq -n --arg s "$statement" '{cedar: {statement: $s}}')"
  done
}

# UpdateGateway replaces the whole configuration: pass every setting the gateway already has.
attach_engine() { # attach_engine LOG_ONLY|ENFORCE
  local engine_arn
  engine_arn=$(aws bedrock-agentcore-control get-policy-engine --region "$REGION" --policy-engine-id "$ENGINE_ID" --query policyEngineArn --output text)
  aws bedrock-agentcore-control update-gateway --region "$REGION" \
    --gateway-identifier "$GATEWAY_ID" \
    --name "$(jq -r .name <<<"$GATEWAY")" \
    --role-arn "$(jq -r .roleArn <<<"$GATEWAY")" \
    --protocol-type MCP \
    --authorizer-type CUSTOM_JWT \
    --authorizer-configuration "$(jq -c .authorizerConfiguration <<<"$GATEWAY")" \
    --policy-engine-configuration "{\"arn\":\"$engine_arn\",\"mode\":\"$1\"}"
}

clean_up() {
  # Detach: update the gateway again without --policy-engine-configuration.
  aws bedrock-agentcore-control update-gateway --region "$REGION" \
    --gateway-identifier "$GATEWAY_ID" \
    --name "$(jq -r .name <<<"$GATEWAY")" \
    --role-arn "$(jq -r .roleArn <<<"$GATEWAY")" \
    --protocol-type MCP \
    --authorizer-type CUSTOM_JWT \
    --authorizer-configuration "$(jq -c .authorizerConfiguration <<<"$GATEWAY")"
  for id in $(aws bedrock-agentcore-control list-policies --region "$REGION" --policy-engine-id "$ENGINE_ID" --query 'policies[].policyId' --output text); do
    aws bedrock-agentcore-control delete-policy --region "$REGION" --policy-engine-id "$ENGINE_ID" --policy-id "$id"
  done
  aws bedrock-agentcore-control delete-policy-engine --region "$REGION" --policy-engine-id "$ENGINE_ID"
}

create_engine_and_policies
attach_engine LOG_ONLY
# After a few days of clean logs:  attach_engine ENFORCE
# When you are done:                clean_up
