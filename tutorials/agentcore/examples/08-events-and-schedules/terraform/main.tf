terraform {
  required_version = ">= 1.16"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.66" }
  }
}

provider "aws" {
  region = var.region
}

# --- The agent: accepts Auth0 tokens, replies "accepted", keeps working ----------------
resource "aws_bedrockagentcore_agent_runtime" "events" {
  agent_runtime_name = "helpdesk_events"
  role_arn           = var.agent_role_arn

  agent_runtime_artifact {
    code_configuration {
      runtime     = "PYTHON_3_12"
      entry_point = ["agent.py"]
      code {
        s3 {
          bucket = var.agent_code_bucket
          prefix = "helpdesk_events/agent.zip"
        }
      }
    }
  }

  network_configuration {
    network_mode = "PUBLIC"
  }

  authorizer_configuration {
    custom_jwt_authorizer {
      discovery_url    = "https://fintech.eu.auth0.com/.well-known/openid-configuration"
      allowed_audience = ["https://agents.fintech.example"]
    }
  }
}

# The Auth0 client secret. Put the value in with: aws secretsmanager put-secret-value
resource "aws_secretsmanager_secret" "auth0" {
  name = "helpdesk/agent-scheduler-client-secret"
}

# --- The Lambda that starts agent runs -------------------------------------------------
resource "aws_iam_role" "trigger" {
  name = "helpdesk-trigger"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "trigger_logs" {
  role       = aws_iam_role.trigger.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "trigger_secret" {
  role = aws_iam_role.trigger.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "secretsmanager:GetSecretValue"
      Resource = aws_secretsmanager_secret.auth0.arn
    }]
  })
}

resource "aws_lambda_function" "trigger" {
  function_name = "helpdesk-trigger"
  role          = aws_iam_role.trigger.arn
  runtime       = "python3.12" # TypeScript: "nodejs22.x"
  handler       = "handler.handler"
  filename      = var.lambda_zip
  timeout       = 60

  environment {
    variables = {
      AGENT_ARN       = aws_bedrockagentcore_agent_runtime.events.agent_runtime_arn
      AUTH0_CLIENT_ID = var.auth0_client_id
      AUTH0_SECRET_ID = aws_secretsmanager_secret.auth0.arn
    }
  }
}

# --- Schedule: weekdays at 06:00 Dublin time ------------------------------------------
resource "aws_iam_role" "scheduler" {
  name = "helpdesk-scheduler"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "scheduler.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy" "scheduler_invoke" {
  role = aws_iam_role.scheduler.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "lambda:InvokeFunction"
      Resource = aws_lambda_function.trigger.arn
    }]
  })
}

resource "aws_scheduler_schedule" "daily_digest" {
  name                         = "helpdesk-daily-digest"
  schedule_expression          = "cron(0 6 ? * MON-FRI *)"
  schedule_expression_timezone = "Europe/Dublin"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_lambda_function.trigger.arn
    role_arn = aws_iam_role.scheduler.arn
    # Shaped like an EventBridge event. The scheduled time is the same on every retry.
    input = jsonencode({
      id            = "<aws.scheduler.scheduled-time>"
      source        = "scheduler.daily-digest"
      "detail-type" = "DailyDigest"
      detail        = {}
    })
  }
}

# --- Event: a ticket was escalated ----------------------------------------------------
resource "aws_cloudwatch_event_rule" "escalated" {
  name = "helpdesk-ticket-escalated"
  event_pattern = jsonencode({
    source        = ["fintech.tickets"]
    "detail-type" = ["TicketEscalated"]
  })
}

resource "aws_cloudwatch_event_target" "escalated" {
  rule = aws_cloudwatch_event_rule.escalated.name
  arn  = aws_lambda_function.trigger.arn
}

resource "aws_lambda_permission" "escalated" {
  statement_id  = "helpdesk-ticket-escalated"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.trigger.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.escalated.arn
}
