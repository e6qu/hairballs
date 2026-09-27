# Tutorial 03: tutorial 02's harness, with its tools behind an AgentCore Gateway.
terraform {
  required_version = ">= 1.16"
  required_providers {
    aws     = { source = "hashicorp/aws", version = "~> 6.66" }
    archive = { source = "hashicorp/archive", version = "~> 2.8" }
  }
}

provider "aws" {
  region = "eu-west-1"
}

locals {
  base   = "${path.module}/../../01-first-agent"
  skills = "${path.module}/../../02-skills"
  iam    = "${path.module}/../iam"
}

# --- The Lambda tool -------------------------------------------------------

data "archive_file" "expenses" {
  type        = "zip"
  source_file = "${path.module}/../python/expenses_tool.py"
  output_path = "${path.module}/expenses_tool.zip"
}

resource "aws_iam_role" "expenses_lambda" {
  name               = "helpdesk-expenses-lambda"
  assume_role_policy = file("${local.iam}/lambda-trust-policy.json")
}

resource "aws_iam_role_policy_attachment" "expenses_logs" {
  role       = aws_iam_role.expenses_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_lambda_function" "expenses" {
  function_name    = "helpdesk-expenses"
  role             = aws_iam_role.expenses_lambda.arn
  runtime          = "python3.13"
  architectures    = ["arm64"]
  handler          = "expenses_tool.handler"
  filename         = data.archive_file.expenses.output_path
  source_code_hash = data.archive_file.expenses.output_base64sha256
}

# --- The gateway and its targets -------------------------------------------

resource "aws_iam_role" "gateway" {
  name               = "helpdesk-gateway"
  assume_role_policy = file("${local.iam}/gateway-trust-policy.json")
}

resource "aws_iam_role_policy" "gateway" {
  role   = aws_iam_role.gateway.id
  name   = "invoke-tools"
  policy = file("${local.iam}/gateway-policy.json")
}

resource "aws_bedrockagentcore_gateway" "tools" {
  name            = "helpdesk-tools"
  role_arn        = aws_iam_role.gateway.arn
  protocol_type   = "MCP"
  authorizer_type = "AWS_IAM"
}

resource "aws_bedrockagentcore_gateway_target" "tickets" {
  gateway_identifier = aws_bedrockagentcore_gateway.tools.gateway_id
  name               = "tickets"

  target_configuration {
    mcp {
      mcp_server {
        endpoint = "https://tools.fintech.example/mcp"
      }
    }
  }
}

resource "aws_bedrockagentcore_gateway_target" "expenses" {
  gateway_identifier = aws_bedrockagentcore_gateway.tools.gateway_id
  name               = "expenses"

  credential_provider_configuration {
    gateway_iam_role {}
  }
  target_configuration {
    mcp {
      lambda {
        lambda_arn = aws_lambda_function.expenses.arn
        tool_schema {
          inline_payload {
            name        = "check_claim"
            description = "Check whether an expense amount is within Fintech Ltd policy. Returns within_policy and limit_eur."
            input_schema {
              type = "object"
              property {
                name        = "category"
                type        = "string"
                description = "hotel (per night) or meals (per day)"
                required    = true
              }
              property {
                name        = "amount_eur"
                type        = "number"
                description = "The amount claimed, in EUR"
                required    = true
              }
              property {
                name        = "city_class"
                type        = "string"
                description = "major or standard (default standard)"
              }
            }
          }
        }
      }
    }
  }

  depends_on = [aws_iam_role_policy.gateway]
}

# --- The harness (tutorials 01 and 02), now using the gateway ----------------

resource "aws_s3_bucket" "skills" {
  bucket = "fintech-agent-skills"
}

resource "aws_s3_object" "expense_policy" {
  for_each = fileset("${local.skills}/expense-policy", "**")

  bucket = aws_s3_bucket.skills.id
  key    = "expense-policy/${each.value}"
  source = "${local.skills}/expense-policy/${each.value}"
  etag   = filemd5("${local.skills}/expense-policy/${each.value}")
}

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
  policy = file("${local.skills}/iam/skills-policy.json")
}

resource "aws_iam_role_policy" "harness_gateway" {
  role   = aws_iam_role.helpdesk.id
  name   = "gateway"
  policy = file("${local.iam}/harness-gateway-policy.json")
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
  tool {
    type = "agentcore_gateway"
    name = "helpdesk-tools"
    config {
      agentcore_gateway {
        gateway_arn = aws_bedrockagentcore_gateway.tools.gateway_arn
        outbound_auth {
          aws_iam = true
        }
      }
    }
  }
  memory {
    disabled {}
  }
  max_iterations  = 20
  timeout_seconds = 300

  depends_on = [
    aws_iam_role_policy.helpdesk,
    aws_iam_role_policy.skills,
    aws_iam_role_policy.harness_gateway,
    aws_s3_object.expense_policy,
  ]
}

# Callers (your application) attach this policy to invoke the agent.
resource "aws_iam_policy" "invoke" {
  name = "helpdesk-invoke"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["bedrock-agentcore:InvokeHarness", "bedrock-agentcore:InvokeAgentRuntime"]
      Resource = aws_bedrockagentcore_harness.helpdesk.arn
    }]
  })
}

# Callers that use the gateway directly (step 6) attach this policy.
resource "aws_iam_policy" "invoke_gateway" {
  name = "helpdesk-invoke-gateway"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "bedrock-agentcore:InvokeGateway"
      Resource = aws_bedrockagentcore_gateway.tools.gateway_arn
    }]
  })
}

output "harness_arn" {
  value = aws_bedrockagentcore_harness.helpdesk.arn
}

output "gateway_url" {
  value = aws_bedrockagentcore_gateway.tools.gateway_url
}
