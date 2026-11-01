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
| `TAILSCALE_ENROLL_OAUTH_CLIENT_ID` | Enrollment OAuth client ID (`mint-authkey.sh`; created after the first apply) |
| `TAILSCALE_ENROLL_OAUTH_CLIENT_SECRET` | Enrollment OAuth client secret (`mint-authkey.sh`) |

```bash
CLI=common/config/family_config.py
printf '%s' "$VALUE" | $CLI set shared/tailscale TAILSCALE_TAILNET
```

`run-terraform.sh` reads them, exports `TF_VAR_tailnet`, `TF_VAR_tailscale_oauth_client_id` and `TF_VAR_tailscale_oauth_client_secret` for the one terraform process only, and prints nothing. The secret is never in the environment: `family_config.py with-file` writes it to a `0600` temp file and the variable is `file:<path>`, which the provider reads. (`with-file` replaces only an argument that is exactly `{}`, so `env VAR=file:{}` is not substituted; the script re-runs itself with `--secret-file {}` instead, the pattern of `gcp/family-config/install-reader-key.sh`.) If `GOOGLE_OAUTH_ACCESS_TOKEN` is unset it also takes one from the `personal` gcloud configuration, so the GCS backend never uses the work account.

## Console steps (owner)

Two OAuth credentials, created in this order. They cannot be one client: the console grants a tag to an OAuth client only after the policy file declares it in `tagOwners`, so an `auth_keys` client for `tag:family-host` cannot exist before the first apply.

1. **Terraform credential (before the first apply).** In the new tailnet's admin console, open Settings, Trust credentials, and create an **OAuth** credential. Under Policy File, select **Write**. The console then switches on Devices › Core (read) and Posture Attributes by itself, because Policy File requires them. Posture Attributes lands as read and write. The resulting scopes are `policy_file`, `devices:core:read` and `devices:posture_attributes`, and nothing else. Store the client ID and secret as `TAILSCALE_TF_OAUTH_CLIENT_ID` and `TAILSCALE_TF_OAUTH_CLIENT_SECRET` in `shared/tailscale` (above).
2. **Apply** (next section). This publishes `tagOwners`, which creates `tag:family-host` and `tag:ci`.
3. **Enrollment credential (after the first apply).** Create a second **OAuth** credential with scope `auth_keys` and the tag `tag:family-host`. The console offers the tag only once the policy file declares it, which is why this step comes after the apply. Store the client ID and secret as `TAILSCALE_ENROLL_OAUTH_CLIENT_ID` and `TAILSCALE_ENROLL_OAUTH_CLIENT_SECRET` in `shared/tailscale`.
4. For CI, create a third OAuth client with scope `auth_keys` and tag `tag:ci`, and keep its credentials in Firestore too (for example `TAILSCALE_CI_OAUTH_CLIENT_ID` and `TAILSCALE_CI_OAUTH_CLIENT_SECRET`). It is not managed here.

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

This root has no `tailscale_tailnet_key` and no `tailscale_oauth_client`. A host auth key created here would sit in Terraform state as a standing secret long before the laptop exists. Instead `mint-authkey.sh` mints a one-hour, single-use, pre-authorized key tagged `tag:family-host` on demand through the Tailscale API, using the separate enrollment OAuth credential (`TAILSCALE_ENROLL_*`), not the Terraform one. The enrollment and CI OAuth clients are created once by the owner in the console, and their credentials live in Firestore.

## Enroll the host

`mint-authkey.sh` prints the key once on stdout and never writes it to a file, log, or process argument list. Pipe it straight to the host (`tailscale up` accepts `--auth-key=file:<path>`):

```bash
./mint-authkey.sh | ssh <host> 'sudo tailscale up --auth-key=file:/dev/stdin --advertise-tags=tag:family-host'
```

The key expires after one hour or its first use. The request shape comes from Tailscale's OAuth-client documentation (token endpoint, `scope` and `tags` parameters) and the official clients' key-creation call (`capabilities.devices.create`, `expirySeconds`).

## Laptop: sshd on the tailnet port

The policy allows `tcp:2222` only, but the laptop's sshd listens on 22 (`01-family-app-hardening.conf`). Ubuntu 24.04 starts sshd through `ssh.socket`, so a `Port` line alone opens nothing until the socket unit is restarted. On the laptop (keep 22 as the LAN fallback, open 2222 on `tailscale0` only):

```bash
echo 'Port 2222' | sudo tee /etc/ssh/sshd_config.d/02-family-app-tailnet-port.conf
sudo sshd -t
sudo systemctl daemon-reload                    # sshd-socket-generator derives ListenStream from `sshd -T`
sudo ufw allow in on tailscale0 to any port 2222 proto tcp comment 'SSH over tailnet'
sudo systemctl restart ssh.socket               # binds 2222; KillMode=process keeps open sessions
ss -ltn | grep -E ':(22|2222) '                 # both must listen
```

CI and operator deploys reach the host by its MagicDNS name on 2222 (`LAPTOP_HOST` / `LAPTOP_PORT` in the GitHub `production` environment, `VPS_HOST` / `VPS_PORT` in `shared/laptop`). With `StrictHostKeyChecking=yes`, `ssh -p 2222` looks up `[<magicdns-name>]:2222` in the pinned known hosts, so `VPS_SSH_KNOWN_HOSTS` (and its `LAPTOP_DEPLOY_KNOWN_HOSTS` copy) must hold an entry under that name as well as the LAN address.

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
