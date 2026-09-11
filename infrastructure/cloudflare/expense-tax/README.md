# Expense Tax Cloudflare Tunnel

Terraform manages one remotely configured Cloudflare Tunnel and five public
hostnames. cloudflared runs on an already reachable Ubuntu VPS and exposes no
public ports; it connects outbound to Cloudflare.

## Host routing

| Host | VPS origin |
|---|---|
| `expense.tobytran.dev` | `127.0.0.1:7301` (Capture primary) |
| `expense-api.tobytran.dev` | `127.0.0.1:8100` (API/webhook) |
| `expense-capture.tobytran.dev` | `127.0.0.1:7301` (Capture) |
| `expense-office.tobytran.dev` | `127.0.0.1:7302` (Office) |
| `expense-foundry.tobytran.dev` | `127.0.0.1:7303` (Foundry) |

`expense-clerk.tobytran.dev` is reserved for Clerk's custom Frontend API CNAME.
It is DNS-only and is not created or managed by this Tunnel module.

## Cloudflare token

Use a narrowly scoped API token with:

- Account: **Cloudflare Tunnel Edit** for target account
- Zone: **DNS Edit** for `tobytran.dev`

Provide token through `TF_VAR_cloudflare_api_token` or CI environment secret.
Never put token in `.tfvars`, command arguments, logs, or committed files.

## State bootstrap and Terraform

State bucket name is deterministic: `expense-tax-tobytran-2026-tfstate`.
Bootstrap requires authenticated gcloud and grants existing deploy service
account object admin. This command mutates GCP only when deliberately run by an
operator; it was not run as part of this change.

```bash
cd /Users/toby.tran/personal/family-app
gcloud auth application-default login
./infrastructure/cloudflare/expense-tax/bootstrap-state.sh

cd infrastructure/cloudflare/expense-tax
terraform init \
  -backend-config="bucket=expense-tax-tobytran-2026-tfstate"
terraform fmt -check
terraform validate
terraform plan \
  -var="cloudflare_account_id=${CLOUDFLARE_ACCOUNT_ID}" \
  -var="cloudflare_api_token=${CLOUDFLARE_API_TOKEN}"
terraform apply \
  -var="cloudflare_account_id=${CLOUDFLARE_ACCOUNT_ID}" \
  -var="cloudflare_api_token=${CLOUDFLARE_API_TOKEN}"
```

Use `terraform output -raw tunnel_token > ~/.config/cloudflared/expense-tax.token`
only after apply, then immediately enforce `chmod 600` and do not print the
file. Terraform state contains sensitive tunnel material and must stay in GCS.

## VPS token installation

From repository root, with local token file mode `0600`:

```bash
./infrastructure/vps/bootstrap-cloudflared.sh \
  --host 158.69.202.250 \
  --user ubuntu \
  --key ~/.ssh/id_ed25519_personal \
  --ssh-port 2222 \
  --tunnel-token-file ~/.config/cloudflared/expense-tax.token
```

The script installs cloudflared from Cloudflare's official apt repository,
writes `/etc/cloudflared/expense-tax-tunnel.token` with mode `0600` through
stdin, installs a token-file systemd unit, enables/restarts it, and verifies
active status. It never prints token content. Keep VPS firewall inbound policy
closed for application ports; Tunnel traffic is outbound.

## Migration to a new VPS

1. Provision reachable Ubuntu VPS and complete existing `infrastructure/vps/bootstrap.sh` SSH/Docker/Postgres steps.
2. Apply this Terraform module only if Tunnel hostnames or ingress need changes; the remotely managed Tunnel identity remains in Cloudflare state.
3. Export sensitive `tunnel_token` directly to a local `0600` file without printing it.
4. Run `bootstrap-cloudflared.sh` against new host and verify systemd active status.
5. Verify all five HTTPS hostnames and API/webhook health checks.
6. Stop and remove cloudflared service from old VPS after new VPS is healthy; do not rotate DNS because CNAMEs target Tunnel UUID, not VPS IP.
