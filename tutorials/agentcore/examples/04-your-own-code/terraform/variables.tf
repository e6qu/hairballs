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
