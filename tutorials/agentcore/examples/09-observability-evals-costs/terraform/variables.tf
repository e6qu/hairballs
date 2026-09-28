variable "region" {
  type    = string
  default = "eu-west-1"
}

variable "execution_role_name" {
  description = "The helpdesk harness's execution role (tutorial 01)."
  type        = string
  default     = "helpdesk-agent"
}

variable "budget_email" {
  type    = string
  default = "it-support@fintech.example"
}
