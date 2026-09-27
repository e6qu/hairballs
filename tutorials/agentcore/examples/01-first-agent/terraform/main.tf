# Tutorial 01: the helpdesk harness with Terraform.
terraform {
  required_version = ">= 1.16"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.66" }
  }
}

provider "aws" {
  region = "eu-west-1"
}

# The execution role: what the agent may do in AWS.
resource "aws_iam_role" "helpdesk" {
  name               = "helpdesk-harness"
  assume_role_policy = file("${path.module}/../iam/trust-policy.json")
}

resource "aws_iam_role_policy" "helpdesk" {
  role   = aws_iam_role.helpdesk.id
  name   = "harness"
  policy = file("${path.module}/../iam/harness-policy.json")
}

# The agent: model, instructions and limits.
resource "aws_bedrockagentcore_harness" "helpdesk" {
  harness_name       = "helpdesk"
  execution_role_arn = aws_iam_role.helpdesk.arn

  model {
    bedrock_model_config {
      model_id = "global.anthropic.claude-haiku-4-5-20251001-v1:0"
    }
  }
  system_prompt {
    text = file("${path.module}/../harness/system-prompt.md")
  }
  memory {
    disabled {}
  }
  max_iterations  = 20
  timeout_seconds = 300

  depends_on = [aws_iam_role_policy.helpdesk]
}

output "harness_arn" {
  value = aws_bedrockagentcore_harness.helpdesk.arn
}
