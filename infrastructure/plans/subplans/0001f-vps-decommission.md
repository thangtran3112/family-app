# 0001f: VPS decommission and final archive

Parent: [0001](../0001-laptop-migration.md) §1, §6.2. Needs the 14-day rollback window from
[0001e](0001e-cutover.md) closed with no rollback, and the [0001g](0001g-post-cutover-hardening.md)
backup gates green. Deadline: done by **2027-01-31** (Q15), well before the end-of-February 2027
removal.

**Outcome:**
- the VPS is gone;
- nothing in Firestore, GitHub, GCP or the repo still points at it;
- one final, verified archive of its state exists in the backup bucket.

## Steps

1. **Exit check** (owner):
   - 14 days with no rollback trigger (0001e criteria);
   - laptop backups fresh every day (the freshness workflow never paged);
   - one restore drill from laptop-written objects passed (0001g step 2).
2. **Final archive.** The final VPS backup ran at the 0001e freeze (T-0 step 3). Additionally,
   take a one-time cold archive of the **frozen** VPS Postgres data dir and volumes, so the
   pre-cutover state stays recoverable after the server is gone:
   - stream `tar | zstd | age -r <BACKUP_AGE_RECIPIENT>` to `gs://<backup bucket>/archive/vps-final/`
     with `--if-generation-match=0`;
   - the backup writer SA can create objects, so the same identity works;
   - **owner decision:** a lifecycle exception for `archive/`. The default `daily/` and
     `monthly/` rules do not touch `archive/`. Recommend keeping it 365 days, managed in
     Terraform as a lifecycle rule in `gcp/backup`.
   - Verify: list the object, then run a test decrypt of its header with the age identity on the
     operator machine.
3. **Revoke credentials and access:**
   1. Delete the VPS's `family-config-reader` key: `gcloud iam service-accounts keys list`, then
      delete **only the VPS key id**. Run it under `CLOUDSDK_ACTIVE_CONFIG_NAME=personal`.
   2. Remove the VPS deploy and operator public keys from any `authorized_keys` that still list
      them. The laptop uses new pairs, so none should.
   3. Shred the VPS's copies of `/etc/family-app/*` and `/etc/cloudflared/*` before the wipe:
      `sudo shred -u` on the key files.
4. **Firestore** (names only):
   - delete `shared/vps` (all keys);
   - make sure nothing links to it: `family_config.py ls` and `describe` on every profile.
     `ai-trading/deploy` was repointed at cutover;
   - keep `shared/vps-postgres` and `shared/vps-backup`. They describe the cluster and the bucket
     (0001 Q3).
5. **GitHub:**
   - delete the expense env copies `VPS_DEPLOY_SSH_KEY` and `VPS_DEPLOY_KNOWN_HOSTS`, and the vars
     `VPS_HOST`, `VPS_PORT` and `VPS_USER`;
   - rename the `LAPTOP_*` copies to host-neutral names only if the workflows change in the same
     PR. Otherwise leave them.
6. **Repo cleanup PR.** This is small and rides the next meaningful phase PR (CI-minutes rule):
   - remove the `target: vps` option and the `shared/vps` branches from both deploy workflows;
   - update `infrastructure/host/README.md` (exists after 0001b),
     `ai-trading` production README "Moving to a new host", and `infrastructure/README.md` to
     describe the laptop as the host, and the bootstrap-plus-restore flow as the way to replace it;
   - remove OVH and VPS wording from the SA display names (already done in 0001b) and from docs
     where it is now false. Historical plans keep their text.
7. **Server wipe and cancel** (owner, in the OVH account; no API in this repo):
   - Reinstall or wipe from the OVH panel. This is a provider action with no IaC here, and the
     server is being destroyed, so the "no console edits" rule is not at stake.
   - Cancel the service before the next billing cycle that falls after 2027-01-31.
8. **Close the plan** (ADR-0012 rule): the orchestrator records the outcome. The durable choices
   (laptop host, Tailscale for admin and CI, `infrastructure/apps/` ownership, cold-copy
   migration method) go into an infra decisions record or `infrastructure/README.md`. The 0001
   phase detail leaves `infrastructure/plans/`.

## Gates

- [ ] Final archive object present and test-decrypted
- [ ] `git grep -n "shared/vps\b"` returns only historical plan text
- [ ] `family_config.py ls` shows no `shared/vps`; every profile `describe` is clean
- [ ] VPS reader key deleted; laptop deploys still green afterwards (one dispatch)
- [ ] Owner confirms the server is wiped and the service is cancelled

## Owner-gated items

The exit check, archive retention, the OVH wipe and cancellation, and timing against the billing
cycle.

## Rollback

There is none after the wipe. That is why step 1 and step 2 come first. Before the wipe, every
step above is reversible: re-create the key, restore the Firestore group from the operator's
notes, revert the PR.
