variable "region" {
  type    = string
  default = "eu-west-1"
}

variable "auth0_client_id" {
  description = "Client id of the Auth0 M2M application agent-scheduler."
  type        = string
  default     = "REPLACE_WITH_CLIENT_ID"
}

variable "lambda_zip" {
  description = "handler.py zipped (Python), or the bundled handler.js zipped (TypeScript)."
  type        = string
  default     = "handler.zip"
}

variable "agent_role_arn" {
  description = "Execution role of the helpdesk_events agent (Bedrock, logs; see tutorial 04)."
  type        = string
  default     = "arn:aws:iam::111122223333:role/helpdesk-agent"
}

variable "agent_code_bucket" {
  description = "Bucket holding the agent's zip, built by CI for linux/arm64."
  type        = string
  default     = "fintech-agent-artifacts"
}
