---
name: manage-cloudflare-tunnel
description: Tunnel on/off, site down, SSH to the laptop, travelling - use for the ai-trading Cloudflare tunnel - connector, ingress and public-hostname status, stopping and starting the connector, and the Cloudflare Access SSH path (cloudflared access ssh) for when the owner is away and needs the host. Reads freely; leaves terraform apply, console edits and stopping live traffic to the operator.
---

# Manage the ai-trading Cloudflare tunnel

Rule for the tailnet this path replaces for operators: `.claude/rules/tailscale.md`. Terraform root and apply steps: `infrastructure/cloudflare/ai-trading/README.md`; do not restate them. Paths are relative to the repository root unless they start with `/`.

## The tunnel in one screen

- One tunnel, `ai-trading` (`cloudflare_zero_trust_tunnel_cloudflared.ai_trading`, `config_src = "cloudflare"`). Its ingress lives in Cloudflare and comes from Terraform (`infrastructure/cloudflare/ai-trading/main.tf`), never from a local `config.yml`. The last ingress rule is `http_status:404`.
- Connector: the Compose service `cloudflared` in `infrastructure/apps/ai-trading/docker-compose.yml` (`command: tunnel --metrics 0.0.0.0:2000 run`, `restart: unless-stopped`, networks `hub` and `gateway`). It has **no** `extra_hosts` and **no** host network.
- Token: `/etc/family-app/ai-trading/cloudflared.env` on the host (`TUNNEL_TOKEN=...`, `root:root 0600`). The deploy workflow fetches it from the Cloudflare API with the `ai-trading/cloudflare` Firestore profile (`infrastructure/apps/ai-trading/render-env.sh`) and `deploy.sh` installs it. Nothing else writes it.
- On the host: `/opt/family-app/ai-trading/` holds `docker-compose.yml` and `images.env`; the Compose project is `ai-trading`. Host commands below use this helper (the arguments `deploy.sh` passes, minus the MiroFish overlay, which `cloudflared` does not need):

  ```bash
  cd /opt/family-app/ai-trading
  dc() { sudo docker compose --project-name ai-trading --env-file images.env -f docker-compose.yml "$@"; }
  ```

- Public traffic: Caddy and Clerk gate every public hostname. Cloudflare Access gates exactly one hostname: the SSH one, and only when `laptop_ssh_enabled=true`.
- The tailnet is the CI deploy path today and a break-glass path for a device that is already a member; it is never the operator's normal route. Operator access is the SSH path below. Switching tailnets is described in `.claude/skills/manage-family-tailscale/SKILL.md`.

## Status (read-only)

Host, from `dc` above:

```bash
dc ps cloudflared      # State must read "running"
dc exec -T web node -e "fetch('http://cloudflared:2000/ready').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"; echo "ready exit $?"
dc logs --tail 30 cloudflared
sudo grep -c '^TUNNEL_TOKEN=.' /etc/family-app/ai-trading/cloudflared.env   # prints a count, never the value
```

`ready exit 0` means the connector holds at least one live connection to the edge (the same probe as `tunnel_ready` in `infrastructure/apps/ai-trading/health-check.sh`; `cloudflared` is distroless, so ask from `web`). The grep count must be `1`.

Cloudflare side: tunnel status, connector count, and the ingress Cloudflare actually serves. Same API and `family_config.py run` wrapper as `render-env.sh`. The filters print counts, versions and hostnames only and drop connection origin addresses:

```bash
common/config/family_config.py run ai-trading/cloudflare -- bash -c '
set -Eeuo pipefail
api="https://api.cloudflare.com/client/v4/accounts/$TF_VAR_cloudflare_account_id/cfd_tunnel"
get() { curl -fsS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "$@"; }
id="$(get "$api?name=ai-trading&is_deleted=false" | jq -r ".result[0].id")"
get "$api/$id" | jq "{status: .result.status, connections: (.result.connections | length)}"
get "$api/$id/connections" | jq "[.result[] | {version, conns: (.conns | length)}]"
get "$api/$id/configurations" | jq -r ".result.config.ingress[] | \"\(.hostname // \"-\")  \(.path // \"-\")  \(.service)\""
'
```

