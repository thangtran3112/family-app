---
name: manage-family-tailscale
description: Use when working with the family-app Tailscale tailnet, including applying or changing its policy, minting a host auth key, checking whether a device is on the tailnet, or investigating SSH or CI reachability to the host. Runs only the repository's Terraform wrapper scripts, treats plan and device listing as read-only, and leaves apply, tailscale up, and credential revocation to the operator.
---

# Manage the family-app tailnet

Rule: `.claude/rules/tailscale.md` (in this package). Procedure and Terraform: `infrastructure/tailscale/README.md`; do not restate it. Paths are relative to the repository root.

## Command surface

- `infrastructure/tailscale/run-terraform.sh plan|apply`: the only way to run the Terraform. It reads the credentials from Firestore `shared/tailscale` itself.
- `infrastructure/tailscale/mint-authkey.sh`: mints a host auth key, same credential path. The key is a secret and expires after one hour.
- Never run `terraform` directly. Never export `TAILSCALE_*` values by hand. Never pass a credential on a command line or into a log.

## Agent may (read-only)

- `run-terraform.sh plan`; report the diff and stop.
- List devices through the Tailscale API with the Terraform OAuth credential (read-only `GET`; fetch the credential in-process through `common/config/family_config.py`, never echo it).
- Read the files under `infrastructure/tailscale/`.

## Operator only

- `run-terraform.sh apply`; `mint-authkey.sh` unless the operator asks for it.
- `tailscale up`, `login`, `logout`, or any enrollment; revoking or rotating a credential or key; any console action.
- `tailscale status` or the Tailscale MCP tools on the host report the host's current tailnet, which may be the employer one. They are not evidence about the family-app tailnet.

## Hard boundary

- Never the employer tailnet: no reference, no enrollment, no API call, no management.
- Never a console edit. The only console action is the operator creating the Terraform OAuth credential.
- Never a value in the repository, a log, or a commit: no secret, email address, tailnet name, MagicDNS suffix, device name, IP address, or client ID.
- The host stays in the employer tailnet until the production cutover. Moving it, or running a second tailscaled, belongs to the migration plan; do not decide it here. ai-trading deploys keep their current SSH and Cloudflare path (AGENTS.md "Secrets and Environment Values", \`ai-trading/deploy/\`) until that plan says otherwise.

## Failure modes

- A plan that replaces or destroys the whole policy file: wrong tailnet, or `overwrite_existing_content` missing. Do not apply; tell the operator.
- A host auth key rejected: it expired after one hour. Ask the operator for a fresh one.
- SSH refused on 2222: the ACL does not allow the source, or the host is not tagged `tag:family-host`. Check the plan, then the tag.
- CI cannot join the tailnet: `tag:ci` is missing from `tagOwners`. Fix it in the Terraform and re-plan.
