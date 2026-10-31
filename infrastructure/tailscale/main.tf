# Tailnet policy for the family-app tailnet. Operator-applied (no CI apply
# job); see README.md. Credentials arrive as TF_VAR_* from run-terraform.sh,
# never from this repository.
terraform {
  required_version = ">= 1.10.0"

  required_providers {
    tailscale = {
      source  = "tailscale/tailscale"
      version = "~> 0.29" # pinned release: 0.29.3
    }
  }

  backend "gcs" {
    prefix = "tailscale"
  }
}

provider "tailscale" {
  tailnet             = var.tailnet
  oauth_client_id     = var.tailscale_oauth_client_id
  oauth_client_secret = var.tailscale_oauth_client_secret
}

# Tailscale is for admin and CI SSH only. Public traffic stays on the
# Cloudflare tunnels and never touches the tailnet, so the policy is
# default-deny and holds exactly the two flows below. There is no `ssh`
# section either: the host runs a plain sshd on a TCP port, not Tailscale SSH.
# Grants take an implied accept action.
resource "tailscale_acl" "policy" {
  overwrite_existing_content = true

  acl = jsonencode({
    tagOwners = {
      (var.tag_host) = ["autogroup:admin"]
      (var.tag_ci)   = ["autogroup:admin"]
    }

    grants = [
      {
        src = ["autogroup:admin"]
        dst = [var.tag_host]
        ip  = ["tcp:${var.ssh_port}"]
      },
      {
        src = [var.tag_ci]
        dst = [var.tag_host]
        ip  = ["tcp:${var.ssh_port}"]
      },
    ]
  })
}
