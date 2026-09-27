# Tutorial 02: tutorial 01's harness plus a skill stored in S3.
terraform {
  required_version = ">= 1.16"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.66" }
  }
}

provider "aws" {
  region = "eu-west-1"
}

locals {
  base = "${path.module}/../../01-first-agent"
}

# The skills bucket, and one object per file in expense-policy/.
resource "aws_s3_bucket" "skills" {
  bucket = "fintech-agent-skills"
}

resource "aws_s3_object" "expense_policy" {
  for_each = fileset("${path.module}/../expense-policy", "**")

  bucket = aws_s3_bucket.skills.id
  key    = "expense-policy/${each.value}"
  source = "${path.module}/../expense-policy/${each.value}"
  etag   = filemd5("${path.module}/../expense-policy/${each.value}")
}

# The execution role from tutorial 01, plus read access to the skills.
resource "aws_iam_role" "helpdesk" {
  name               = "helpdesk-harness"
  assume_role_policy = file("${local.base}/iam/trust-policy.json")
}

resource "aws_iam_role_policy" "helpdesk" {
  role   = aws_iam_role.helpdesk.id
  name   = "harness"
  policy = file("${local.base}/iam/harness-policy.json")
}

resource "aws_iam_role_policy" "skills" {
  role   = aws_iam_role.helpdesk.id
  name   = "skills"
  policy = file("${path.module}/../iam/skills-policy.json")
}

resource "aws_bedrockagentcore_harness" "helpdesk" {
  harness_name       = "helpdesk"
  execution_role_arn = aws_iam_role.helpdesk.arn

  model {
    bedrock_model_config {
      model_id = "global.anthropic.claude-haiku-4-5-20251001-v1:0"
    }
  }
  system_prompt {
    text = file("${local.base}/harness/system-prompt.md")
  }
  skill {
    s3 {
      uri = "s3://${aws_s3_bucket.skills.id}/expense-policy/"
    }
  }
  memory {
    disabled {}
  }
  max_iterations  = 20
  timeout_seconds = 300

  depends_on = [aws_iam_role_policy.helpdesk, aws_iam_role_policy.skills, aws_s3_object.expense_policy]
}

output "harness_arn" {
  value = aws_bedrockagentcore_harness.helpdesk.arn
}
