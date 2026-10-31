# 0001e: Cutover (one coordinated move of both apps)

Parent: [0001](../0001-laptop-migration.md) §3.2, §6, §7. Needs every [0001d](0001d-data-migration-validation.md)
gate green, plus the owner's chosen date. Next: the rollback window, then
[0001f](0001f-vps-decommission.md).

**Outcome:** every public hostname is served from the laptop, with data identical to the VPS at
the freeze. The VPS stays intact, stopped, and ready for rollback.

## Timing

- **When.** A weekend (Q15).
- **Avoid:**
  - US market hours;
  - the backup runs at 00:00 and 12:00 UTC (each with 15 minutes of jitter);
  - the expense 02:00 mailbox scan (check its timezone in the Temporal schedule);
  - month-end.
- **Freeze budget.** 60 minutes or less in total, as measured in 0001d Rehearsal C. The copy
  part is 30 minutes or less (Gate B).
- **People.** The agent drives. The owner is present: for the go/no-go call, to sign in with
  Clerk on both apps, and to tell the family.

## T-7 days to T-1 day

1. 0001d Rehearsal C passed. The runbook timings are in 0001d.
2. **Deploy freeze notice.** From T-1 until the rollback window closes, no merges to `main` for
   either package except the cutover PR below. The orchestrator posts this in `STATUS.md`.
3. **Cutover PR prepared, not merged.** It contains:
   - the push default `target=laptop` in both deploy workflows;
   - the `ai-trading/deploy` links repointed to `shared/laptop`. This is a Firestore change,
     applied in step 9, not in git.
4. **Dark stacks on the laptop are at the same image tags as the VPS.** Re-dispatch the dark
   deploys if needed.
5. If the volumes use the warm-rsync path (0001d Gate B), run the warm pre-copy at T-2.
6. **Capture the pre-freeze evidence**: `pg-parity.sh vps` and `vol-manifest.sh` for every
   volume. This baseline is for diffing only.

## T-0: the sequence

**Warning: steps 2–8 are the write freeze. Public apps answer with errors during it.** Follow the
steps in order. Do not overlap them.

1. **Go/no-go** (owner):
   - laptop healthy (dark);
   - VPS healthy;
   - no deploy running in either workflow;
   - weather and power fine at home.
2. **Stop writers on the VPS**, in this order:
   1. ai-trading: `docker compose -p ai-trading stop`, **except `cloudflared`**. Users see 502s
      from the gateway, which is acceptable for the freeze.
   2. expense: stop `workflow-worker` first, then the rest of `expense-tax-production`.
   3. Temporal: `docker compose -p temporal stop` (or its directory's project).
3. **Final VPS backup.** Run `sudo systemctl start family-app-backup.service` and wait for
   success. Postgres is still up and quiescent, so this is the safety net. Then run
   `sudo systemctl disable --now family-app-backup.timer family-app-backup-retry.service`.
4. **Stop Postgres on the VPS.** Run `docker compose -p postgres stop`. Do not remove the
   container or its volumes; the data dir stays as the rollback copy.
5. **Copy:**
   - Postgres data dir to the laptop's `/opt/family-app/postgres/data` (or the path
     `30-postgres.sh` uses) with `relay-copy.sh`;
   - every ai-trading volume (9), `control.json`, and the expense `storage` and `inbound`
     volumes, with `relay-copy.sh`, or the final rsync delta.
6. **Start on the laptop:**
   1. Stop the dark stacks.
   2. Swap in the copied data dir. Run `30-postgres.sh --data-from-copy`: same image digest, no
      initdb, no role scripts.
   3. Start Postgres.
7. **Parity** (gate; no flip without it):
   - `pg-parity.sh laptop` diffed against the frozen VPS state (`pg-parity.sh vps` taken right
     after step 2): **must be empty**;
   - `vol-manifest.sh` equal for every volume;
   - `control.json` hash equal.
8. **Bring up the apps on the laptop through CI, in full mode.** Each dispatch uses
   `image_tag=<current tag>` (the 0001b input), so there is no build and the timing is the one
   measured in Rehearsal C.
   1. Temporal: `35-temporal.sh` up (operator over SSH); the `expense-tax` namespace present.
   2. expense: dispatch `expense-tax-deploy.yml` with `target=laptop`, `dark=false` and
      `image_tag`. The owner confirms. The worker starts and schedules resume.
   3. ai-trading: dispatch `ai-trading-deploy.yml` with `target=laptop`, `dark=false` and
      `image_tag`. **This starts `cloudflared` on the laptop.** The laptop becomes a second
      ai-trading tunnel replica at this point. The VPS's ai-trading origins are stopped, so its
      replica returns errors until step 9.2. Accept that.
   4. Both health checks green. The ai-trading check now includes `cloudflared:2000/ready`.
