# 0001c: Staging bring-up (both stacks dark on the laptop, beside VPS production)

Parent: [0001](../0001-laptop-migration.md) §3, §6. Needs [0001a](0001a-laptop-bootstrap.md) and
[0001b](0001b-iac-consolidation.md) (both parts) merged. Next:
[0001d](0001d-data-migration-validation.md).

**Outcome:** the laptop runs the full production container set, deployed by the real CI path.
Nothing on it takes public traffic, sends a message, or runs a schedule.

## Safety rules for the whole phase

1. **No tunnel connector on the laptop.**
   - The ai-trading `cloudflared` is excluded by `DEPLOY_DARK=1`.
   - The expense `expense-tax-cloudflared` unit is **not** installed.
   - Any connector with a production tunnel token becomes a live replica (0001 §3.2).
   - Check after every deploy: `docker ps --format '{{.Names}}' | grep -c cloudflared` must print
     `0`, and `systemctl list-units 'expense-tax-cloudflared*'` must list nothing.
2. **No side effects.**
   - The Desk `scheduler` is excluded (alerts, premarket pass, Alpaca polling).
   - The expense `workflow-worker` is excluded, so Temporal schedules (including the daily 02:00
     mailbox scan) queue and never run.
   - MiroFish stays off (`MIROFISH_ACTIVATE=0`).
3. **Data in staging is either empty or a rehearsal copy** from [0001d](0001d-data-migration-validation.md).
   It is never written back to production.

## Steps

1. **Shared Postgres.** Run `bootstrap.sh --only postgres` against `shared/laptop`:
   - `30-postgres.sh` in fresh-init mode: an **empty** cluster with the same image digest as the
     VPS, project `postgres`, network `postgres_default`, container `family-app-postgres`;
   - apply both app role scripts (`host/apps/*.conf`) so every DB and role exists:
     `expense_tax_db`, `ai_trading_desk_db`, and through the expense operator scripts `temporal`,
     `temporal_visibility` and `mailbox_vault`;
   - role passwords: **use the same values as production.** They are read from Firestore (the
     app `ops` profiles and `shared/vps-postgres`), so the production DB URLs in Firestore work
     unchanged. Never print them.
2. **Shared network.** Create `family_shared` (`docker network create family_shared`; done by
   `35-temporal.sh`).
3. **Temporal.** Run `bootstrap.sh --only temporal` (`35-temporal.sh`): stage, render
   `temporal.env`, run `compose up -d`, create the `expense-tax` namespace. Check:
   `family-temporal` is healthy, and the namespace is listed.
4. **App controls.** Nothing extra is needed. `ai-trading-deploy.yml` runs
   `host/app-controls/install.sh` on every deploy (UID/GID 22001, `/var/lib/family-app/ai-trading`,
   `/run/family-app`).
5. **ai-trading dark deploy.** Dispatch `ai-trading-deploy.yml` with `target=laptop`, `dark=true`,
   `activate_mirofish=false`, and `image_tag=<current production tag>`. That deploys the same
   images as the VPS and skips the build (Actions-minutes rule). Check:
   - the runner joined the tailnet as `tag:ci` and left afterwards (the device list shows no
     stale `tag:ci` nodes);
   - strict host-key SSH succeeded with `shared/laptop`;
   - `deploy.sh` rendered profiles with the **laptop's** reader key;
   - the free-disk guard passed on the large partition;
   - `alembic upgrade` ran against the empty `ai_trading_desk_db`;
   - `health-check.sh` (dark) is green.
6. **expense dark deploy.** Dispatch `expense-tax-deploy.yml` with `target=laptop` and
   `dark=true`. **Owner confirms the dispatch at execution time** (expense AGENTS.md). Check:
   - migrations ran on the empty `expense_tax_db` and `mailbox_vault`;
   - loopback health on ports 8100, 8200, 7301, 7302, 7303 and 8300;
   - `require_shared_temporal` passed;
   - `workflow-worker` is not running.
7. **Port and collision audit.**
   - `ss -ltnp`: every listener is on `127.0.0.1` or on Docker-internal addresses, apart from sshd
     on the tailnet.
   - `sudo ufw status verbose` matches 0001a.
   - No `0.0.0.0` publishes: Docker bypasses UFW, so this matters.
8. **Route probes over the tailnet** (operator machine, `ssh -L` port forwards):
   - ai-trading: forward to the `gateway` container's 8080 through a throwaway
     `docker run --network ai-trading_gateway curlimages/curl` on the host, or with
     `ssh -L 18080:<gateway-ip>:8080`. Send each production `Host:` header (`vibe-trading`,
     `tradingagents`, `ai-hedge-fund`, `trading-origin`, `mirofish-origin`) and expect the Clerk
     gate's unauthenticated response (redirect or 401), not a 5xx. `web:3000` should answer 200.
   - Desk: `api` `/healthz` from inside the `gateway` network.
   - expense: `curl -fsS 127.0.0.1:{8100,8200,7301,7302,7303,8300}/<health paths from
     health-check.sh>` on the host.
9. **Resource baseline.** Record `docker stats --no-stream`, `free -h` and
   `df -h /var/lib/docker` with the dark set running. Compare with 0001 §3.6.
10. **Burn-in.** Leave the dark stacks running for **at least 72 hours**, including one Saturday
    reboot window. After a reboot, every container and unit comes back with no human action:
    TPM unlock, `unless-stopped`, enabled units, tailnet rejoined.

## Gates

- [ ] Both dark deploys green through CI with `target=laptop`
- [ ] Zero cloudflared processes or units on the laptop; zero `scheduler` or `workflow-worker`
      containers
- [ ] Route probes as expected for every hostname above
- [ ] RAM and disk inside the 0001 §3.6 budget
- [ ] 72-hour burn-in with one unattended reboot: full recovery, no human action
- [ ] VPS production unaffected throughout (its deploys still use `target=vps`)

## Owner-gated items

The expense dispatch confirmation; watching the burn-in reboot (optional).

## Rollback

Production is untouched. To reset staging, run `docker compose down` per project on the laptop,
remove the `postgres` data dir, and re-run the steps.
