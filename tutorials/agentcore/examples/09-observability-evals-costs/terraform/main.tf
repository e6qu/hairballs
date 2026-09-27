terraform {
  required_version = ">= 1.16"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.66" }
  }
}

provider "aws" {
  region = var.region
}

data "aws_caller_identity" "me" {}
data "aws_iam_role" "helpdesk" {
  name = var.execution_role_name
}

locals {
  account = data.aws_caller_identity.me.account_id
  model   = "global.anthropic.claude-haiku-4-5-20251001-v1:0"
  tags    = { agent = "helpdesk", team = "it-support", "cost-centre" = "cc-1234" }
}

# --- Cost per agent: its own application inference profile, tagged ----------------------
resource "aws_bedrock_inference_profile" "helpdesk" {
  name        = "helpdesk-haiku"
  description = "Every model call of the helpdesk agent"
  model_source {
    copy_from = "arn:aws:bedrock:${var.region}:${local.account}:inference-profile/${local.model}"
  }
  tags = local.tags
}

resource "aws_iam_role_policy" "helpdesk_profile" {
  role = data.aws_iam_role.helpdesk.name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]
      Resource = [
        aws_bedrock_inference_profile.helpdesk.arn,
        "arn:aws:bedrock:*:*:inference-profile/${local.model}",
        "arn:aws:bedrock:*::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0",
      ]
    }]
  })
}

# --- The harness: the profile as its model, and hard limits per invocation ---------------
resource "aws_bedrockagentcore_harness" "helpdesk" {
  harness_name       = "helpdesk"
  execution_role_arn = data.aws_iam_role.helpdesk.arn

  model {
    bedrock_model_config {
      model_id = aws_bedrock_inference_profile.helpdesk.arn
    }
  }
  system_prompt {
    text = file("${path.module}/system-prompt.md")
  }

  max_iterations  = 20     # model/tool cycles per invocation (default 75)
  max_tokens      = 100000 # token budget per invocation (default: none)
  timeout_seconds = 600    # wall clock per invocation (default 3600)

  environment {
    agentcore_runtime_environment {
      lifecycle_configuration = [{
        idle_runtime_session_timeout = 300  # stop paying for memory 5 min after the last call
        max_lifetime                 = 3600 # (default 28800)
      }]
    }
  }

  tags = local.tags # propagate to the managed Runtime, endpoint and Memory
}

# --- A budget on the agent's tag -----------------------------------------------------
resource "aws_ce_cost_allocation_tag" "agent" {
  tag_key = "agent"
  status  = "Active"
}

resource "aws_budgets_budget" "helpdesk" {
  name         = "agent-helpdesk"
  budget_type  = "COST"
  limit_amount = "50"
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  cost_filter {
    name   = "TagKeyValue"
    values = ["user:agent$helpdesk"]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.budget_email]
  }
}

# --- Online evaluation: score 5% of sessions continuously ------------------------------
locals {
  runtime = aws_bedrockagentcore_harness.helpdesk.environment_actual[0].agentcore_runtime_environment[0]
}

resource "aws_iam_role" "evaluations" {
  name = "helpdesk-evaluations"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "bedrock-agentcore.amazonaws.com" }
      Condition = {
        StringEquals = { "aws:SourceAccount" = local.account }
        ArnLike = {
          "aws:SourceArn" = "arn:aws:bedrock-agentcore:${var.region}:${local.account}:online-evaluation-config/*"
        }
      }
    }]
  })
}

resource "aws_iam_role_policy" "evaluations" {
  role = aws_iam_role.evaluations.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["logs:DescribeLogGroups", "logs:StartQuery", "logs:GetQueryResults"]
        Resource = "*"
      },
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:aws:logs:${var.region}:${local.account}:log-group:/aws/bedrock-agentcore/evaluations/*"
      },
      {
        Effect = "Allow"
        Action = ["logs:DescribeIndexPolicies", "logs:PutIndexPolicy"]
        Resource = [
          "arn:aws:logs:${var.region}:${local.account}:log-group:aws/spans",
          "arn:aws:logs:${var.region}:${local.account}:log-group:aws/spans:*",
        ]
      },
    ]
  })
}

resource "aws_bedrockagentcore_online_evaluation_config" "helpdesk" {
  online_evaluation_config_name = "helpdesk_online"
  evaluation_execution_role_arn = aws_iam_role.evaluations.arn
  enable_on_create              = true

  rule {
    sampling_config {
      sampling_percentage = 5
    }
  }

  data_source_config {
    cloudwatch_logs {
      log_group_names = ["/aws/bedrock-agentcore/runtimes/${local.runtime.agent_runtime_id}-DEFAULT"]
      service_names   = ["${local.runtime.agent_runtime_name}.DEFAULT"]
    }
  }

  evaluator {
    evaluator_id = "Builtin.GoalSuccessRate"
  }
  evaluator {
    evaluator_id = "Builtin.Helpfulness"
  }
}

# --- Who may call the agent, and who may score it ------------------------------------
# InvokeHarness needs both actions on the harness ARN.
resource "aws_iam_policy" "helpdesk_caller" {
  name = "helpdesk-harness-caller"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["bedrock-agentcore:InvokeHarness", "bedrock-agentcore:InvokeAgentRuntime"]
      Resource = aws_bedrockagentcore_harness.helpdesk.arn
    }]
  })
}

# On-demand evaluation from code: read the harness, query its spans, call Evaluate.
resource "aws_iam_policy" "helpdesk_evaluator" {
  name = "helpdesk-evaluator"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["bedrock-agentcore:GetHarness", "bedrock-agentcore:GetEvaluator"]
        Resource = "*"
      },
      {
        Effect   = "Allow"
        Action   = ["bedrock-agentcore:Evaluate"]
        Resource = "*"
      },
      {
        Effect   = "Allow"
        Action   = ["logs:StartQuery", "logs:GetQueryResults"]
        Resource = "*"
      },
    ]
  })
}
