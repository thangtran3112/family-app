variable "tailnet" {
  type        = string
  description = "Tailnet ID of the family-app tailnet (Firestore shared/tailscale TAILSCALE_TAILNET)."
  sensitive   = true
}

variable "tailscale_oauth_client_id" {
  type        = string
  description = "Client ID of the Terraform OAuth client (Firestore shared/tailscale TAILSCALE_TF_OAUTH_CLIENT_ID)."
  sensitive   = true
}

variable "tailscale_oauth_client_secret" {
  type        = string
  description = "Client secret of the Terraform OAuth client, or file:<path> to a file that holds it (the provider reads the file). run-terraform.sh passes the file: form."
  sensitive   = true
}

variable "ssh_port" {
  type        = number
  description = "TCP port of the host's sshd, the only port the policy opens."
  default     = 2222

  validation {
    condition     = var.ssh_port >= 1 && var.ssh_port <= 65535
    error_message = "ssh_port must be between 1 and 65535."
  }
}

variable "tag_host" {
  type        = string
  description = "Tag of the family host (the SSH destination)."
  default     = "tag:family-host"

  validation {
    condition     = startswith(var.tag_host, "tag:")
    error_message = "tag_host must start with \"tag:\"."
  }
}

variable "tag_ci" {
  type        = string
  description = "Tag of CI runners (the non-admin SSH source)."
  default     = "tag:ci"

  validation {
    condition     = startswith(var.tag_ci, "tag:")
    error_message = "tag_ci must start with \"tag:\"."
  }
}
