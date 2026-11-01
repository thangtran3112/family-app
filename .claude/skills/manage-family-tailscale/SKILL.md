---
name: manage-family-tailscale
description: Use for the family-app Tailscale tailnet - checking tailnet or device status, enrolling the host, changing the policy (ACL), minting or debugging a host auth key, "SSH to the host times out", "CI cannot reach the host", or "a device is not showing up". Runs only the repository's Terraform and mint scripts plus read-only API reads; leaves apply, tailscale up, and credential changes to the operator.
---

# Manage the family-app tailnet

Rule: `.claude/rules/tailscale.md` (repository root, shared by both packages). Terraform and console steps: `infrastructure/tailscale/README.md`; do not restate them. Paths are relative to the repository root.

## This tailnet in one screen

- Admin and CI SSH only: `autogroup:admin` and `tag:ci` reach `tag:family-host` on `tcp:2222`. Default deny. Public traffic uses the Cloudflare tunnels and never the tailnet.
- Code: `infrastructure/tailscale/` (`main.tf`, `run-terraform.sh`, `mint-authkey.sh`). The operator applies it; CI never does.
- Credentials: Firestore `shared/tailscale` (`TAILSCALE_TAILNET`, `TAILSCALE_TF_OAUTH_CLIENT_*`, `TAILSCALE_ENROLL_OAUTH_CLIENT_*`), read only through `common/config/family_config.py`. Names only, never values.

## Status (read-only, run unaided)

`run-terraform.sh` runs terraform in the directory it is called from, so `cd` first. Run `init` once per fresh worktree.

```bash
(cd infrastructure/tailscale && ./run-terraform.sh init -backend-config="bucket=tobytran-portfolio-tfstate")
(cd infrastructure/tailscale && ./run-terraform.sh plan -detailed-exitcode); echo "exit $?"
```

Exit 0 means no drift, 2 means changes pending, 1 means error. Report the exit code and the `Plan:` or `No changes` line only.

Device inventory and policy readback, with the Terraform credential (scopes `policy_file`, `devices:core:read`). The token stays in-process, and the output carries tags and grants only, never names or addresses:

```bash
common/config/family_config.py with-file shared/tailscale TAILSCALE_TF_OAUTH_CLIENT_SECRET -- python3 -I -c '
import json,subprocess,sys,urllib.parse as p,urllib.request as r
A="https://api.tailscale.com/api/v2"
g=lambda k:subprocess.check_output(["common/config/family_config.py","get","shared/tailscale",k],text=True).strip()
t=json.load(r.urlopen(A+"/oauth/token",p.urlencode({"grant_type":"client_credentials","client_id":g("TAILSCALE_TF_OAUTH_CLIENT_ID"),"client_secret":open(sys.argv[1]).read().strip()}).encode()))["access_token"]
get=lambda x:json.load(r.urlopen(r.Request(A+"/tailnet/"+g("TAILSCALE_TAILNET")+x,headers={"Authorization":"Bearer "+t,"Accept":"application/json"})))
print([(d.get("tags"),d.get("authorized")) for d in get("/devices")["devices"]])
a=get("/acl"); print(json.dumps({k:a.get(k) for k in ("tagOwners","grants")}))
' {}
```

- Healthy before cutover: the first line is `[]` (no devices); the second lists `tag:family-host` and `tag:ci` in `tagOwners` and exactly two grants on `tcp:2222`.
- Healthy after enrollment: the first line is `[(['tag:family-host'], True)]`.
- The policy readback is the proof the ACL is live. A console screenshot or a green `apply` is not. A missing `tagOwners` means the policy was never applied.
- `tailscale status` and the Tailscale MCP tools report the tailnet of the machine they run on, which may be a different one. They are never evidence about this tailnet.

## Enroll the host (steps 1 to 3 are the operator's)

1. Apply the policy first (README "Apply"), then check the readback: `tagOwners` lists `tag:family-host`.
2. Create the enrollment OAuth credential (scope `auth_keys`, tag `tag:family-host`) and store `TAILSCALE_ENROLL_OAUTH_CLIENT_*`. The console offers a tag only after the policy declares it, so a key minted before step 1 cannot exist.
3. Mint and enroll in one pipe. The key is good for one hour, for one use, printed once and never written to disk:
   `infrastructure/tailscale/mint-authkey.sh | ssh <host> 'sudo tailscale up --auth-key=file:/dev/stdin --advertise-tags=tag:family-host'`
