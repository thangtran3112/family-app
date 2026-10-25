# 02q — Parked: move ai-trading production from the shared VPS to the owner's Ubuntu laptop

Status: **PARKED** (owner decision, 2026-10-25). No work scheduled. This plan exists so the
trigger, scope, and steps are already agreed when the unpark moment arrives.

## Why parked

The current shared VPS comfortably serves the Desk MVP and the Practice/Replay workload
(replay data cache is tens of MB per month of practice; images and Postgres are unaffected).
The migration must not gate the Family Desk roadmap.

## Target hardware

- Owner's Ubuntu laptop: Intel i9, NVIDIA RTX 3070 Ti, 40 GB RAM, TB-scale local storage.
- Runs the **ai-trading stack only**: Family Desk (backend + Postgres + static web), the
  Trading Hub, the four upstream apps, and the Caddy/Clerk gate.
- The expense stack stays on the shared VPS unless the expense sessions decide otherwise.

## Networking

- Public access keeps working through the existing **Cloudflare tunnel** (`ai-trading/cloudflare`
  profile; hostnames unchanged — no DNS/Terraform cutover needed beyond tunnel config).
- Admin/SSH access via **Tailscale** (owner-only); the CI deploy path (`ai-trading/deploy`,
  `shared/vps`) repoints to the laptop's SSH target through Tailscale.

## Trigger to unpark (any of)

1. VPS resource pressure: disk, CPU, or Postgres growth from replay/consensus history and
   market-data accumulation.
2. Desire for local GPU work (RTX 3070 Ti) — e.g. on-device models for AI features.
3. Ownership/cost simplification when the owner is ready to run the stack at home full-time.

## Migration sketch (to be detailed when unparked)

1. Compose parity on the laptop: same images, same env rendering via
   `common/config/family_config.py` (Firestore `family-config` stays the single secret store).
2. Postgres: `pg_dump`/`pg_restore` of `ai_trading_desk_db` (or logical replication with a
   short cutover); keep the `desk`/`desk_migrator`/`desk_runtime` role split.
3. Cloudflare tunnel: add a tunnel connector on the laptop, cut traffic over, retire the VPS
   connector for ai-trading routes only.
4. CI: update `ai-trading/deploy` target (SSH host/keys via `shared/vps`) and the deploy
   workflow's secrets; strict host-key checking re-established.
5. Static hosting (GCS buckets + Workers) is untouched — the frontend statics stay cloud-side.
6. Decommission only ai-trading's containers/volumes on the VPS (never a global prune; the
   expense stack keeps the host).

## Constraints

- Infrastructure stays as code; no console edits (the one standing exception: the shared
  Cloudflare token's own permission scope).
- No secrets in the repo or on the laptop outside the rendered env pattern.
- Cloudflare/Tailscale credential handling follows the existing profiles; nothing new is
  committed.

## Relationship to other plans

- Independent of 02o (Practice/Replay) and 02n (Fundamental lane) — those deliver on the VPS.
- 02p is reserved for the future swing-practice amendment; numbering here deliberately skips it.
