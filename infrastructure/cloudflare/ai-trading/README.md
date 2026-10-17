# ai-trading Cloudflare (Tunnel + staging Workers)

Terraform for the ai-trading tunnel, staging Workers, and DNS. Caddy/Clerk protects every VPS upstream route; Cloudflare Access is deferred for Release 1. This root does not read or apply `infrastructure/cloudflare/zero-trust/`, which remains for a separate future decision. State lives in `gs://tobytran-portfolio-tfstate` under prefix `cloudflare/ai-trading`. The expense tunnel is separate and untouched.

| Hostname | Routes |
|---|---|
| `trading-hub.tobytran.dev` | The hub: `ai-trading-hub-router` Worker serves the static export from GCS and proxies `/u/*` and `/__auth/*` to `trading-origin.tobytran.dev` (tunnel → Caddy `gateway:8080`) (01l) |
| `tradingagents.tobytran.dev`, `ai-hedge-fund.tobytran.dev` | Whole hostname to Caddy `gateway:8080`, whose host block checks the Clerk-backed cookie and serves the terminal at `/` (01l) |
| `mirofish.tobytran.dev` | `ai-trading-mirofish-static` Worker: MiroFish's static UI from GCS, gated on `/__auth/check`; `/api/*` proxied to `mirofish-origin.tobytran.dev` (tunnel → Caddy `gateway:8080`) |
| `trading.tobytran.dev` | With `desk_cutover_enabled=false` (default): interim hub ingress unchanged. With `true`: Desk Worker serves the public static shell from its own GCS bucket; only `/api/desk/*` proxies to `trading-origin.tobytran.dev` → Caddy/Clerk. Other `/api` paths return 404 without a bucket fetch. |
| `vibe-trading.tobytran.dev` | Caddy `gateway:8080` checks the Clerk-backed cookie, then proxies all paths to `vibe-trading:8899`; Vibe's own API key remains required. |

## Token policy

Use the single shared `shared/cloudflare` `CLOUDFLARE_API_TOKEN` described in `ai-trading/AGENTS.md`. It is the same token used by `expense-tax-management`; do not create another one. Permissions may only be broadened, never restricted. If a change needs a permission the token lacks, open the Cloudflare dashboard with the user and add it, then update `shared/cloudflare`'s stored value in Firestore if Cloudflare rotates it (`printf '%s' "$NEW_VALUE" | common/config/family_config.py set shared/cloudflare CLOUDFLARE_API_TOKEN`).

The Cloudflare provider reads `CLOUDFLARE_API_TOKEN` from the environment; no Terraform variable holds the token.

## Apply order

1. `infrastructure/gcp/ai-trading` (identities and static buckets).
2. `infrastructure/cloudflare/ai-trading` (this root). Do not apply `zero-trust` for Release 1.

## Desk Phase 4: two-stage provisioning and cutover (owner-reviewed)

Code preparation does not activate the Desk. Complete Tasks 1–11 and the scoped
release/API deployment before these operator steps. Never apply an unreviewed
plan. The Desk has **no Clerk bundle or publishable-key build variable**.

1. Review/apply the full GCP root first: `desk-bucket.tf` provisions the public,
   versioned `tobytran-portfolio-ai-trading-desk` shell bucket and a bucket-only
   WIF uploader. Bucket naming is `<GCP project>-ai-trading-desk` everywhere:
   GCP `project_id`, workflow `GCP_PROJECT_ID`, and this root's `gcp_project_id`
   already default to the same configured project. No repository bucket setting,
   state read, new permission or additional credential is required.
2. Review/apply this full Cloudflare root with `desk_cutover_enabled=false`.
   It creates `ai-trading-desk-router` and its `STATIC_BUCKET` and `ORIGIN_HOSTNAME`
   bindings, but **no Desk route**. Existing DNS and all interim ingress remain.
   The derived `STATIC_BUCKET` must match GCP's `desk_bucket_name` output. `hub_origin_hostname`
   remains the shared Caddy origin, including the existing `/api/desk/*` gate.
