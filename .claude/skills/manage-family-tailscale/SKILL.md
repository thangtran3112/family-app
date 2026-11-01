---
name: manage-family-tailscale
description: Use for the family-app Tailscale tailnet - checking tailnet or device status, enrolling the host, changing the policy (ACL), minting or debugging a host auth key, "SSH to the host times out", "CI cannot reach the host", or "a device is not showing up". Runs only the repository's Terraform and mint scripts plus read-only API reads; leaves apply, tailscale up, and credential changes to the operator.
---

# Manage the family-app tailnet

Rule: `.claude/rules/tailscale.md` (repository root, shared by both packages). Terraform and console steps: `infrastructure/tailscale/README.md`; do not restate them. Paths are relative to the repository root.

## This tailnet in one screen

- CI/CD deployment is its production consumer: the GitHub deploy runners join as `tag:ci` and reach `tag:family-host` on `tcp:2222`. Default deny. The `autogroup:admin` grant is break-glass for a device already in this tailnet. Public traffic uses the Cloudflare tunnels and never the tailnet. Operator SSH is the Cloudflare Access path in skill `manage-cloudflare-tunnel`.
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
| SSH to the host times out | Default deny drops it: the client is not in this tailnet, or the source is not `autogroup:admin` or `tag:ci` | Expected for any client that is not `tag:ci` or an existing member: the owner's machine is not in this tailnet and must not join it. Operator access is the Cloudflare Access SSH path in skill `manage-cloudflare-tunnel`, not a device enrolment. For CI, check `grants` in the readback |
| SSH refused on 2222 | The packet arrives but the host is untagged, or sshd does not listen on `2222` | Check the device tags in the readback. Re-enroll with `--advertise-tags`. Check sshd |
| CI cannot join | `tag:ci` missing from `tagOwners`, or the CI OAuth client lacks `auth_keys` for `tag:ci` | Fix `main.tf`, `plan`, and hand `apply` to the operator. The CI client is the operator's (README console steps) |
| A device never appears in the inventory | It is signed into another tailnet (one tailnet per tailscaled), or the key came from another tailnet | Ask the operator to check on the machine. Never look at the other tailnet from here |

## Hard boundary

- The employer tailnet is never referenced, enrolled into, or managed from this repository.
- No console edits. The only console actions are the operator creating the OAuth credentials described in the README.
- No secret, tailnet name or ID, MagicDNS suffix, device name, IP, or client ID in the repository, a log, or a commit.
- Never run `terraform` directly, export `TAILSCALE_*` by hand, or pass a credential on a command line.
- `apply`, `tailscale up`, `login`, `logout`, credential revocation or rotation, and enrollment are operator actions. Run `mint-authkey.sh` only when the operator asks.

## Break-glass: switching this Mac onto this tailnet

A `tailscaled` is signed in to **one tailnet at a time**. Simultaneous membership is an open request upstream (tailscale/tailscale#183), and Tailscale's position there is that account *switching* is the supported path. The owner's Mac belongs to another tailnet whose own work depends on it, so switching is the exception, not the routine: the Cloudflare Access path in `manage-cloudflare-tunnel` is the normal way in.

Switch, in this order, and switch back when done:

```bash
ts-switch                       # list the signed-in tailnets; shows the active one
ts-switch family                # the owner's personal tailnet (the one this repo uses)
ssh <host>                      # MagicDNS name; the host is tag:family-host
ts-switch chartflow             # back to the other tailnet when finished
```

`ts-switch` is a shell function in the owner's `~/.zshrc`: it picks the profile by account, runs `tailscale switch` (alpha, present in 1.104.2), re-applies the macOS resolver fix, and prints the tailnet it landed on. It also refuses politely when the target profile was never signed in on that machine — a first switch to this tailnet needs one interactive `tailscale login` on it, which is the operator's action.

- The other tailnet is unreachable for as long as the switch lasts; anything on the Mac that rides it stops working. Say so before switching on a machine that someone is using.
- The family host answers on its MagicDNS name only while the Mac is on this tailnet, and only for `autogroup:admin` (the grant in `main.tf`). A timeout after a successful switch is a policy or tag problem, not a DNS one.
- **Never** enrol the other tailnet's device into this one, log it out of its own tailnet to test this one, or run a second `tailscaled` on it without a written decision in the migration plan. Switching is reversible in one command; enrolment is not.
- Switching is also what CI does not do: the runners join as `tag:ci` through their own OAuth credential and never touch a human's machine.
