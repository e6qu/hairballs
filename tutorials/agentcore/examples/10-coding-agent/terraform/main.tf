terraform {
  required_version = ">= 1.16"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.66" }
  }
}

provider "aws" {
  region = var.region
}

data "aws_iam_role" "coder" {
  name = var.execution_role_name
}

# --- GitHub in the token vault ---------------------------------------------------------
resource "aws_bedrockagentcore_oauth2_credential_provider" "github" {
  name                       = "github"
  credential_provider_vendor = "GithubOauth2"

  oauth2_provider_config {
    github_oauth2_provider_config {
      client_id     = var.github_client_id
      client_secret = var.github_client_secret
    }
  }
}

output "github_callback_url" {
  description = "Register this as the callback URL of the GitHub App."
  value       = aws_bedrockagentcore_oauth2_credential_provider.github.callback_url
}

# The GitHub MCP server behind the Gateway. The Gateway gets the user's GitHub token from the vault.
resource "aws_bedrockagentcore_gateway_target" "github" {
  name               = "github"
  gateway_identifier = var.gateway_id

  target_configuration {
    mcp {
      mcp_server {
        endpoint = "https://api.githubcopilot.com/mcp/"
      }
    }
  }

  credential_provider_configuration {
    oauth {
      provider_arn = aws_bedrockagentcore_oauth2_credential_provider.github.credential_provider_arn
      scopes       = ["repo"]
      grant_type   = "AUTHORIZATION_CODE"
    }
  }
}

# --- A sandbox for code nobody reviewed: no network at all ------------------------------
resource "aws_bedrockagentcore_code_interpreter" "sandbox" {
  name = "coder_sandbox"

  network_configuration {
    network_mode = "SANDBOX"
  }
}

# --- The coding agent: container with git, workspace on session storage -----------------
resource "aws_bedrockagentcore_agent_runtime" "coder" {
  agent_runtime_name = "coder"
  role_arn           = data.aws_iam_role.coder.arn

  agent_runtime_artifact {
    container_configuration {
      container_uri = var.container_uri
    }
  }

  network_configuration {
    network_mode = "PUBLIC"
  }

  filesystem_configuration {
    session_storage {
      mount_path = "/mnt/workspace"
    }
  }

  lifecycle_configuration = [{
    idle_runtime_session_timeout = 1800  # a task may pause between steps
    max_lifetime                 = 28800 # 8 hours, the maximum
  }]

  environment_variables = {
    CODE_INTERPRETER_ID = aws_bedrockagentcore_code_interpreter.sandbox.code_interpreter_id
  }
}

# What the agent itself may do beyond the basics: fetch the user's GitHub token, use the sandbox.
resource "aws_iam_role_policy" "coder_tools" {
  role = data.aws_iam_role.coder.name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["bedrock-agentcore:GetResourceOauth2Token", "secretsmanager:GetSecretValue"]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "bedrock-agentcore:StartCodeInterpreterSession",
          "bedrock-agentcore:InvokeCodeInterpreter",
          "bedrock-agentcore:StopCodeInterpreterSession",
        ]
        Resource = aws_bedrockagentcore_code_interpreter.sandbox.code_interpreter_arn
      },
    ]
  })
}

# What the workflow (your trusted backend) may do: prompt, name the user, run commands.
resource "aws_iam_policy" "coder_workflow" {
  name = "coder-workflow"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "bedrock-agentcore:InvokeAgentRuntime",
        "bedrock-agentcore:InvokeAgentRuntimeForUser",
        "bedrock-agentcore:InvokeAgentRuntimeCommand",
      ]
      Resource = [
        aws_bedrockagentcore_agent_runtime.coder.agent_runtime_arn,
        "${aws_bedrockagentcore_agent_runtime.coder.agent_runtime_arn}/*",
      ]
    }]
  })
}
