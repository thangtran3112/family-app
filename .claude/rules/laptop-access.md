---
paths:
  - infrastructure/**
  - .github/workflows/**
  - ai-trading/**
---

# Ubuntu laptop (production host): access and deployment

- **Normal access is the home LAN** (192.168.1.x). Discover the host with a LAN scan; SSH as
  `family-app` with the `shared/laptop` `VPS_DEPLOY_SSH_PRIVATE_KEY` (port 22). Inspection
  (read-only) over the LAN is always fine.
- **Never use Tailscale to reach the laptop.** Tailscale is the break-glass fallback *for*
  Cloudflare tunnel SSH only, and only when the owner explicitly says to use it (e.g. off-LAN).
- **Cloudflare tunnel SSH** (`cloudflared access ssh`) only on explicit owner instruction.
- **Changes on the laptop go through infrastructure-as-code or CI/CD — never ad-hoc.** A
  deployment or config change runs the repo's own scripts (the `deploy.sh` procedure, the
  `infrastructure/` tree) or a merged PR triggering the deploy workflow. Unwritten manual
  deployment is forbidden.
- A **one-time manual action** is allowed only when the IaC/CI path is genuinely unavailable,
  must run the repo's own script (not improvised commands), and must be announced to the owner
  before running.
