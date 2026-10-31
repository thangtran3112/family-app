# 02q — SUPERSEDED by the cross-app laptop-migration plan (infrastructure/plans/0001)

Status: **SUPERSEDED (2026-11-01).** The owner gave the explicit instruction 02q waited for,
and the plan now lives at `infrastructure/plans/0001-laptop-migration.md` (cross-app:
ai-trading AND expense, IaC-first, everything consolidates under `infrastructure/`). This
file stays as history; read 0001 for the real plan.

# 02q — Parked: move family-app production (ai-trading + expense) from the shared VPS to the owner's Ubuntu laptop

Status: **PARKED** (owner decision, 2026-10-25). No work scheduled. The **whole family-app
production stack moves together — ai-trading AND expense — in one coordinated cutover, only
when the owner explicitly requires it.** No session unparks this plan on its own judgment.

## Deadline context

The owner intends to remove the shared VPS by **end of February 2027**. That makes the
unpark deadline-driven: it must start early enough for a calm cutover, but it still begins
only on the owner's explicit instruction.

## Target hardware

- Owner's Ubuntu laptop: Intel i9, NVIDIA RTX 3070 Ti, 40 GB RAM, TB-scale local storage.
- Runs the **whole family-app production stack**: the expense apps AND ai-trading
  (Family Desk backend + Postgres + static web, the Trading Hub, the four upstream apps,
  and the Caddy/Clerk gate). Both apps' Postgres moves together — the Desk's
  `ai_trading_desk_db` currently lives in the shared `expense-tax-postgres` container.

## Networking

- Public access keeps working through the existing **Cloudflare tunnel** (`ai-trading/cloudflare`
  profile; hostnames unchanged — no DNS/Terraform cutover needed beyond tunnel config).
- Admin/SSH access via **Tailscale** (owner-only); the CI deploy paths (`ai-trading/deploy`,
  the expense deploy path, `shared/vps`) repoint to the laptop's SSH target through Tailscale.

## What starts the move

Only an explicit owner instruction ("run 02q" / "start the laptop migration"). Helpful
self-reminders that do NOT start it: a calendar-ish note as February 2027 approaches, or
resource pressure appearing — those should prompt a proposal to the owner, not action.

## Migration sketch (to be detailed when unparked; the laptop must be on for production)

1. Compose parity on the laptop: same images, same env rendering via
   `common/config/family_config.py` (Firestore `family-config` stays the single secret store).
2. Postgres: `pg_dump`/`pg_restore` of both databases (`ai_trading_desk_db` + the expense DB,
   same container today), or logical replication with a short cutover; keep the Desk
   `desk`/`desk_migrator`/`desk_runtime` role split.
3. Cloudflare tunnel: add a tunnel connector on the laptop, cut traffic over, retire the VPS
   connector for all family-app routes.
4. CI: update both packages' deploy targets (SSH host/keys via `shared/vps`) and the deploy
   workflows' secrets; strict host-key checking re-established.
5. Static hosting (GCS buckets + Workers) is untouched — the frontend statics stay cloud-side.
6. Decommission the VPS only after both apps verify clean on the laptop.

## Constraints

- One coordinated cutover for both packages; neither app's sessions migrate the shared
  Postgres or tunnel alone.
- Infrastructure stays as code; no console edits (the one standing exception: the shared
  Cloudflare token's own permission scope).
- No secrets in the repo or on the laptop outside the rendered env pattern.
- The laptop is a laptop: sleep/availability behavior must be decided by the owner before
  production cutover (AC power, lid/sleep settings, wake-on-LAN via Tailscale).

## Relationship to other plans

- Independent of 02o (Practice/Replay) and 02n (Fundamental lane) — those deliver on the VPS.
- 02p is reserved for the future swing-practice amendment; numbering here deliberately skips it.
- The expense sessions must be pointed at this plan before any cutover scheduling.
