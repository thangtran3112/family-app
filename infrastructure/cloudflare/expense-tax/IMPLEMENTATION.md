# Cloudflare Tunnel Implementation Status

Updated: 2026-09-11

## Live

- Terraform manages private Tunnel ingress and five product CNAMEs.
- VPS `cloudflared` systemd service is active; Tunnel has four healthy connectors.
- Clerk DNS is DNS-only: `clerk`, `accounts`, `clkmail`, `clk._domainkey`, `clk2._domainkey`.
- DMARC is managed as `cloudflare_dns_record.clerk_dmarc`:
  `v=DMARC1; p=none; adkim=s; aspf=s`.
- GCS backend: `expense-tax-tobytran-2026-tfstate`.
- Cloudflare Terraform state includes imported Clerk DNS and DMARC records.

## Verification

- Terraform plan: no changes after DMARC import.
- Cloudflare DNS API: DMARC record created and propagated.
- `terraform validate`, format checks, shell checks, and Cloudflare static checks pass.
- Production deploy workflow `34619777986` passed.
- HTTPS product routing and API health checks pass.

## Security

- App ports remain VPS loopback-only.
- Cloudflare provider uses dedicated WIF/state identity; application deploy identity has no state-bucket access.
- VPS bootstrap requires pinned known hosts and strict SSH host-key checking.
- Secrets/tunnel tokens never belong in repository, logs, or command arguments.

## Deferred

- DMARC remains `p=none` during sender reputation warm-up. Review reports before `quarantine`/`reject`.
- Configure a dedicated secondary email provider if Gmail placement remains poor.
