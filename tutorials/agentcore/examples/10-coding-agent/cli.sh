#!/usr/bin/env bash
# Tutorial 10: the pieces of the coding agent, with the AWS CLI.
set -euo pipefail

REGION=eu-west-1
IMAGE=111122223333.dkr.ecr.eu-west-1.amazonaws.com/coder:latest # built by CI: linux/arm64, with git
ROLE_ARN=arn:aws:iam::111122223333:role/coder-agent
GATEWAY_ID=helpdesk-tools-abc123xyz # tutorial 03
WORKFLOW_ROLE=coder-workflow # the role of your backend that drives tasks
GITHUB_CLIENT_ID=Iv23liREPLACEME
GITHUB_CLIENT_SECRET=${GITHUB_CLIENT_SECRET:?export the GitHub App client secret}

# 1. GitHub in the token vault. Register the returned callback URL in the GitHub App.
aws bedrock-agentcore-control create-oauth2-credential-provider --region "$REGION" \
  --name github --credential-provider-vendor GithubOauth2 \
  --oauth2-provider-config-input "{\"githubOauth2ProviderConfig\":{\"clientId\":\"$GITHUB_CLIENT_ID\",\"clientSecret\":\"$GITHUB_CLIENT_SECRET\"}}" \
  --query callbackUrl --output text

# The GitHub MCP server behind the Gateway, acting with the user's GitHub token from the vault.
PROVIDER_ARN=$(aws bedrock-agentcore-control get-oauth2-credential-provider --region "$REGION" \
  --name github --query credentialProviderArn --output text)
aws bedrock-agentcore-control create-gateway-target --region "$REGION" \
  --gateway-identifier "$GATEWAY_ID" --name github \
  --target-configuration '{"mcp":{"mcpServer":{"endpoint":"https://api.githubcopilot.com/mcp/"}}}' \
  --credential-provider-configurations "[{\"credentialProviderType\":\"OAUTH\",\"credentialProvider\":{\"oauthCredentialProvider\":{\"providerArn\":\"$PROVIDER_ARN\",\"scopes\":[\"repo\"],\"grantType\":\"AUTHORIZATION_CODE\"}}}]"

# 2. A sandbox for code nobody reviewed: no network at all
SANDBOX_ID=$(aws bedrock-agentcore-control create-code-interpreter --region "$REGION" \
  --name coder_sandbox --network-configuration '{"networkMode":"SANDBOX"}' \
  --query codeInterpreterId --output text)

# 3. The coding agent: container with git, workspace on session storage
RUNTIME_ARN=$(aws bedrock-agentcore-control create-agent-runtime --region "$REGION" \
  --agent-runtime-name coder \
  --agent-runtime-artifact "{\"containerConfiguration\":{\"containerUri\":\"$IMAGE\"}}" \
  --role-arn "$ROLE_ARN" \
  --network-configuration '{"networkMode":"PUBLIC"}' \
  --filesystem-configurations '[{"sessionStorage":{"mountPath":"/mnt/workspace"}}]' \
  --lifecycle-configuration '{"idleRuntimeSessionTimeout":1800,"maxLifetime":28800}' \
  --environment-variables "CODE_INTERPRETER_ID=$SANDBOX_ID" \
  --query agentRuntimeArn --output text)

# 4. The workflow may prompt the agent, name the user, and run commands in its VM
aws iam put-role-policy --role-name "$WORKFLOW_ROLE" --policy-name drive-coder \
  --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":[\"bedrock-agentcore:InvokeAgentRuntime\",\"bedrock-agentcore:InvokeAgentRuntimeForUser\",\"bedrock-agentcore:InvokeAgentRuntimeCommand\"],\"Resource\":[\"$RUNTIME_ARN\",\"$RUNTIME_ARN/*\"]}]}"

# Commands in a session's VM: use the SDKs or `agentcore invoke --exec`.
# The AWS CLI has no invoke-agent-runtime-command (a streamed operation).

clean_up() {
  aws iam delete-role-policy --role-name "$WORKFLOW_ROLE" --policy-name drive-coder
  aws bedrock-agentcore-control delete-agent-runtime --region "$REGION" --agent-runtime-id "${RUNTIME_ARN##*/}"
  aws bedrock-agentcore-control delete-code-interpreter --region "$REGION" --code-interpreter-id "$SANDBOX_ID"
  aws bedrock-agentcore-control delete-gateway-target --region "$REGION" --gateway-identifier "$GATEWAY_ID" \
    --target-id "$(aws bedrock-agentcore-control list-gateway-targets --region "$REGION" --gateway-identifier "$GATEWAY_ID" --query "items[?name=='GitHub'].targetId" --output text)"
  aws bedrock-agentcore-control delete-oauth2-credential-provider --region "$REGION" --name github
}
# When you are done: clean_up
