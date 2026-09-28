variable "region" {
  type    = string
  default = "eu-west-1"
}

variable "container_uri" {
  description = "The coder image, built and pushed by CI (linux/arm64, with git)."
  type        = string
  default     = "111122223333.dkr.ecr.eu-west-1.amazonaws.com/coder:latest"
}

variable "execution_role_name" {
  description = "The coder's execution role (Bedrock, ECR pull, logs; see tutorial 04)."
  type        = string
  default     = "coder-agent"
}

variable "github_client_id" {
  description = "Client id of the GitHub App (or OAuth App) the agent acts through."
  type        = string
  default     = "Iv23liREPLACEME"
}

variable "github_client_secret" {
  type      = string
  sensitive = true
  default   = "REPLACE_ME"
}

variable "gateway_id" {
  description = "The helpdesk-tools Gateway (tutorial 03)."
  type        = string
  default     = "helpdesk-tools-abc123xyz"
}
