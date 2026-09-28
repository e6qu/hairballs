# Tutorial 04's helpdesk runtime behind an Auth0 JWT authorizer, plus an Auth0 credential provider
# in the token vault for calling the tickets API.
terraform {
  required_version = ">= 1.16"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.66" }
  }
}

provider "aws" {
  region = "eu-west-1"
}

data "aws_caller_identity" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
}

resource "aws_iam_role" "helpdesk" {
  name = "helpdesk-code-agent"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "bedrock-agentcore.amazonaws.com" }
      Condition = { StringEquals = { "aws:SourceAccount" = local.account_id } }
    }]
  })
}

resource "aws_iam_role_policy" "helpdesk" {
  role = aws_iam_role.helpdesk.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]
        Resource = ["arn:aws:bedrock:*::foundation-model/*", "arn:aws:bedrock:*:${local.account_id}:inference-profile/*"]
      },
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:DescribeLogStreams", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:aws:logs:eu-west-1:${local.account_id}:log-group:/aws/bedrock-agentcore/runtimes/*"
      },
      {
        Effect   = "Allow"
        Action   = "logs:DescribeLogGroups"
        Resource = "*"
      },
    ]
  })
}

resource "aws_bedrockagentcore_oauth2_credential_provider" "auth0_tickets" {
  name                       = "auth0-tickets"
  credential_provider_vendor = "Auth0Oauth2"

  oauth2_provider_config {
    included_oauth2_provider_config {
      client_id_wo                  = var.auth0_client_id
      client_secret_wo              = var.auth0_client_secret
      client_credentials_wo_version = 1 # bump to push a new secret
      issuer                        = "https://fintech.eu.auth0.com/"
      authorization_endpoint        = "https://fintech.eu.auth0.com/authorize"
      token_endpoint                = "https://fintech.eu.auth0.com/oauth/token"
    }
  }
}

resource "aws_iam_role_policy" "helpdesk_tokens" {
  role = aws_iam_role.helpdesk.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = "bedrock-agentcore:GetResourceOauth2Token"
        Resource = [
          "arn:aws:bedrock-agentcore:eu-west-1:${local.account_id}:workload-identity-directory/*",
          "arn:aws:bedrock-agentcore:eu-west-1:${local.account_id}:token-vault/*",
        ]
      },
      {
        Effect   = "Allow"
        Action   = "secretsmanager:GetSecretValue"
        Resource = aws_bedrockagentcore_oauth2_credential_provider.auth0_tickets.client_secret_arn[0].secret_arn
      },
    ]
  })
}

resource "aws_bedrockagentcore_agent_runtime" "helpdesk" {
  agent_runtime_name = "helpdesk_code"
  role_arn           = aws_iam_role.helpdesk.arn

  agent_runtime_artifact {
    code_configuration {
      runtime     = var.runtime
      entry_point = var.entry_point
      code {
        s3 {
          bucket = var.code_bucket
          prefix = var.code_key
        }
      }
    }
  }

  network_configuration {
    network_mode = "PUBLIC"
  }

  # Only callers with a valid Auth0 token for the agents API get in.
  authorizer_configuration {
    custom_jwt_authorizer {
      discovery_url    = "https://fintech.eu.auth0.com/.well-known/openid-configuration"
      allowed_audience = ["https://agents.fintech.example"]
    }
  }

  # Pass the (already validated) token on to the agent code.
  request_header_configuration {
    request_header_allowlist = ["Authorization"]
  }

  depends_on = [aws_iam_role_policy.helpdesk, aws_iam_role_policy.helpdesk_tokens]
}

output "agent_runtime_arn" {
  value = aws_bedrockagentcore_agent_runtime.helpdesk.agent_runtime_arn
}

output "callback_url" {
  description = "Add to the Auth0 application's Allowed Callback URLs (needed for user-delegated flows)."
  value       = aws_bedrockagentcore_oauth2_credential_provider.auth0_tickets.callback_url
}