9. **Flip the connectors:**
   1. expense: run `infrastructure/host/bootstrap-cloudflared.sh` against `shared/laptop`. It
      installs the unit and the token (the token comes from the Terraform output, as today).
      Wait for `cloudflared` "Registered tunnel connection" ×4.
   2. **Immediately** stop the VPS connectors:
      - `docker compose -p ai-trading stop cloudflared` on the VPS;
      - `sudo systemctl disable --now expense-tax-cloudflared` on the VPS.

      Until this step, requests that land on a VPS connector hit stopped origins. That lasts a few
      seconds for expense and a few minutes for ai-trading.
   3. Firestore: repoint the `ai-trading/deploy` links to `shared/laptop`.
   4. Update the expense GitHub copies (the default target).
10. **Verify publicly** (from outside the home network, for example a phone on cellular):
    - ai-trading: `trading-hub` (Worker to `trading-origin`), `trading`, `vibe-trading`,
      `tradingagents`, `ai-hedge-fund`, and `mirofish` if active. Expect an unauthenticated gate
      response.
    - Then the **owner signs in with Clerk**: the hub loads; a Desk page reads data (watchlist
      and practice list present); a TradingAgents terminal opens; Vibe answers; Settings shows the
      same app on/off states.
    - expense: `expense` / `expense-capture` (sign in, list recent expenses: the newest entry from
      before the freeze is present), `expense-api` health, `expense-office`, `expense-foundry`,
      `expense-mailbox` (the OAuth begin route returns a redirect, not a 5xx).
    - Temporal UI over the tailnet: the `expense-tax` namespace, schedules listed, the worker
      polling.
    - `cloudflared tunnel info`, or the dashboard read-only: connectors only from the laptop.
11. **Backups on the laptop.** Run `bootstrap.sh --only backup` with `BACKUP_HOST_ID=family-laptop-1`.
    Then `systemctl start family-app-backup.service` and check that the new object is in the
    bucket.
12. **Merge the cutover PR.** Its push-triggered ai-trading deploy is the **first CI deploy to the
    laptop**, a no-op redeploy at the same tag. It must pass. The expense first CI deploy rides
    its next release. Optionally, dispatch with `target=laptop` now, with owner confirmation.
13. **Announce** the end of the freeze to the family. The rollback window opens.

## Rollback criteria (any one triggers it during the 14-day window)

- A public hostname fails for more than 15 minutes, and the cause cannot be fixed forward within
  that time.
- A parity or integrity defect: a missing expense, receipt or Desk record; a migration head
  mismatch.
- More than two unplanned laptop outages (power, network or OS) in the window. A single outage
  under 15 minutes is noted, not a trigger.
- The owner's call, for any reason.

## Rollback procedure (reverse copy, so no data written on the laptop is lost)

1. Freeze writers on the laptop (same order as T-0 step 2), run a final laptop backup, and stop
   laptop Postgres.
2. If **no writes** happened on the laptop since cutover (rare), skip to step 3. Otherwise,
   `relay-copy.sh` the laptop data dir and the volumes back to the VPS paths. Do not use rsync
   deltas onto the frozen VPS data; it is a full copy.
3. On the VPS: start Postgres, run `pg-parity.sh vps` against the laptop's final state (empty
   diff), then start Temporal, expense and ai-trading. Re-enable the backup timer.
4. Connectors: start the VPS connectors, then stop the laptop ones (step 9 in reverse).
5. Firestore links back to `shared/vps`; the workflow default back to `vps` (revert the cutover
   PR); the GitHub copies back.
6. Write the cause into this file and fix it before the next attempt.

## Gates (close the cutover)

- [ ] Step 7 parity: empty diff
- [ ] Step 10: every hostname and every listed flow verified by the owner
- [ ] Step 11: first laptop backup object present
- [ ] Step 12: first CI deploy to the laptop green
- [ ] VPS: all stacks stopped, connectors disabled, backup timer disabled, data intact

## Owner-gated items

Go/no-go, the Clerk sign-ins and flow checks, the family announcement, any rollback decision, and
the expense dispatch confirmation.
