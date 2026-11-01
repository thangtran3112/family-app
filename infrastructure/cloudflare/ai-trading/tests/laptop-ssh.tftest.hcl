mock_provider "cloudflare" {}

variables {
  cloudflare_account_id = "offline-account"
  mirofish_bucket_name  = "offline-mirofish"
}

run "off_by_default" {
  command = plan

  assert {
    condition     = length(cloudflare_zero_trust_access_application.laptop_ssh) == 0 && length(cloudflare_zero_trust_access_policy.laptop_ssh) == 0
    error_message = "No Access application or policy unless laptop_ssh_enabled."
  }
  assert {
    condition     = length([for rule in cloudflare_zero_trust_tunnel_cloudflared_config.ai_trading.config.ingress : rule if startswith(try(rule.service, ""), "ssh://")]) == 0
    error_message = "No ssh:// ingress unless laptop_ssh_enabled."
  }
  assert {
    condition     = !contains(keys(cloudflare_dns_record.tunnel), "laptop_ssh")
    error_message = "No SSH DNS record unless laptop_ssh_enabled."
  }
}

run "enabled_is_gated_and_before_the_catch_all" {
  command = plan
  variables {
    laptop_ssh_enabled             = true
    laptop_ssh_hostname            = "offline-ssh.tobytran.dev"
    laptop_ssh_owner_email         = "owner@example.invalid"
    laptop_ssh_ci_service_token_id = "00000000-0000-0000-0000-000000000000"
  }

  assert {
    condition     = length([for rule in cloudflare_zero_trust_tunnel_cloudflared_config.ai_trading.config.ingress : rule if rule.hostname == "offline-ssh.tobytran.dev" && rule.service == "ssh://host.docker.internal:2222"]) == 1
    error_message = "Exactly one ssh:// ingress for the SSH hostname."
  }
  assert {
    condition     = element(cloudflare_zero_trust_tunnel_cloudflared_config.ai_trading.config.ingress, length(cloudflare_zero_trust_tunnel_cloudflared_config.ai_trading.config.ingress) - 1).service == "http_status:404"
    error_message = "The 404 catch-all must stay last."
  }
  assert {
    condition     = cloudflare_zero_trust_access_application.laptop_ssh[0].domain == "offline-ssh.tobytran.dev" && cloudflare_zero_trust_access_application.laptop_ssh[0].type == "ssh"
    error_message = "SSH-type Access application on the SSH hostname."
  }
  assert {
    condition     = one(cloudflare_zero_trust_access_policy.laptop_ssh[0].require).email.email == "owner@example.invalid" && cloudflare_zero_trust_access_policy.laptop_ssh[0].decision == "allow"
    error_message = "The policy must require the owner identity."
  }
  assert {
    condition     = cloudflare_zero_trust_access_policy.laptop_ssh_ci[0].decision == "non_identity"
    error_message = "A service token is only honoured by a Service Auth (non_identity) policy; allow answers 403."
  }
  assert {
    condition     = cloudflare_dns_record.tunnel["laptop_ssh"].name == "offline-ssh.tobytran.dev" && cloudflare_dns_record.tunnel["laptop_ssh"].proxied
    error_message = "SSH hostname uses the shared proxied tunnel CNAME."
  }
}

run "enabled_without_owner_identity_fails" {
  command = plan
  variables {
    laptop_ssh_enabled  = true
    laptop_ssh_hostname = "offline-ssh.tobytran.dev"
  }
  expect_failures = [var.laptop_ssh_enabled]
}

run "enabled_without_hostname_fails" {
  command = plan
  variables {
    laptop_ssh_enabled     = true
    laptop_ssh_owner_email = "owner@example.invalid"
  }
  expect_failures = [var.laptop_ssh_enabled]
}
