# 0001g: Post-cutover hardening (backups, monitoring, updates, DR, docs)

Parent: [0001](../0001-laptop-migration.md) §3.7, §7.3. Runs during the [0001e](0001e-cutover.md)
rollback window. Its backup and DR gates are inputs to [0001f](0001f-vps-decommission.md).

**Outcome:** the laptop is a production host with tested backups, alerting, a predictable update
policy, and a written way to rebuild it on any Ubuntu machine.

## Steps

1. **Backups:**
   - Confirm that `family-app-backup.timer` is active on the laptop and that the 00:00 and 12:00
     UTC runs succeed for 3 days.
   - The local marker `/opt/family-app/backup/state/last-success.json` updates.
   - The freshness workflow stays green. It is host-agnostic; no change.
   - Re-check the 512 MiB staging tmpfs against the real dump size (0001d probe). Raise it in
     `family-app-backup.service` if the headroom is under 50%.
2. **Restore drill from laptop-written objects.** Run `infrastructure/backup/recovery-drill.sh`
   (2-hour RTO) into a scratch container on the laptop, using the first monthly object written by
   `family-laptop-1`. The drill passes the same checks as 2026-10-12 (role settings, owners and
   grants, Desk runtime role, alembic head). **Gate for 0001f.**
3. **DR runbook** (Q16): write "rebuild the family host from nothing" into
   `infrastructure/host/README.md`:
   1. Day-0 (0001a Part 1).
   2. `bootstrap.sh` for all steps.
   3. `restore.sh` from GCS.
   4. Temporal.
   5. Dark deploys with `image_tag`.
   6. Connectors, using 0001e step 9 with the old laptop treated as the "VPS".

   Schedule a quarterly drill (owner calendar, not an Actions cron).
4. **Monitoring** (Q14):
   - Apply the `cloudflare_notification_policy` tunnel-health alerts for both tunnels (email to
     the owner), through the normal Terraform paths:
     - `cloudflare/ai-trading` (CI apply on dispatch);
     - `cloudflare/expense-tax` (expense workflow, owner confirmation).
   - Test once: stop the laptop's `expense-tax-cloudflared` for 2 minutes during a quiet hour, and
     confirm the alert arrives and then clears.
   - Desk system alerts (02t §5.4) already cover "IBKR not OK by 09:25 ET" once B1 lands.
5. **Update policy** (Q7):
   - `unattended-upgrades`: security updates only; reboots on the Saturday window only (from
     0001a). Docker Engine and Tailscale updates come through apt on the same cadence.
   - Pinned images (`cloudflared` digest, the Postgres digest) change only through PRs.
   - `caddy:2-alpine` is not digest-pinned today (ai-trading prod compose:188-194). Recommend
     pinning it in the ai-trading lane. Note it for the orchestrator; it is out of scope here.
   - **Kernel or major-OS upgrades** (24.04 to a later version) are owner-scheduled, with a fresh
     backup and a rollback plan. They never run unattended.
6. **Power and network check after 2 weeks:** count unplanned outages from the `journalctl
   --list-boots` gaps and the cloudflared reconnect log. If WiFi drops are frequent, take the
   Ethernet decision (Q8) now rather than at the next incident.
7. **02t B1 seam** (ai-trading lane, when B1 starts):
   - the edge listens on the docker0 address;
   - UFW allows the edge port from the Docker subnets only;
   - the bridge uses `extra_hosts: "ibkr-edge:host-gateway"`;
   - `IBKR_EDGE_URL` is `http://ibkr-edge:<port>`.

   If B1 shipped a sidecar before cutover, remove `bridge-tailscale` and the bridge-to-edge ACL
   rule (0001 §3.4).
8. **Docs reconciliation** (one docs PR, riding the next meaningful phase PR):
   - `infrastructure/README.md`: host-neutral; links `plans/`; backup is live;
   - `infrastructure/host/README.md`: the live layout (cluster at `/opt/family-app/postgres`,
     container `family-app-postgres`, Temporal via `35-temporal.sh`);
   - `ai-trading/deploy/...` READMEs moved in 0001b: the "Moving to a new host" section rewritten
     to point at the DR runbook;
   - orchestrator-owned: `expense-tax-management/plans/ROADMAP.md` (backup status; the "VPS
     Provider Switch" section superseded by this plan), STATUS rows, and marking 02q superseded;
   - public-repo hygiene fixes from 0001 §10.1: the orchestrator decides whether to scrub, now
     that the old address is dead.

## Gates

- [ ] 3 days of successful laptop backups; freshness workflow green
- [ ] Restore drill from a laptop-written object passed (input to 0001f)
- [ ] DR runbook merged; first quarterly drill on the owner's calendar
- [ ] Tunnel-health alert tested end to end for both tunnels
- [ ] Update policy verified across one Saturday reboot
- [ ] Docs reconciled (or listed for the orchestrator)

## Owner-gated items

The alert email destination, the Ethernet and UPS follow-ups, the quarterly drill slot, and the
expense Terraform apply confirmation.

## Rollback

Each step is additive. To undo a step, revert its PR or disable its unit. None of them changes
production data.
