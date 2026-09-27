variable "code_bucket" {
  description = "S3 bucket that holds the agent zip (uploaded by CI or cli.sh)."
  type        = string
  default     = "fintech-agent-code"
}

variable "code_key" {
  description = "S3 key of the agent zip."
  type        = string
  default     = "helpdesk/agent.zip"
}

variable "runtime" {
  description = "PYTHON_3_13 for the Python agent, NODE_22 for the TypeScript agent."
  type        = string
  default     = "PYTHON_3_13"
}

variable "entry_point" {
  description = "[\"main.py\"] for Python, [\"dist/main.js\"] for TypeScript."
  type        = list(string)
  default     = ["main.py"]
}

variable "auth0_client_id" {
  description = "Client id of the Auth0 M2M application the agent uses to call the tickets API."
  type        = string
}

variable "auth0_client_secret" {
  description = "Its client secret. Write-only: kept in the token vault, never in Terraform state."
  type        = string
  sensitive   = true
}