- `status` `healthy` with a connector listed: up. `down` or `inactive` with `[]`: no connector connected. `degraded`: some connections are down; read `dc logs`.
- The ingress readback must equal `main.tf`. The last line is `-  -  http_status:404`. An `ssh://` line exists only while `laptop_ssh_enabled=true`.
- Drift against Terraform, read-only (exit 0 none, 2 pending, 1 error; report the exit code and the `Plan:` or `No changes` line only):

  ```bash
  (cd infrastructure/cloudflare/ai-trading && ../../../common/config/family_config.py run ai-trading/cloudflare -- terraform plan -detailed-exitcode); echo "exit $?"
  ```

Public hostnames, from any machine. A bare `curl` carries no session, so a healthy tunnel answers `401` from the Caddy gate:

```bash
for h in tradingagents.tobytran.dev ai-hedge-fund.tobytran.dev vibe-trading.tobytran.dev; do
  printf '%s ' "$h"; curl -sS -o /dev/null -m 10 -w '%{http_code}\n' "https://$h/"
done
```

| Code | Meaning |
|---|---|
| `401`, `302` | Edge, tunnel, connector and Caddy are all answering. Healthy |
| `530` | The edge has no connector for the tunnel (Cloudflare error 1033). Connector down, token bad, or the laptop is off |
| `502`, `503`, `504` | A connector is up but its origin is not: `gateway`, `web`, or the service behind Caddy |
| `404` | The hostname is not in the ingress, so it hit the `http_status:404` rule. Compare the ingress readback with `main.tf` |

The `trading-hub`, `mirofish` and (after cutover) `trading` hostnames are served by Workers, so a `200` there says nothing about the tunnel.

## Turn it off, turn it on

Two levels. They do different things; use the one the goal needs.

| Goal | Level | Public traffic | SSH path |
|---|---|---|---|
| Stop all tunnel traffic now, reversibly | (a) connector | Dead at once: `530` on every tunnel hostname. Worker-served static pages still load, but their `/u/*`, `/__auth/*` and `/api/*` calls fail. Running terminals and Vibe sessions drop | Dead too |
| Close or open the SSH endpoint only | (b) Terraform | Untouched. Connectors pick up a changed ingress without a restart | Closed or opened |
| Change what the tunnel serves | (b) Terraform | Per the plan. The operator reviews every line | Per the plan |

### (a) Connector level, on the host (operator when traffic is live)

Pre-flight for **on**: the token file exists and is non-empty.

```bash
sudo test -s /etc/family-app/ai-trading/cloudflared.env && sudo grep -c '^TUNNEL_TOKEN=.' /etc/family-app/ai-trading/cloudflared.env
```

If that fails, do not write the file by hand. Rerun the `ai-trading-deploy` workflow (`workflow_dispatch`, `deploy_app=true`): `render-env.sh` refetches the token and `deploy.sh` installs it.

```bash
dc stop cloudflared      # off: only the connector; nothing else in the stack moves
dc start cloudflared     # on
dc exec -T web node -e "fetch('http://cloudflared:2000/ready').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"; echo "ready exit $?"
```

- `stop` and `start` leave every other service, network and volume alone. Do not use `down`, a stack-wide `restart`, or `up` of other services.
- The off state does not survive a deploy. A normal `deploy.sh` run starts `cloudflared` again, and its health check fails without the tunnel, so a deploy with the tunnel stopped would roll back. A deploy that must leave the tunnel off is a dispatch with `dark=true` (`DEPLOY_DARK=1`).
- Never stop the connector from an SSH session that arrived through this tunnel. The session dies and nothing can start it again. Use the LAN, or a console on the machine.

### (b) Cloudflare level, Terraform (always the operator's)

The only switches in `infrastructure/cloudflare/ai-trading/` are `desk_cutover_enabled` and `laptop_ssh_enabled`. No flag removes the public hostnames, so level (a) is the off switch for public traffic. Adding one is a Terraform change plus a reviewed plan.

For the SSH endpoint: persist `TF_VAR_laptop_ssh_enabled` (`true` or `false`) in Firestore `ai-trading/cloudflare` with `family_config.py set`, run the status `plan` above, hand the operator the plan summary, and let them apply. A console edit of ingress or Access is never the way.