4. Agent: rerun the status readback. Verify the tag through the API rather than by eye: one device, `['tag:family-host']`, authorized `True`.

## Change the ACL

1. Edit `infrastructure/tailscale/main.tf` (and `variables.tf`). A new host, tag, port or flow is a Terraform change, never a console edit.
2. Run the offline checks in the README (`fmt -check`, `validate`), then the status `plan`.
3. Hand `apply` to the operator with the plan summary. Do not apply.
4. After the apply, rerun the readback and compare `grants` with the README table.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| 401 from the API, `plan`, or `mint-authkey.sh` | Credential revoked, or missing a scope (Terraform: `policy_file`, `devices:core:read`; enrollment: `auth_keys` for the tag) | Ask the operator to recreate it in the console and update `shared/tailscale`. Do not retry in a loop |
| `plan` wants to replace or destroy the policy on a tailnet that already has state | Wrong `TAILSCALE_TAILNET`, wrong state prefix, or `overwrite_existing_content` removed from `main.tf` | Do not apply. Read `git diff` on `main.tf`, then tell the operator. A first plan showing 1 to add is normal |
| `tag:family-host` not offered when creating the enrollment credential | The policy was never applied, so `tagOwners` does not declare it | Operator applies it, confirms the readback, then retries |
| Auth key rejected, `tailscale up` fails | Key older than one hour, or already used once | Operator reruns `mint-authkey.sh` and pipes it immediately |
| SSH to the host times out | Default deny drops it: the client is not in this tailnet, or the source is not `autogroup:admin` or `tag:ci` | Expected for a client outside the tailnet. Check `grants` in the readback; for remote access use the Cloudflare Access SSH path above, not a device enrolment |
| SSH refused on 2222 | The packet arrives but the host is untagged, or sshd does not listen on `2222` | Check the device tags in the readback. Re-enroll with `--advertise-tags`. Check sshd |
| CI cannot join | `tag:ci` missing from `tagOwners`, or the CI OAuth client lacks `auth_keys` for `tag:ci` | Fix `main.tf`, `plan`, and hand `apply` to the operator. The CI client is the operator's (README console steps) |
| A device never appears in the inventory | It is signed into another tailnet (one tailnet per tailscaled), or the key came from another tailnet | Ask the operator to check on the machine. Never look at the other tailnet from here |

## Hard boundary

- The employer tailnet is never referenced, enrolled into, or managed from this repository.
- No console edits. The only console actions are the operator creating the OAuth credentials described in the README.
- No secret, tailnet name or ID, MagicDNS suffix, device name, IP, or client ID in the repository, a log, or a commit.
- Never run `terraform` directly, export `TAILSCALE_*` by hand, or pass a credential on a command line.
- `apply`, `tailscale up`, `login`, `logout`, credential revocation or rotation, and enrollment are operator actions. Run `mint-authkey.sh` only when the operator asks.

## Reaching the host from outside this network

A `tailscaled` is signed in to **one tailnet at a time**. Simultaneous membership is an open request upstream (tailscale/tailscale#183), and Tailscale's position there is that account *switching* is the supported path. Switching is not this repository's answer, because the operator's daily machine belongs to another tailnet that its own work depends on.

- **The operator's machine is not a member of this tailnet, and must not become one.** Remote access to the host is a Cloudflare path, not a tailnet path: an `ssh://localhost:<port>` ingress on the host's tunnel, behind a Cloudflare Access application that allows only the owner's identity, reached from a client that runs `cloudflared access ssh` as its SSH `ProxyCommand`. The connector dials outbound, so no inbound port opens and the firewall's `2222/tcp on tailscale0` scoping is untouched, because the connector talks to sshd over loopback.
- **That path is a Terraform change plus a host package, not a client trick**: the ingress line and the Access application and policy go in the same roots that already own the tunnel (`infrastructure/cloudflare/`), and cloudflared runs on the host. Until that is provisioned, the host has no public SSH path, and the only remote access is whatever the migration plan says for that day.
- **Never** enrol a work machine into this tailnet, log a work device out of its own tailnet to test this one, or run a second `tailscaled` on a shared machine without a written decision in the migration plan. If a client cannot reach the host and is not in this tailnet, that is the expected default-deny outcome, not a bug to work around.