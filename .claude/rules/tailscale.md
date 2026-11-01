# Tailscale: the family-app tailnet

Paths are relative to the repository root.

## Which tailnet

- This repository uses one tailnet: the family-app personal tailnet, owned by the repository owner.
- Never touch the owner's employer tailnet from here. Do not reference it, enroll a device in it, call its API, or manage it. A device's current tailnet may be the employer one; do not read it, quote it, or change it.

## Traffic model

- The tailnet's production consumer is CI/CD deployment: the GitHub deploy runners join as `tag:ci` and reach `tag:family-host` on port 2222. It is also the break-glass path for a device that is already a member. Nothing else may depend on it.
- Public traffic goes through the Cloudflare tunnel. It never uses the tailnet.
- Operator and break-glass SSH goes through the Cloudflare tunnel behind Cloudflare Access (`cloudflared access ssh`), described in the skill `manage-cloudflare-tunnel`. It does not use the tailnet.
- The policy is default-deny: `tag:ci` and `autogroup:admin` may reach `tag:family-host:2222`, nothing else. The `autogroup:admin` grant is break-glass for a device that is already a member of this tailnet. It is not how the owner reaches the host.
- The owner's own machine is in a different tailnet and is not a member of this one. It must not be enrolled for operator access. Break-glass from it means *switching* it, which is machine-wide and takes the other tailnet away for as long as it lasts: the procedure and its cost are in the skill `manage-family-tailscale`.

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

- Skill `manage-family-tailscale`: the commands, the read-only checks, and the failure modes of the tailnet.
- Skill `manage-cloudflare-tunnel`: tunnel status, turning it on and off, and the operator's SSH path to the host.
- `infrastructure/tailscale/README.md`: how to apply the policy and mint a host auth key.
