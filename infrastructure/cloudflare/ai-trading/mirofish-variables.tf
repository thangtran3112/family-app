# infrastructure/cloudflare/ai-trading/mirofish-variables.tf
# Variables used only by mirofish.tf, kept out of the shared variables.tf
# so both files can grow independently of each other and of the sibling
# hub-static-variables.tf. `mirofish_staging_hostname` keeps its name so the
# DNS record and Worker route update in place, but since the owner-approved
# cutover (2026-10-10) it holds the public mirofish.tobytran.dev hostname.

variable "mirofish_origin_hostname" {
  type        = string
  description = "MiroFish's tunnel-origin hostname. Unrouted by the mirofish-static Worker (no static-asset route targets it) but publicly resolvable (proxied CNAME to the ai-trading tunnel, see mirofish.tf) — the Caddy gateway's forward_auth is the authentication boundary, not network privacy."
  default     = "mirofish-origin.tobytran.dev"
}

variable "mirofish_staging_hostname" {
  type        = string
  description = "Public MiroFish hostname, served by the mirofish-static Worker from GCS (formerly the mirofish-static staging hostname)."
  default     = "mirofish.tobytran.dev"
}

variable "mirofish_bucket_name" {
  type        = string
  description = "GCS bucket name from infrastructure/gcp/ai-trading's mirofish_bucket_name output. Passed explicitly rather than read via terraform_remote_state, to keep this file's blast radius independent of the GCP state's shape."
}
