# Tailscale: the family-app tailnet

Paths are relative to the repository root.

## Which tailnet

- This repository uses one tailnet: the family-app personal tailnet, owned by the repository owner.
- Never touch the owner's employer tailnet from here. Do not reference it, enroll a device in it, call its API, or manage it. A device's current tailnet may be the employer one; do not read it, quote it, or change it.

## Traffic model

- Public traffic goes through the Cloudflare tunnel. It never uses the tailnet.
- The tailnet carries admin and CI SSH only: port 2222 on `tag:family-host`.
- The policy is default-deny: `autogroup:admin` and `tag:ci` may reach `tag:family-host:2222`, nothing else.

## Configuration

- All tailnet configuration is Terraform in `infrastructure/tailscale/`. The operator applies it; CI never does.
- No console edits. No `tailscale` CLI change to the tailnet. No device enrollment from this package.
- Console actions belong to the operator: creating the Terraform credential, and, once the policy is applied, the enrollment credential (scope `auth_keys`, tag `tag:family-host`). Both are recorded in `infrastructure/tailscale/README.md`.
- To add a host, tag, port, or ACL flow: change the Terraform, run `infrastructure/tailscale/run-terraform.sh plan`, and hand `apply` to the operator.

## Credentials

- They live only in Firestore `shared/tailscale` (`TAILSCALE_TAILNET`, `TAILSCALE_TF_OAUTH_CLIENT_ID`, `TAILSCALE_TF_OAUTH_CLIENT_SECRET`, `TAILSCALE_ENROLL_OAUTH_CLIENT_ID`, `TAILSCALE_ENROLL_OAUTH_CLIENT_SECRET`). Read them only through `common/config/family_config.py`, inside the repository scripts.
- Never print, log, echo, or commit a value. Names are fine.
- Never run `tailscale up` on your own initiative.
- Never put an email address, tailnet name, MagicDNS suffix, device name, IP address, or client ID in the repository.

## See also

- Skill `manage-family-tailscale`: the commands, the read-only checks, and the failure modes.
- `infrastructure/tailscale/README.md`: how to apply the policy and mint a host auth key.
