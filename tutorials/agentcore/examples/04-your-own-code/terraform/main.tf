# The helpdesk code agent on AgentCore Runtime: an IAM role and a runtime that runs a zip from S3.
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

  depends_on = [aws_iam_role_policy.helpdesk]
}

# For people and services that call the agent with IAM credentials: attach it to their role.
resource "aws_iam_policy" "invoke" {
  name = "helpdesk-code-invoke"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = ["bedrock-agentcore:InvokeAgentRuntime", "bedrock-agentcore:StopRuntimeSession"]
      Resource = [
        aws_bedrockagentcore_agent_runtime.helpdesk.agent_runtime_arn,
        "${aws_bedrockagentcore_agent_runtime.helpdesk.agent_runtime_arn}/runtime-endpoint/*",
      ]
    }]
  })
}

output "agent_runtime_arn" {
  value = aws_bedrockagentcore_agent_runtime.helpdesk.agent_runtime_arn
}
