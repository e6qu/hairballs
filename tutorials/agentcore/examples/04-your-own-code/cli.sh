#!/usr/bin/env bash
# The helpdesk code agent with the plain AWS CLI: package, upload, create the runtime, invoke it.
# Usage: ./cli.sh [python|typescript]   then   ./cli.sh cleanup
set -euo pipefail

REGION=eu-west-1
ACCOUNT_ID=111122223333
BUCKET=fintech-agent-code
KEY=helpdesk/agent.zip
ROLE_NAME=helpdesk-code-agent
AGENT_NAME=helpdesk_code
LANGUAGE=${1:-python}
export AWS_REGION=$REGION
cd "$(dirname "$0")"

if [ "$LANGUAGE" = cleanup ]; then
  AGENT_ID=$(aws bedrock-agentcore-control list-agent-runtimes \
    --query "agentRuntimes[?agentRuntimeName=='$AGENT_NAME'].agentRuntimeId | [0]" --output text)
  aws bedrock-agentcore-control delete-agent-runtime --agent-runtime-id "$AGENT_ID"
  aws iam delete-role-policy --role-name "$ROLE_NAME" --policy-name helpdesk
  aws iam delete-role --role-name "$ROLE_NAME"
  aws iam delete-policy --policy-arn "arn:aws:iam::$ACCOUNT_ID:policy/helpdesk-code-invoke"
  aws s3 rm "s3://$BUCKET/$KEY"
  exit 0
fi

# 1. Package the agent as a zip for ARM64 Linux.
rm -rf build agent.zip && mkdir build
if [ "$LANGUAGE" = python ]; then
  uv pip install --target build --python-platform aarch64-manylinux2014 --python-version 3.13 \
    --only-binary=:all: -r python/pyproject.toml
  cp python/main.py build/
  RUNTIME=PYTHON_3_13
  ENTRY_POINT='["main.py"]'
else
  (cd typescript && npm install && npx tsc)
  cp -r typescript/dist typescript/package.json build/
  (cd build && npm install --omit=dev --ignore-scripts)
  RUNTIME=NODE_22
  ENTRY_POINT='["dist/main.js"]'
fi
(cd build && zip -qr ../agent.zip .)
aws s3 cp agent.zip "s3://$BUCKET/$KEY"

# 2. The execution role: what the agent may do in AWS.
TRUST_POLICY=$(cat <<EOF
{"Version": "2012-10-17", "Statement": [{"Effect": "Allow", "Action": "sts:AssumeRole",
  "Principal": {"Service": "bedrock-agentcore.amazonaws.com"},
  "Condition": {"StringEquals": {"aws:SourceAccount": "$ACCOUNT_ID"}}}]}
EOF
)
ROLE_POLICY=$(cat <<EOF
{"Version": "2012-10-17", "Statement": [
  {"Effect": "Allow", "Action": ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
   "Resource": ["arn:aws:bedrock:*::foundation-model/*", "arn:aws:bedrock:*:$ACCOUNT_ID:inference-profile/*"]},
  {"Effect": "Allow", "Action": ["logs:CreateLogGroup", "logs:DescribeLogStreams", "logs:CreateLogStream", "logs:PutLogEvents"],
   "Resource": "arn:aws:logs:$REGION:$ACCOUNT_ID:log-group:/aws/bedrock-agentcore/runtimes/*"},
  {"Effect": "Allow", "Action": "logs:DescribeLogGroups", "Resource": "*"}]}
EOF
)
aws iam create-role --role-name "$ROLE_NAME" --assume-role-policy-document "$TRUST_POLICY"
aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name helpdesk --policy-document "$ROLE_POLICY"
sleep 10 # let IAM propagate

# 3. The runtime: points at the zip in S3.
ARTIFACT=$(cat <<EOF
{"codeConfiguration": {"code": {"s3": {"bucket": "$BUCKET", "prefix": "$KEY"}},
  "runtime": "$RUNTIME", "entryPoint": $ENTRY_POINT}}
EOF
)
AGENT_ARN=$(aws bedrock-agentcore-control create-agent-runtime \
  --agent-runtime-name "$AGENT_NAME" \
  --role-arn "arn:aws:iam::$ACCOUNT_ID:role/$ROLE_NAME" \
  --agent-runtime-artifact "$ARTIFACT" \
  --network-configuration '{"networkMode": "PUBLIC"}' \
  --query agentRuntimeArn --output text)
until [ "$(aws bedrock-agentcore-control get-agent-runtime --agent-runtime-id "${AGENT_ARN##*/}" \
  --query status --output text)" = READY ]; do sleep 5; done
echo "AGENT_ARN=$AGENT_ARN"

# Callers (people, services) need permission to invoke it: attach this policy to their role.
INVOKE_POLICY=$(cat <<EOF
{"Version": "2012-10-17", "Statement": [{"Effect": "Allow",
  "Action": ["bedrock-agentcore:InvokeAgentRuntime", "bedrock-agentcore:StopRuntimeSession"],
  "Resource": ["$AGENT_ARN", "$AGENT_ARN/runtime-endpoint/*"]}]}
EOF
)
aws iam create-policy --policy-name helpdesk-code-invoke --policy-document "$INVOKE_POLICY"

# 4. Invoke it. The answer streams into answer.txt as server-sent events.
SESSION_ID=$(uuidgen)
echo '{"prompt": "How much can I claim for meals on a 4-day trip to Paris?"}' > prompt.json
aws bedrock-agentcore invoke-agent-runtime \
  --agent-runtime-arn "$AGENT_ARN" \
  --runtime-session-id "$SESSION_ID" \
  --content-type application/json \
  --accept text/event-stream \
  --payload fileb://prompt.json \
  answer.txt
cat answer.txt
