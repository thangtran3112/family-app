mock_provider "cloudflare" {}

variables {
  cloudflare_account_id = "offline-account"
  mirofish_bucket_name  = "offline-mirofish"
}

run "provision_before_cutover" {
  command = plan

  assert {
    condition     = length(cloudflare_workers_route.desk_static) == 0
    error_message = "Default provisioning must not bind the Desk hostname."
  }
  assert {
    condition     = length([for rule in cloudflare_zero_trust_tunnel_cloudflared_config.ai_trading.config.ingress : rule if rule.hostname == "trading.tobytran.dev"]) == 4
    error_message = "Keep all four interim ingress entries until cutover."
  }
}

run "cutover_preserves_other_hosts_and_origin" {
  command = plan
  variables {
    desk_cutover_enabled = true
  }

  assert {
    condition     = cloudflare_workers_route.desk_static[0].pattern == "trading.tobytran.dev/*"
    error_message = "Desk route must bind only trading.tobytran.dev."
  }
  assert {
    condition     = length([for rule in cloudflare_zero_trust_tunnel_cloudflared_config.ai_trading.config.ingress : rule if rule.hostname == "trading.tobytran.dev"]) == 0
    error_message = "Cutover must remove every interim Desk-host ingress."
  }
  assert {
    condition     = length([for rule in cloudflare_zero_trust_tunnel_cloudflared_config.ai_trading.config.ingress : rule if rule.hostname == "trading-origin.tobytran.dev" && rule.service == "http://gateway:8080"]) == 1
    error_message = "Desk API origin must remain routed to Caddy."
  }
  assert {
    condition     = length([for rule in cloudflare_zero_trust_tunnel_cloudflared_config.ai_trading.config.ingress : rule if contains(["vibe-trading.tobytran.dev", "tradingagents.tobytran.dev", "ai-hedge-fund.tobytran.dev", "mirofish-origin.tobytran.dev"], coalesce(rule.hostname, "")) && rule.service == "http://gateway:8080"]) == 4
    error_message = "Cutover must preserve all other apps' gateway ingress."
  }
  assert {
    condition     = cloudflare_dns_record.tunnel["hub"].name == "trading.tobytran.dev" && cloudflare_workers_route.hub_static.pattern == "trading-hub.tobytran.dev/*"
    error_message = "Keep existing DNS and hub Worker route unchanged."
  }
}
