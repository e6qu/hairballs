terraform {
  required_version = ">= 1.16"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.66" }
  }
}

provider "aws" {
  region = var.region
}

# The policy engine: a container for Cedar policies.
resource "aws_bedrockagentcore_policy_engine" "helpdesk" {
  name        = "helpdesk_policies"
  description = "Who may call which helpdesk tool"
}

# One policy per file. Each file names the gateway ARN.
locals {
  policies = {
    tickets_for_users    = "tickets_for_users.cedar"
    no_m2m_create_ticket = "no_m2m_create_ticket.cedar"
    treasury_transfer    = "treasury_transfer.cedar"
  }
}

resource "aws_bedrockagentcore_policy" "helpdesk" {
  for_each         = local.policies
  name             = each.key
  policy_engine_id = aws_bedrockagentcore_policy_engine.helpdesk.policy_engine_id
  validation_mode  = "FAIL_ON_ANY_FINDINGS"

  definition {
    cedar {
      statement = templatefile("${path.module}/../policies/${each.value}", {
        gateway_arn = aws_bedrockagentcore_gateway.tools.gateway_arn
      })
    }
  }
}

# The Gateway from tutorial 03, now with the policy engine attached.
resource "aws_bedrockagentcore_gateway" "tools" {
  name            = "helpdesk-tools"
  role_arn        = var.gateway_role_arn
  protocol_type   = "MCP"
  authorizer_type = "CUSTOM_JWT"

  authorizer_configuration {
    custom_jwt_authorizer {
      discovery_url    = "https://fintech.eu.auth0.com/.well-known/openid-configuration"
      allowed_audience = ["https://agents.fintech.example"]
    }
  }

  policy_engine_configuration {
    arn  = aws_bedrockagentcore_policy_engine.helpdesk.policy_engine_arn
    mode = var.policy_mode
  }
}
