#!/usr/bin/env bash
# AgentCore Memory with the plain AWS CLI: create it, redeploy the tutorial 04 runtime with this
# tutorial's code, show that a thread survives the session VM, then write, read and fork one by hand.
# Usage: ./cli.sh [python|typescript]   then   ./cli.sh cleanup
set -euo pipefail

REGION=eu-west-1
ACCOUNT_ID=111122223333
ROLE_NAME=helpdesk-code-agent # from tutorial 04
AGENT_NAME=helpdesk_code      # from tutorial 04
BUCKET=fintech-agent-code
KEY=helpdesk/agent.zip
LANGUAGE=${1:-python}
export AWS_REGION=$REGION
cd "$(dirname "$0")"

if [ "$LANGUAGE" = cleanup ]; then
  MEMORY_ID=$(aws bedrock-agentcore-control list-memories \
    --query "memories[?starts_with(id, 'helpdesk_memory')].id | [0]" --output text)
  aws bedrock-agentcore-control delete-memory --memory-id "$MEMORY_ID"
  aws iam delete-role-policy --role-name "$ROLE_NAME" --policy-name helpdesk-memory
  aws iam delete-policy --policy-arn "arn:aws:iam::$ACCOUNT_ID:policy/helpdesk-memory-caller"
  exit 0
fi

# 1. Create the memory. Events (messages) expire after 30 days.
MEMORY_ID=$(aws bedrock-agentcore-control create-memory \
  --name helpdesk_memory \
  --event-expiry-duration 30 \
  --query memory.id --output text)
aws bedrock-agentcore-control wait memory-created --memory-id "$MEMORY_ID"
MEMORY_ARN=$(aws bedrock-agentcore-control get-memory --memory-id "$MEMORY_ID" \
  --query memory.arn --output text)

# 2. Let the agent's role read and write it.
MEMORY_POLICY=$(cat <<EOF
{"Version": "2012-10-17", "Statement": [{"Effect": "Allow",
  "Action": ["bedrock-agentcore:CreateEvent", "bedrock-agentcore:GetEvent",
             "bedrock-agentcore:ListEvents", "bedrock-agentcore:RetrieveMemoryRecords"],
  "Resource": "$MEMORY_ARN"}]}
EOF
)
aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name helpdesk-memory --policy-document "$MEMORY_POLICY"

# Callers that write and read threads themselves (fork.py) need the same on their own role.
CALLER_POLICY=$(cat <<EOF
{"Version": "2012-10-17", "Statement": [{"Effect": "Allow",
  "Action": ["bedrock-agentcore:CreateEvent", "bedrock-agentcore:ListEvents"],
  "Resource": "$MEMORY_ARN"}]}
EOF
)
aws iam create-policy --policy-name helpdesk-memory-caller --policy-document "$CALLER_POLICY"

# 3. Package this tutorial's agent (as in tutorial 04) and point the runtime at it and the memory.
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

AGENT_ID=$(aws bedrock-agentcore-control list-agent-runtimes \
  --query "agentRuntimes[?agentRuntimeName=='$AGENT_NAME'].agentRuntimeId | [0]" --output text)
ARTIFACT=$(cat <<EOF
{"codeConfiguration": {"code": {"s3": {"bucket": "$BUCKET", "prefix": "$KEY"}},
  "runtime": "$RUNTIME", "entryPoint": $ENTRY_POINT}}
EOF
)
AGENT_ARN=$(aws bedrock-agentcore-control update-agent-runtime \
  --agent-runtime-id "$AGENT_ID" \
  --role-arn "arn:aws:iam::$ACCOUNT_ID:role/$ROLE_NAME" \
  --agent-runtime-artifact "$ARTIFACT" \
  --network-configuration '{"networkMode": "PUBLIC"}' \
  --environment-variables "MEMORY_HELPDESK_MEMORY_ID=$MEMORY_ID" \
  --query agentRuntimeArn --output text)
until [ "$(aws bedrock-agentcore-control get-agent-runtime --agent-runtime-id "$AGENT_ID" \
  --query status --output text)" = READY ]; do sleep 5; done

# 4. Two turns in one session, stop its VM, then a third turn: the thread comes back from Memory.
USER_ID=usr_7f3a9c
SESSION_ID=$(uuidgen)
ask() {
  printf '{"prompt": "%s", "user_id": "%s"}' "$1" "$USER_ID" > prompt.json
  aws bedrock-agentcore invoke-agent-runtime \
    --agent-runtime-arn "$AGENT_ARN" \
    --runtime-session-id "$SESSION_ID" \
    --content-type application/json \
    --accept text/event-stream \
    --payload fileb://prompt.json \
    answer.txt >/dev/null
  cat answer.txt
}
ask "My name is Alice. What is the hotel limit per night?"
ask "And for meals?"
aws bedrock-agentcore stop-runtime-session --agent-runtime-arn "$AGENT_ARN" --runtime-session-id "$SESSION_ID"
ask "What is my name, and what did I ask first?"

# 5. A thread by hand: one event per message, keyed by user (actor) and session.
SESSION_ID=$(uuidgen)
aws bedrock-agentcore create-event \
  --memory-id "$MEMORY_ID" --actor-id "$USER_ID" --session-id "$SESSION_ID" \
  --event-timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --payload '[{"conversational": {"role": "USER", "content": {"text": "What is the hotel limit per night?"}}}]'
ANSWER_ID=$(aws bedrock-agentcore create-event \
  --memory-id "$MEMORY_ID" --actor-id "$USER_ID" --session-id "$SESSION_ID" \
  --event-timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --payload '[{"conversational": {"role": "ASSISTANT", "content": {"text": "Up to 180 EUR in major cities."}}}]' \
  --query event.eventId --output text)

# 6. Fork after the answer: a branch starts after a root event and has its own history.
aws bedrock-agentcore create-event \
  --memory-id "$MEMORY_ID" --actor-id "$USER_ID" --session-id "$SESSION_ID" \
  --event-timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --payload '[{"conversational": {"role": "USER", "content": {"text": "Is Lyon a major city?"}}}]' \
  --branch "{\"name\": \"lyon\", \"rootEventId\": \"$ANSWER_ID\"}"

# 7. Read it back: every event of the session, then one branch with its parent's history.
aws bedrock-agentcore list-events \
  --memory-id "$MEMORY_ID" --actor-id "$USER_ID" --session-id "$SESSION_ID" \
  --include-payloads
aws bedrock-agentcore list-events \
  --memory-id "$MEMORY_ID" --actor-id "$USER_ID" --session-id "$SESSION_ID" \
  --include-payloads \
  --filter '{"branch": {"name": "lyon", "includeParentBranches": true}}'
