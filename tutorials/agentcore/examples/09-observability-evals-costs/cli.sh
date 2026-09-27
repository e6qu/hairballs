#!/usr/bin/env bash
# Tutorial 09: logs, limits, cost per agent and online evaluation for the helpdesk harness, with the AWS CLI.
set -euo pipefail

REGION=eu-west-1
ACCOUNT=111122223333
HARNESS_ID=helpdesk-AbCdEf1234 # from tutorial 01 (agentcore status)
MODEL=global.anthropic.claude-haiku-4-5-20251001-v1:0
EMAIL=it-support@fintech.example

# The harness runs on a Runtime agent. Its logs and traces are under that runtime.
RUNTIME_ID=$(aws bedrock-agentcore-control get-harness --region "$REGION" --harness-id "$HARNESS_ID" \
  --query harness.environment.agentCoreRuntimeEnvironment.agentRuntimeId --output text)
RUNTIME_NAME=$(aws bedrock-agentcore-control get-harness --region "$REGION" --harness-id "$HARNESS_ID" \
  --query harness.environment.agentCoreRuntimeEnvironment.agentRuntimeName --output text)

# 1. Logs: follow the agent's log group
follow_logs() {
  aws logs tail "/aws/bedrock-agentcore/runtimes/$RUNTIME_ID-DEFAULT" --region "$REGION" --since 1h --follow
}

# 2. Limits per invocation, and a shorter idle timeout
aws bedrock-agentcore-control update-harness --region "$REGION" --harness-id "$HARNESS_ID" \
  --max-iterations 20 --max-tokens 100000 --timeout-seconds 600 \
  --environment '{"agentCoreRuntimeEnvironment":{"lifecycleConfiguration":{"idleRuntimeSessionTimeout":300,"maxLifetime":3600}}}'

# 3. Cost per agent: an application inference profile with the agent's tags
PROFILE_ARN=$(aws bedrock create-inference-profile --region "$REGION" \
  --inference-profile-name helpdesk-haiku \
  --description "Every model call of the helpdesk agent" \
  --model-source "copyFrom=arn:aws:bedrock:$REGION:$ACCOUNT:inference-profile/$MODEL" \
  --tags key=agent,value=helpdesk key=team,value=it-support key=cost-centre,value=cc-1234 \
  --query inferenceProfileArn --output text)
aws bedrock-agentcore-control update-harness --region "$REGION" --harness-id "$HARNESS_ID" \
  --model "{\"bedrockModelConfig\":{\"modelId\":\"$PROFILE_ARN\"}}"
# The execution role also needs bedrock:InvokeModel* on "$PROFILE_ARN" (see terraform/main.tf).

aws ce update-cost-allocation-tags-status \
  --cost-allocation-tags-status TagKey=agent,Status=Active
# shellcheck disable=SC2016 # "$helpdesk" is literal: Budgets writes tag filters as user:<key>$<value>
aws budgets create-budget --account-id "$ACCOUNT" \
  --budget '{"BudgetName":"agent-helpdesk","BudgetType":"COST","TimeUnit":"MONTHLY","BudgetLimit":{"Amount":"50","Unit":"USD"},"CostFilters":{"TagKeyValue":["user:agent$helpdesk"]}}' \
  --notifications-with-subscribers "[{\"Notification\":{\"NotificationType\":\"FORECASTED\",\"ComparisonOperator\":\"GREATER_THAN\",\"Threshold\":80,\"ThresholdType\":\"PERCENTAGE\"},\"Subscribers\":[{\"SubscriptionType\":\"EMAIL\",\"Address\":\"$EMAIL\"}]}]"

# 4. Online evaluation: score 5% of sessions continuously
aws iam create-role --role-name helpdesk-evaluations \
  --assume-role-policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"sts:AssumeRole\",\"Principal\":{\"Service\":\"bedrock-agentcore.amazonaws.com\"},\"Condition\":{\"StringEquals\":{\"aws:SourceAccount\":\"$ACCOUNT\"},\"ArnLike\":{\"aws:SourceArn\":\"arn:aws:bedrock-agentcore:$REGION:$ACCOUNT:online-evaluation-config/*\"}}}]}"
aws iam put-role-policy --role-name helpdesk-evaluations --policy-name read-traces-write-results \
  --policy-document file://"$(dirname "$0")"/evaluations-policy.json
sleep 10 # IAM is eventually consistent

aws bedrock-agentcore-control create-online-evaluation-config --region "$REGION" \
  --online-evaluation-config-name helpdesk_online \
  --rule '{"samplingConfig":{"samplingPercentage":5}}' \
  --data-source-config "{\"cloudWatchLogs\":{\"logGroupNames\":[\"/aws/bedrock-agentcore/runtimes/$RUNTIME_ID-DEFAULT\"],\"serviceNames\":[\"$RUNTIME_NAME.DEFAULT\"]}}" \
  --evaluators '[{"evaluatorId":"Builtin.GoalSuccessRate"},{"evaluatorId":"Builtin.Helpfulness"}]' \
  --evaluation-execution-role-arn "arn:aws:iam::$ACCOUNT:role/helpdesk-evaluations" \
  --enable-on-create

clean_up() {
  local config_id
  config_id=$(aws bedrock-agentcore-control list-online-evaluation-configs --region "$REGION" \
    --query "onlineEvaluationConfigs[?onlineEvaluationConfigName=='helpdesk_online'].onlineEvaluationConfigId" --output text)
  aws bedrock-agentcore-control delete-online-evaluation-config --region "$REGION" --online-evaluation-config-id "$config_id"
  aws iam delete-role-policy --role-name helpdesk-evaluations --policy-name read-traces-write-results
  aws iam delete-role --role-name helpdesk-evaluations
  aws budgets delete-budget --account-id "$ACCOUNT" --budget-name agent-helpdesk
  aws bedrock-agentcore-control update-harness --region "$REGION" --harness-id "$HARNESS_ID" \
    --model "{\"bedrockModelConfig\":{\"modelId\":\"$MODEL\"}}"
  aws bedrock delete-inference-profile --region "$REGION" --inference-profile-identifier helpdesk-haiku
}
# Follow the logs: follow_logs.  When you are done: clean_up
