#!/usr/bin/env bash
# Tutorial 03 with the AWS CLI: tools for tutorial 01's harness, then the same tools behind a gateway.
# Usage: ./cli.sh direct | gateway | down   (run from this folder; needs AWS CLI v2, jq and zip)
set -euo pipefail

export AWS_REGION=eu-west-1
ACCOUNT=111122223333
HARNESS_ROLE=helpdesk-harness
TICKETS_URL=https://tools.fintech.example/mcp

harness_id() {
  aws bedrock-agentcore-control list-harnesses \
    --query "harnesses[?harnessName=='helpdesk'].harnessId" --output text
}

gateway_id() {
  aws bedrock-agentcore-control list-gateways \
    --query "items[?name=='helpdesk-tools'].gatewayId" --output text
}

# Step 1: attach the tickets MCP server directly. --tools replaces the whole list.
direct() {
  aws bedrock-agentcore-control update-harness --harness-id "$(harness_id)" \
    --tools "[{\"type\":\"remote_mcp\",\"name\":\"tickets\",\"config\":{\"remoteMcp\":{\"url\":\"$TICKETS_URL\"}}}]"
}

gateway() {
  # Step 3: the Lambda tool.
  aws iam create-role --role-name helpdesk-expenses-lambda \
    --assume-role-policy-document file://iam/lambda-trust-policy.json
  aws iam attach-role-policy --role-name helpdesk-expenses-lambda \
    --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
  sleep 10 # IAM changes take a few seconds to apply
  (cd python && zip -q ../expenses_tool.zip domain.py core.py expenses_tool.py)
  aws lambda create-function --function-name helpdesk-expenses \
    --runtime python3.13 --architectures arm64 --handler expenses_tool.handler \
    --zip-file fileb://expenses_tool.zip \
    --role "arn:aws:iam::$ACCOUNT:role/helpdesk-expenses-lambda"

  # Step 4: the gateway, with a service role that may invoke the Lambda.
  aws iam create-role --role-name helpdesk-gateway \
    --assume-role-policy-document file://iam/gateway-trust-policy.json
  aws iam put-role-policy --role-name helpdesk-gateway --policy-name invoke-tools \
    --policy-document file://iam/gateway-policy.json
  sleep 10
  aws bedrock-agentcore-control create-gateway --name helpdesk-tools \
    --role-arn "arn:aws:iam::$ACCOUNT:role/helpdesk-gateway" \
    --protocol-type MCP --authorizer-type AWS_IAM
  local gw
  gw=$(gateway_id)
  until [ "$(aws bedrock-agentcore-control get-gateway --gateway-identifier "$gw" \
    --query status --output text)" = READY ]; do sleep 5; done

  # Step 4: two targets. The gateway lists their tools as <target>___<tool>.
  aws bedrock-agentcore-control create-gateway-target --gateway-identifier "$gw" \
    --name tickets \
    --target-configuration "{\"mcp\":{\"mcpServer\":{\"endpoint\":\"$TICKETS_URL\"}}}"
  aws bedrock-agentcore-control create-gateway-target --gateway-identifier "$gw" \
    --name expenses \
    --target-configuration "$(jq -n \
      --arg arn "arn:aws:lambda:$AWS_REGION:$ACCOUNT:function:helpdesk-expenses" \
      --slurpfile tools tools/expenses-tools.json \
      '{mcp: {lambda: {lambdaArn: $arn, toolSchema: {inlinePayload: $tools[0]}}}}')" \
    --credential-provider-configurations '[{"credentialProviderType":"GATEWAY_IAM_ROLE"}]'

  # Step 5: the harness uses the gateway instead of the direct tool.
  aws iam put-role-policy --role-name "$HARNESS_ROLE" --policy-name gateway \
    --policy-document file://iam/harness-gateway-policy.json
  local gw_arn
  gw_arn=$(aws bedrock-agentcore-control get-gateway --gateway-identifier "$gw" \
    --query gatewayArn --output text)
  aws bedrock-agentcore-control update-harness --harness-id "$(harness_id)" \
    --tools "[{\"type\":\"agentcore_gateway\",\"name\":\"helpdesk-tools\",\"config\":{\"agentCoreGateway\":{\"gatewayArn\":\"$gw_arn\",\"outboundAuth\":{\"awsIam\":{}}}}}]"

  # Step 6: the MCP endpoint your own code calls.
  aws bedrock-agentcore-control get-gateway --gateway-identifier "$gw" \
    --query gatewayUrl --output text
}

down() {
  local gw target
  gw=$(gateway_id)
  aws bedrock-agentcore-control update-harness --harness-id "$(harness_id)" --tools '[]'
  aws iam delete-role-policy --role-name "$HARNESS_ROLE" --policy-name gateway
  for target in $(aws bedrock-agentcore-control list-gateway-targets --gateway-identifier "$gw" \
    --query "items[].targetId" --output text); do
    aws bedrock-agentcore-control delete-gateway-target --gateway-identifier "$gw" --target-id "$target"
  done
  sleep 10
  aws bedrock-agentcore-control delete-gateway --gateway-identifier "$gw"
  aws iam delete-role-policy --role-name helpdesk-gateway --policy-name invoke-tools
  aws iam delete-role --role-name helpdesk-gateway
  aws lambda delete-function --function-name helpdesk-expenses
  aws iam detach-role-policy --role-name helpdesk-expenses-lambda \
    --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
  aws iam delete-role --role-name helpdesk-expenses-lambda
  rm -f expenses_tool.zip
}

"${1:?usage: $0 direct|gateway|down}"
