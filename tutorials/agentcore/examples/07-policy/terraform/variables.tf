variable "region" {
  type    = string
  default = "eu-west-1"
}

variable "gateway_role_arn" {
  description = "The Gateway's service role (from tutorial 03)."
  type        = string
  default     = "arn:aws:iam::111122223333:role/helpdesk-tools-gateway"
}

variable "policy_mode" {
  description = "LOG_ONLY first; ENFORCE once the logs look right."
  type        = string
  default     = "LOG_ONLY"
}