3. From the completed release on `main`, dispatch `ai-trading-deploy.yml` with
   **only** `upload_desk_static=true`. This builds
   `ai-trading/packages/family-desk/frontend/out` and uses the shared transaction
   uploader's explicit `desk` profile. Verify `index.html`, `strategies.html`,
   `404.html`, content types and assets before any cutover. Upload the hub export
   separately (`upload_hub_static=true`) to publish the approved Desk card and
   exact-host login return allowlist. Hub build still uses its existing Clerk key.
4. Persist `TF_VAR_desk_cutover_enabled=true` through `family_config.py` in
   `ai-trading/cloudflare` (not a one-off CLI override that a later infra run
   would undo). Review the **whole** Cloudflare plan, then apply it: the same
   boolean creates `trading.tobytran.dev/*` and removes **only** the four interim
   entries for `hub_hostname`. Terraform coordinates both changes in one apply;
   Cloudflare propagation is not an instantaneous multi-resource transaction.
   No DNS records are removed. Hub, terminal, Vibe, MiroFish and origin routes stay.
5. Run Task 12's live/browser checks: HTML/security headers, `/strategies`, no-session
   and forged-header API 401, hub login return to Desk, signed-in labelled prices,
   and SSE. Record results before declaring Phase 4 done.

Rollback: persist `TF_VAR_desk_cutover_enabled=false`, review/apply this root.
This removes the Desk route and restores all four interim ingress entries.
Keep its bucket, Worker, DNS and origin. Ensure future infra runs use the same
persisted boolean. No manual console changes or targeted applies are needed.

Offline checks (no credentials/backend): `node --test worker/*.test.js`,
`terraform init -backend=false`, `terraform validate`, and `terraform test`.
The last uses mocked providers to check both cutover states and preserved routes.

## Existing infra workflow

`.github/workflows/ai-trading-infra.yml` validates all three Terraform roots on pull requests to `dev`, but on push to `main` or manual dispatch plans (and, with `apply: true`, applies) **only** `cloudflare/ai-trading`, authenticated to GCP via the `ai-trading-terraform` workload identity pool.

No plan artifact is uploaded, because plan files contain variable values and this repository is public.

## Local apply

Install Terraform, or run it in Docker with the repo mounted. For Docker, get `GOOGLE_OAUTH_ACCESS_TOKEN` from `CLOUDSDK_ACTIVE_CONFIG_NAME=personal gcloud auth print-access-token` and pass it with `-e`; pass the Cloudflare token and `TF_VAR_*` values from `family_config.py run` with `-e` as well. Never mount the default gcloud configuration (the work account).

```bash
cd infrastructure/cloudflare/ai-trading
CLI=../../../common/config/family_config.py
$CLI run ai-trading/cloudflare -- \
  terraform init -backend-config="bucket=tobytran-portfolio-tfstate"
$CLI run ai-trading/cloudflare -- terraform plan -out=tfplan
$CLI run ai-trading/cloudflare -- terraform apply -auto-approve tfplan
rm -f tfplan
```

`family_config.py run` adds `CLOUDFLARE_API_TOKEN`, `TF_VAR_cloudflare_account_id`, `TF_VAR_zone_name`, and `TF_VAR_mirofish_bucket_name` from the `ai-trading/cloudflare` Firestore profile. No Access IDP or allowed-email variable is required by this root.

After the first apply, fetch the tunnel token for local/manual use from the Cloudflare API (the deploy workflow does this automatically in `render-env.sh`):

```bash
cd infrastructure/cloudflare/ai-trading
TUNNEL_ID="$(terraform output -raw tunnel_id)"
export TUNNEL_ID
../../../common/config/family_config.py run ai-trading/cloudflare -- bash -c '
  curl -fsS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    "https://api.cloudflare.com/client/v4/accounts/$TF_VAR_cloudflare_account_id/cfd_tunnel/$TUNNEL_ID/token" \
    | jq -r ".result"
'
```