### Order

- **Everything off:** (a) first, because it kills traffic at once and nothing is live while (b) changes; then (b) if the config itself must change.
- **Everything on:** (b) first, while nothing is live, so Access and ingress exist before the first connection; then (a).
- **SSH only:** (b) alone, with the connector running.

## SSH to the host (Cloudflare Access, not the tailnet)

The operator's machine is in another tailnet and does not join this one. The path is tunnel plus Access.

### The server side

Terraform, all gated on `laptop_ssh_enabled` (default `false`):

- Ingress in `main.tf`: `hostname = var.laptop_ssh_hostname`, `service = "ssh://${var.laptop_ssh_origin}"`, placed before the 404 rule. DNS is the proxied CNAME to the tunnel that `local.tunnel_hostnames` gives every tunnel hostname.
- `infrastructure/cloudflare/ai-trading/laptop-ssh.tf`: a self-hosted Access application on that hostname, and an `allow` policy that `require`s `var.laptop_ssh_owner_email` (and includes it). That variable is empty by default, and the plan refuses to run with the endpoint on and it empty, so the policy can never admit everyone. The tunnel config depends on the application, so the route is never live before Access.
- Values: Firestore `ai-trading/cloudflare` keys `TF_VAR_laptop_ssh_enabled`, `TF_VAR_laptop_ssh_hostname`, `TF_VAR_laptop_ssh_owner_email` (and `TF_VAR_laptop_ssh_origin` only to override). Names only here; read a value with `common/config/family_config.py get ai-trading/cloudflare <KEY>`.

**The connector is a container.** `localhost` in its ingress is the container, never the host, so the origin must be the host as seen from inside it. The default origin is `host.docker.internal:2222`. The compose file as it stands gives `cloudflared` neither route to the host: no `extra_hosts` and no `network_mode: host`. The route to use is `extra_hosts: ["host.docker.internal:host-gateway"]` on the `cloudflared` service. Host networking is not an option: it would drop the `hub` and `gateway` networks that the ingress services (`http://gateway:8080`, `http://web:3000`) and the `cloudflared:2000` health probe depend on. Until that compose change ships through an ai-trading release, the SSH ingress cannot work, whatever Terraform says.

Also required on the host: sshd listens on the origin port, and the firewall admits the connector's bridge subnet to it (`infrastructure/tailscale/README.md` opens `2222` on `tailscale0` only). Test it the way the connector sees it, from the same network:

```bash
docker run --rm --add-host host.docker.internal:host-gateway --network ai-trading_hub busybox nc -zv -w 3 host.docker.internal 2222
```

`open` means the origin works. A timeout is the firewall. `bad address` means the run had no host-gateway mapping.

### The client side (the owner's machine)

Install `cloudflared` (`brew install cloudflared`). `~/.ssh/config`, with the hostname from Firestore and never written into this repository:

```
Host family-laptop
  HostName <ssh-hostname>
  User <laptop-user>
  IdentityFile ~/.ssh/<laptop-key>
  ProxyCommand cloudflared access ssh --hostname %h
```

`%h` expands to `HostName`, so the hostname appears once. (`cloudflared access ssh-config --hostname <ssh-hostname>` prints the same `ProxyCommand` line.)

First use: `ssh family-laptop` opens a browser on the Cloudflare Access login for the hostname. The page offers every identity provider configured on the account (the app's `allowed_idps` is empty): **One-time PIN** (a code to the owner's email; proven) and **Passkeys** (Touch ID). Passkey enrollment is pending the owner's first gesture: no passkey login has been observed, so treat the email PIN as the working path until one succeeds. On a machine with no browser, `cloudflared access login` prints a URL instead. `cloudflared` stores a token locally and reuses it until the Access `session_duration` (168h / 7 days) runs out, then the login repeats. Host key: the first connection asks to trust the key under that hostname; compare it with the laptop's own before answering yes.

### CI deploys (headless)

