output "tunnel_cname_target" {
  value       = "${cloudflare_zero_trust_tunnel_cloudflared.expense_tax.id}.cfargotunnel.com"
  description = "CNAME target shared by all tunnel-managed product hostnames."
}
