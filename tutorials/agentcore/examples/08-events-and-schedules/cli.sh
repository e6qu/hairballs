#!/usr/bin/env bash
# Tutorial 08: run the helpdesk agent from EventBridge Scheduler and an EventBridge rule, with the AWS CLI.
# Needs jq and zip.
set -euo pipefail

REGION=eu-west-1
ACCOUNT=111122223333
AGENT_ROLE_ARN=arn:aws:iam::111122223333:role/helpdesk-agent # tutorial 04
CODE_BUCKET=fintech-agent-artifacts # CI puts helpdesk_events/agent.zip here (linux/arm64)
AUTH0_CLIENT_ID=REPLACE_WITH_CLIENT_ID
AUTH0_CLIENT_SECRET=${AUTH0_CLIENT_SECRET:?export the agent-scheduler client secret}
FUNCTION=helpdesk-trigger

# 0. The agent: accepts Auth0 tokens, replies "accepted", keeps working
AGENT_ARN=$(aws bedrock-agentcore-control create-agent-runtime --region "$REGION" \
  --agent-runtime-name helpdesk_events \
  --agent-runtime-artifact "{\"codeConfiguration\":{\"code\":{\"s3\":{\"bucket\":\"$CODE_BUCKET\",\"prefix\":\"helpdesk_events/agent.zip\"}},\"runtime\":\"PYTHON_3_12\",\"entryPoint\":[\"agent.py\"]}}" \
  --role-arn "$AGENT_ROLE_ARN" \
  --network-configuration '{"networkMode":"PUBLIC"}' \
  --authorizer-configuration '{"customJWTAuthorizer":{"discoveryUrl":"https://fintech.eu.auth0.com/.well-known/openid-configuration","allowedAudience":["https://agents.fintech.example"]}}' \
  --query agentRuntimeArn --output text)

# 1. The Auth0 client secret, in Secrets Manager
SECRET_ARN=$(aws secretsmanager create-secret --region "$REGION" \
  --name helpdesk/agent-scheduler-client-secret \
  --secret-string "$AUTH0_CLIENT_SECRET" --query ARN --output text)

# 2. The Lambda and its role
aws iam create-role --role-name helpdesk-trigger \
  --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"sts:AssumeRole","Principal":{"Service":"lambda.amazonaws.com"}}]}'
aws iam attach-role-policy --role-name helpdesk-trigger \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
aws iam put-role-policy --role-name helpdesk-trigger --policy-name read-auth0-secret \
  --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"secretsmanager:GetSecretValue\",\"Resource\":\"$SECRET_ARN\"}]}"
sleep 10 # IAM is eventually consistent

(cd python && zip -q ../handler.zip handler.py)
aws lambda create-function --region "$REGION" --function-name "$FUNCTION" \
  --runtime python3.12 --handler handler.handler --timeout 60 \
  --role "arn:aws:iam::$ACCOUNT:role/helpdesk-trigger" \
  --zip-file fileb://handler.zip \
  --environment "Variables={AGENT_ARN=$AGENT_ARN,AUTH0_CLIENT_ID=$AUTH0_CLIENT_ID,AUTH0_SECRET_ID=$SECRET_ARN}"
FUNCTION_ARN="arn:aws:lambda:$REGION:$ACCOUNT:function:$FUNCTION"

# 3. Schedule: weekdays at 06:00 Dublin time
aws iam create-role --role-name helpdesk-scheduler \
  --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"sts:AssumeRole","Principal":{"Service":"scheduler.amazonaws.com"}}]}'
aws iam put-role-policy --role-name helpdesk-scheduler --policy-name invoke-trigger \
  --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"lambda:InvokeFunction\",\"Resource\":\"$FUNCTION_ARN\"}]}"
sleep 10

# The input is shaped like an EventBridge event. The scheduled time is the same on every retry.
INPUT='{"id":"<aws.scheduler.scheduled-time>","source":"scheduler.daily-digest","detail-type":"DailyDigest","detail":{}}'
TARGET=$(jq -n --arg arn "$FUNCTION_ARN" --arg role "arn:aws:iam::$ACCOUNT:role/helpdesk-scheduler" \
  --arg input "$INPUT" '{Arn: $arn, RoleArn: $role, Input: $input}')
aws scheduler create-schedule --region "$REGION" --name helpdesk-daily-digest \
  --schedule-expression "cron(0 6 ? * MON-FRI *)" \
  --schedule-expression-timezone Europe/Dublin \
  --flexible-time-window '{"Mode":"OFF"}' \
  --target "$TARGET"

# 4. Event: a ticket was escalated
RULE_ARN=$(aws events put-rule --region "$REGION" --name helpdesk-ticket-escalated \
  --event-pattern '{"source":["fintech.tickets"],"detail-type":["TicketEscalated"]}' \
  --query RuleArn --output text)
aws events put-targets --region "$REGION" --rule helpdesk-ticket-escalated \
  --targets "Id=trigger,Arn=$FUNCTION_ARN"
aws lambda add-permission --region "$REGION" --function-name "$FUNCTION" \
  --statement-id helpdesk-ticket-escalated --action lambda:InvokeFunction \
  --principal events.amazonaws.com --source-arn "$RULE_ARN"

# 5. Try it: send a test event
aws events put-events --region "$REGION" \
  --entries '[{"Source":"fintech.tickets","DetailType":"TicketEscalated","Detail":"{\"ticketId\":\"TCK-1234\"}"}]'

clean_up() {
  aws scheduler delete-schedule --region "$REGION" --name helpdesk-daily-digest
  aws events remove-targets --region "$REGION" --rule helpdesk-ticket-escalated --ids trigger
  aws events delete-rule --region "$REGION" --name helpdesk-ticket-escalated
  aws lambda delete-function --region "$REGION" --function-name "$FUNCTION"
  aws secretsmanager delete-secret --region "$REGION" --secret-id helpdesk/agent-scheduler-client-secret --force-delete-without-recovery
  aws iam delete-role-policy --role-name helpdesk-scheduler --policy-name invoke-trigger
  aws iam delete-role --role-name helpdesk-scheduler
  aws iam delete-role-policy --role-name helpdesk-trigger --policy-name read-auth0-secret
  aws iam detach-role-policy --role-name helpdesk-trigger --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
  aws iam delete-role --role-name helpdesk-trigger
  aws bedrock-agentcore-control delete-agent-runtime --region "$REGION" --agent-runtime-id "${AGENT_ARN##*/}"
}
# When you are done: clean_up
