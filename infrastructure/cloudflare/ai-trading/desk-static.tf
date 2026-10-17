variable "desk_cutover_enabled" {
  type        = bool
  default     = false
  description = "Owner-reviewed cutover: enable the Desk Worker route and remove only the interim hub_hostname tunnel ingress in the same apply. Upload the release export first."
}

variable "desk_static_bucket_name" {
  type        = string
  default     = "tobytran-ai-trading-desk"
  description = "GCS desk_bucket_name output from infrastructure/gcp/ai-trading."
}

# Provision the script before cutover; no public route until explicitly enabled.
resource "cloudflare_workers_script" "desk_router" {
  account_id         = var.cloudflare_account_id
  script_name        = "ai-trading-desk-router"
  content            = file("${path.module}/worker/desk-router.js")
  main_module        = "desk-router.js"
  compatibility_date = "2026-10-16" # fetch(cache: no-store) enabled

  bindings = [
    { type = "plain_text", name = "STATIC_BUCKET", text = var.desk_static_bucket_name },
    { type = "plain_text", name = "ORIGIN_HOSTNAME", text = var.hub_origin_hostname },
  ]
}

resource "cloudflare_workers_route" "desk_static" {
  count   = var.desk_cutover_enabled ? 1 : 0
  zone_id = data.cloudflare_zone.main.id
  # Keep the existing proxied tunnel DNS record. Worker intercepts this host;
  # reverting the boolean restores its interim tunnel service without DNS churn.
  pattern = "${var.hub_hostname}/*"
  script  = cloudflare_workers_script.desk_router.script_name
}
