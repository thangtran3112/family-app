variable "laptop_ssh_enabled" {
  type        = bool
  description = "Expose the host's sshd through this tunnel behind a Cloudflare Access application (operator SSH from outside the home network, via `cloudflared access ssh`). Off by default. Turning it on requires laptop_ssh_hostname and laptop_ssh_owner_email: the plan fails loudly if either is empty, so a half-configured apply can never create an ssh:// route or an Access policy that admits everyone."

  default = false

  validation {
    condition     = !var.laptop_ssh_enabled || (var.laptop_ssh_hostname != "" && var.laptop_ssh_owner_email != "")
    error_message = "laptop_ssh_enabled=true needs a non-empty laptop_ssh_hostname and laptop_ssh_owner_email. An empty owner identity would leave the Access policy with nothing to require, so the apply is refused instead."
  }

  validation {
    condition     = !var.laptop_ssh_enabled || endswith(var.laptop_ssh_hostname, ".${var.zone_name}")
    error_message = "laptop_ssh_hostname must be a hostname inside zone_name."
  }

  validation {
    condition     = !var.laptop_ssh_enabled || strcontains(var.laptop_ssh_owner_email, "@")
    error_message = "laptop_ssh_owner_email must be an email address."
  }
}

variable "laptop_ssh_hostname" {
  type        = string
  description = "Public hostname of the SSH endpoint, inside zone_name. Empty by default; the value lives in Firestore ai-trading/cloudflare as TF_VAR_laptop_ssh_hostname, never in this repository."
  default     = ""
}

variable "laptop_ssh_owner_email" {
  type        = string
  description = "The one identity the Access policy requires (`require` on this email, in addition to `include`). Empty by default and then rejected when laptop_ssh_enabled is true: it must never be empty while the endpoint is on, because an empty identity must fail the apply rather than admit everyone. The value lives in Firestore ai-trading/cloudflare as TF_VAR_laptop_ssh_owner_email."
  default     = ""
  sensitive   = true
}

variable "laptop_ssh_origin" {
  type        = string
  description = "host:port the connector dials for the ssh:// ingress, as seen from inside the cloudflared container. The container is on bridge networks, so `localhost` is the container itself, not the host. The default needs `extra_hosts: [\"host.docker.internal:host-gateway\"]` on the cloudflared service in infrastructure/apps/ai-trading/docker-compose.yml, which that file does not have yet."
  default     = "host.docker.internal:2222"
}
