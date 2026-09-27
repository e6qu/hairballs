#!/usr/bin/env bash
# Auth0 with the plain AWS CLI: an Auth0 credential provider in the token vault, the tutorial 04
# runtime switched to an Auth0 JWT authorizer (running this tutorial's code), and a call with a token.
# Usage: AGENT_CLIENT_ID=... AGENT_CLIENT_SECRET=... \
#        SCHEDULER_CLIENT_ID=... SCHEDULER_CLIENT_SECRET=... ./cli.sh [python|typescript]
#        ./cli.sh cleanup
set -euo pipefail

REGION=eu-west-1
ACCOUNT_ID=111122223333
ROLE_NAME=helpdesk-code-agent # from tutorial 04
AGENT_NAME=helpdesk_code      # from tutorial 04
BUCKET=fintech-agent-code
KEY=helpdesk/agent.zip
AUTH0_DOMAIN=fintech.eu.auth0.com
AUDIENCE=https://agents.fintech.example
LANGUAGE=${1:-python}
export AWS_REGION=$REGION
cd "$(dirname "$0")"

if [ "$LANGUAGE" = cleanup ]; then
  aws bedrock-agentcore-control delete-oauth2-credential-provider --name auth0-tickets
  aws iam delete-role-policy --role-name "$ROLE_NAME" --policy-name helpdesk-tokens
  exit 0
fi

# 1. Outbound: the agent's own Auth0 M2M app as a credential provider. The token vault keeps its secret.
PROVIDER_CONFIG=$(cat <<EOF
{"includedOauth2ProviderConfig": {
  "clientId": "$AGENT_CLIENT_ID", "clientSecret": "$AGENT_CLIENT_SECRET",
  "issuer": "https://$AUTH0_DOMAIN/",
  "authorizationEndpoint": "https://$AUTH0_DOMAIN/authorize",
  "tokenEndpoint": "https://$AUTH0_DOMAIN/oauth/token"}}
EOF
)
SECRET_ARN=$(aws bedrock-agentcore-control create-oauth2-credential-provider \
  --name auth0-tickets \
  --credential-provider-vendor Auth0Oauth2 \
  --oauth2-provider-config-input "$PROVIDER_CONFIG" \
  --query clientSecretArn.secretArn --output text)

TOKENS_POLICY=$(cat <<EOF
{"Version": "2012-10-17", "Statement": [
  {"Effect": "Allow", "Action": "bedrock-agentcore:GetResourceOauth2Token",
   "Resource": ["arn:aws:bedrock-agentcore:$REGION:$ACCOUNT_ID:workload-identity-directory/*",
                "arn:aws:bedrock-agentcore:$REGION:$ACCOUNT_ID:token-vault/*"]},
  {"Effect": "Allow", "Action": "secretsmanager:GetSecretValue", "Resource": "$SECRET_ARN"}]}
EOF
)
aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name helpdesk-tokens --policy-document "$TOKENS_POLICY"

# 2. Package this tutorial's agent (as in tutorial 04).
rm -rf build agent.zip && mkdir build
if [ "$LANGUAGE" = python ]; then
  uv pip install --target build --python-platform aarch64-manylinux2014 --python-version 3.13 \
    --only-binary=:all: -r python/pyproject.toml
  cp python/main.py python/domain.py python/core.py python/tickets.py build/
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

# 3. Inbound: only callers with an Auth0 token for the agents API get in, and the agent sees the token.
AGENT_ID=$(aws bedrock-agentcore-control list-agent-runtimes \
  --query "agentRuntimes[?agentRuntimeName=='$AGENT_NAME'].agentRuntimeId | [0]" --output text)
ARTIFACT=$(cat <<EOF
{"codeConfiguration": {"code": {"s3": {"bucket": "$BUCKET", "prefix": "$KEY"}},
  "runtime": "$RUNTIME", "entryPoint": $ENTRY_POINT}}
EOF
)
AUTHORIZER=$(cat <<EOF
{"customJWTAuthorizer": {
  "discoveryUrl": "https://$AUTH0_DOMAIN/.well-known/openid-configuration",
  "allowedAudience": ["$AUDIENCE"]}}
EOF
)
AGENT_ARN=$(aws bedrock-agentcore-control update-agent-runtime \
  --agent-runtime-id "$AGENT_ID" \
  --role-arn "arn:aws:iam::$ACCOUNT_ID:role/$ROLE_NAME" \
  --agent-runtime-artifact "$ARTIFACT" \
  --network-configuration '{"networkMode": "PUBLIC"}' \
  --authorizer-configuration "$AUTHORIZER" \
  --request-header-configuration '{"requestHeaderAllowlist": ["Authorization"]}' \
  --query agentRuntimeArn --output text)
until [ "$(aws bedrock-agentcore-control get-agent-runtime --agent-runtime-id "$AGENT_ID" \
  --query status --output text)" = READY ]; do sleep 5; done

# 4. Call it as a service (the scheduler's M2M app): a token from Auth0, then HTTPS with the bearer token.
TOKEN=$(curl -sS "https://$AUTH0_DOMAIN/oauth/token" \
  -H 'Content-Type: application/json' \
  -d "{\"grant_type\": \"client_credentials\", \"client_id\": \"$SCHEDULER_CLIENT_ID\",
       \"client_secret\": \"$SCHEDULER_CLIENT_SECRET\", \"audience\": \"$AUDIENCE\"}" |
  python3 -c 'import json, sys; print(json.load(sys.stdin)["access_token"])')
ENCODED_ARN=$(python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$AGENT_ARN")
curl -sS -N "https://bedrock-agentcore.$REGION.amazonaws.com/runtimes/$ENCODED_ARN/invocations?qualifier=DEFAULT" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id: $(uuidgen)" \
  -H 'Content-Type: application/json' \
  -H 'Accept: text/event-stream' \
  -d '{"prompt": "How much can I claim for meals on a 4-day trip?"}'
