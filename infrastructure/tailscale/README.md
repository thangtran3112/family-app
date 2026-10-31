# Tailscale (tailnet policy)

Terraform for the family-app tailnet policy file. Tailscale is for **admin and CI SSH only**: public traffic stays on the Cloudflare tunnels and never touches the tailnet. The policy is therefore default-deny and holds exactly two flows, both to the host's sshd (plain sshd on TCP `ssh_port`, default `2222`; no Tailscale SSH, so no `ssh` section):

| Source | Destination | Port |
|---|---|---|
| `autogroup:admin` | `tag:family-host` | `tcp:2222` |
| `tag:ci` | `tag:family-host` | `tcp:2222` |

`tag:family-host` and `tag:ci` are owned by `autogroup:admin`. Operator-applied only: there is no CI apply job, and `.github/workflows/ai-trading-infra.yml` only validates this root on pull requests.

The tailnet is separate from any other tailnet the owner belongs to. Nothing here may name or reference another tailnet, and no tailnet ID, MagicDNS name, device name, or IP is committed: they live in Firestore `shared/tailscale` and reach Terraform as variables.

State: bucket `tobytran-portfolio-tfstate`, prefix `tailscale` (the sibling roots use the path under `infrastructure/`, for example `cloudflare/ai-trading`). The bucket is passed at `init`, as in the sibling roots.

Provider: `tailscale/tailscale` `~> 0.29` (locked at 0.29.3; the lock file carries hashes for linux and macOS on amd64 and arm64).

## Credentials

Firestore group `shared/tailscale` (read only through `common/config/family_config.py`):

| Key | Value |
|---|---|
| `TAILSCALE_TAILNET` | Tailnet ID |
| `TAILSCALE_TF_OAUTH_CLIENT_ID` | Terraform OAuth client ID |
| `TAILSCALE_TF_OAUTH_CLIENT_SECRET` | Terraform OAuth client secret |

```bash
CLI=common/config/family_config.py
printf '%s' "$VALUE" | $CLI set shared/tailscale TAILSCALE_TAILNET
```

`run-terraform.sh` reads them, exports `TF_VAR_tailnet`, `TF_VAR_tailscale_oauth_client_id` and `TF_VAR_tailscale_oauth_client_secret` for the one terraform process only, and prints nothing. The secret is never in the environment: `family_config.py with-file` writes it to a `0600` temp file and the variable is `file:<path>`, which the provider reads. (`with-file` replaces only an argument that is exactly `{}`, so `env VAR=file:{}` is not substituted; the script re-runs itself with `--secret-file {}` instead, the pattern of `gcp/family-config/install-reader-key.sh`.) If `GOOGLE_OAUTH_ACCESS_TOKEN` is unset it also takes one from the `personal` gcloud configuration, so the GCS backend never uses the work account.

## Console steps (owner, once)

1. In the new tailnet's admin console, open Settings, Trust credentials, create an **OAuth** credential for Terraform with scopes:
   - `policy_file` (read and write the policy file). Tailscale lists `devices:core:read` and `devices:posture_attributes` as required with it; select `devices:posture_attributes:read` if the console offers it.
   - `auth_keys`, with tag `tag:family-host`, so `mint-authkey.sh` can mint host keys with the same credential.
2. Store the three values in `shared/tailscale` (above).
3. Ordering caveat (not verified): Tailscale says an `auth_keys` client may use tags "in your tailnet", and `tag:family-host` exists only after the first apply. If the console will not offer the tag yet, create the client with `policy_file` first, apply, then add `auth_keys` with `tag:family-host` (edit the client, or replace it and update Firestore).
4. For CI, create a second OAuth client with scope `auth_keys` and tag `tag:ci`, and keep its credentials in Firestore too (for example `TAILSCALE_CI_OAUTH_CLIENT_ID` and `TAILSCALE_CI_OAUTH_CLIENT_SECRET`). It is not managed here.

## Apply (operator, with the owner's approval)

```bash
cd infrastructure/tailscale
./run-terraform.sh init -backend-config="bucket=tobytran-portfolio-tfstate"
./run-terraform.sh plan -out=tfplan
./run-terraform.sh apply tfplan
rm -f tfplan
```

`overwrite_existing_content = true` replaces the tailnet's whole policy file. `plan` validates the policy against the Tailscale API, so it needs the credentials; `validate` does not. A plan file records variable values (tailnet ID, client ID): never commit or upload it.

## Why no auth key or OAuth client resources

This root has no `tailscale_tailnet_key` and no `tailscale_oauth_client`. A host auth key created here would sit in Terraform state as a standing secret long before the laptop exists. Instead `mint-authkey.sh` mints a one-hour, single-use, pre-authorized key tagged `tag:family-host` on demand through the Tailscale API, using the Terraform OAuth credential. The CI OAuth client is created once by the owner in the console, and its credentials live in Firestore.

## Enroll the host

`mint-authkey.sh` prints the key once on stdout and never writes it to a file, log, or process argument list. Pipe it straight to the host (`tailscale up` accepts `--auth-key=file:<path>`):

```bash
./mint-authkey.sh | ssh <host> 'sudo tailscale up --auth-key=file:/dev/stdin --advertise-tags=tag:family-host'
```

The key expires after one hour or its first use. The request shape comes from Tailscale's OAuth-client documentation (token endpoint, `scope` and `tags` parameters) and the official clients' key-creation call (`capabilities.devices.create`, `expirySeconds`).

## Offline checks

No credentials, network, or terraform binary needed for the script tests:

```bash
bash test-run-terraform.sh
bash test-mint-authkey.sh
```

Terraform checks (Docker works if terraform is not installed):

```bash
docker run --rm -v "$PWD":/w -w /w hashicorp/terraform:latest init -backend=false
docker run --rm -v "$PWD":/w -w /w hashicorp/terraform:latest validate
docker run --rm -v "$PWD":/w -w /w hashicorp/terraform:latest fmt -check -recursive
```