CI does not use a browser or the tailnet. The runner sets `TUNNEL_SERVICE_TOKEN_ID` and `TUNNEL_SERVICE_TOKEN_SECRET` (Firestore `shared/laptop` `CLOUDFLARE_ACCESS_CI_CLIENT_ID` / `_SECRET`) and runs `ssh -o ProxyCommand="cloudflared access ssh --hostname %h" <user>@<ssh-hostname>`. The same works from any shell. The service token passes only a **Service Auth** (`non_identity`) policy: under `allow` the edge answers `403` and `cloudflared` prints `websocket: bad handshake`. Details: `infrastructure/cloudflare/ai-trading/README.md`, "CI deploys through Access".

One function for `~/.zshrc`. It logs in only when the token is missing or expired, and `-q` keeps the token off the screen:

```zsh
export FAMILY_LAPTOP_SSH_HOST='<ssh-hostname>'   # Firestore ai-trading/cloudflare: TF_VAR_laptop_ssh_hostname
laptop() {
  cloudflared access token "https://$FAMILY_LAPTOP_SSH_HOST" >/dev/null 2>&1 \
    || cloudflared access login -q "https://$FAMILY_LAPTOP_SSH_HOST" || return
  ssh family-laptop "$@"
}
```

`laptop` opens a shell; `laptop 'sudo docker ps'` runs one command.

## Failure modes

| Symptom | Check | Fix |
|---|---|---|
| Connector down: status `down` or `inactive`, public `530` | `dc ps cloudflared`; `dc logs --tail 50 cloudflared` | `dc start cloudflared` after the token pre-flight. Exited with an error: read it first. A deliberate stop (level a) is the operator's to undo |
| Token missing or bad: the container restarts or exits at once, the logs name the token, or `docker compose` reports a missing env file | The `grep -c` in Status prints `0`, or the file is absent | Rerun the `ai-trading-deploy` workflow so `render-env.sh` refetches the tunnel token. Never type a token by hand |
| `502` (`503`, `504`) from the edge | `dc ps` for an unhealthy `gateway` or `web`; the logs name the origin they could not reach | Restart the failing service only. For the SSH hostname the origin is unreachable: run the `busybox nc` test above |
| Access lets the request through but SSH closes (`Connection closed`, `kex_exchange_identification`) | The ingress readback has no `ssh://` line for the hostname (so it hit `http_status:404`), or the `nc` test fails, or sshd is not listening | Missing ingress: `laptop_ssh_enabled`, then `plan`. Origin: add the `extra_hosts` and the firewall rule above, and check `ss -ltn` on the host. `Permission denied (publickey)` is a different problem: the key, not the tunnel |
| `cloudflared access` cannot find credentials, or no Access application protects the hostname | `cloudflared access token "https://<ssh-hostname>"` exits non-zero; `plan` shows the Access application pending | `cloudflared access login -q "https://<ssh-hostname>"`. If `plan` shows the application missing, the operator applies. A browser that never returns means the wrong identity for the policy |
| The hostname resolves but the tunnel does not answer | `dig +short <host>` returns Cloudflare proxy addresses (the CNAME is proxied, so it always does); then `curl` the code and read the table | `530`: the connector row. `404`: the ingress. No answer from `dig`: the DNS record is missing, so `plan` |
| The laptop is off (host unreachable, status `down`, `530`, and CI deploys fail too) | `ping` on the LAN, or look at it; nothing here can start it | Power it on. If Docker starts at boot, `restart: unless-stopped` brings the connector back; otherwise `dc start cloudflared`. No config change is needed |

## Hard boundary

- No console edits for ingress, DNS or Access. Everything is the Terraform root, applied by the operator.
- No agent runs `terraform apply`, `terraform destroy` or a targeted apply. Agents run `plan`.
- Stopping the connector is an operator action whenever traffic is live. Starting it needs the token pre-flight first.
- No secret value in the repository, a log or a commit: not the tunnel token, not an Access token or JWT, not an API token. Print counts, names and status codes. Run `cloudflared access login` with `-q`.
- No email address, IP address, tailnet name, MagicDNS suffix or SSH hostname in the repository. They live in Firestore (`ai-trading/cloudflare`) and arrive as `TF_VAR_*`.
- The owner's machine never joins the family-app tailnet for this. Remote operator access is this skill's path.
