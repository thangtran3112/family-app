# 0001d: Data migration rehearsal and validation

Parent: [0001](../0001-laptop-migration.md) §7. Needs [0001c](0001c-staging-bring-up.md) gates
green. Next: [0001e](0001e-cutover.md).

**Outcome:**
- the real data sizes are known;
- the cutover copy has been timed end to end;
- a logical restore from GCS has worked on the laptop (the disaster-recovery proof);
- the parity checks that 0001e reuses exist and pass.

## Step 0: Live probe of the VPS (read-only; fills the 0001 §2 "to probe" cells)

**Run only these commands**, with the brief's SSH prefix (operator key, port 2222, the pinned
known-hosts file). Never print env files, secret values, or row data.

The list is the planning brief's read-only list plus `docker inspect` for mounts and the image
digest, `systemctl list-timers`, and `uname -m`. All of them are read-only.

The brief's catalog reads use `-U desk_runtime`. Use `-U postgres` only if that role lacks
`CONNECT` on the other databases, and still run catalog reads only.

```
docker ps -a --format '{{.Names}}\t{{.Image}}\t{{.Status}}'
docker volume ls
df -h
free -h
systemctl list-units --type=service --state=running | head -60
systemctl list-timers --all | grep -i family-app
docker inspect --format '{{.Image}} {{index .RepoDigests 0}}' expense-tax-postgres   # image digest for 30-postgres.sh
docker inspect --format '{{range .Mounts}}{{.Type}} {{.Source}} -> {{.Destination}}{{"\n"}}{{end}}' expense-tax-postgres
sudo du -sh /var/lib/docker/volumes/<each volume>/_data                       # one per named volume
sudo du -sh <postgres data dir from the inspect above>
uname -m
sudo docker exec expense-tax-postgres psql -U postgres -tAc \
  "select datname, pg_database_size(datname) from pg_database where not datistemplate order by 1"
sudo docker exec expense-tax-postgres psql -U postgres -d ai_trading_desk_db -tAc \
  "select pg_total_relation_size('desk.replay_blobs')"
```

Record the results in this file's "Probe results" table (sizes, names and counts only). Commit
that table as a docs change.

**Gate 0:**
- the container list matches 0001 §2.3, or the differences are explained;
- the architecture is `x86_64` on both hosts;
- the image digest is recorded;
- the total data to move (Postgres data dir plus all volumes) is known.

### Probe results (fill in)

| Item | Value |
|---|---|
| Containers running / total | |
| Named volumes (count) | |
| Postgres data dir size | |
| DB sizes: postgres / expense_tax_db / temporal / temporal_visibility / mailbox_vault / ai_trading_desk_db | |
| `desk.replay_blobs` size | |
| ai-trading volumes (each) | |
| expense receipts / inbound | |
| Disk used / free; RAM used / free | |
| Backup timer state, last success | |
| Image digest (pg17 pgvector) | |
| Architecture | |

## Step 1: Parity tooling (written once, reused by 0001e)

These go in `infrastructure/host/migrate/` (new, small, with a `--dry-run` self-test in CI):

- `pg-parity.sh <host>`: for each non-template DB:
  - writes `datname`, `pg_database_size`, and for every user table
    `schema.table count(*)` (exact counts, no row data) to a sorted text file;
  - writes `alembic_version` for `ai_trading_desk_db`, and the migration-table heads for the
    expense schemas;
  - writes the role list with attributes (`rolname`, `rolcanlogin`, `rolsuper`; no passwords)
    and per-DB role settings.
- `vol-manifest.sh <volume>`: file count, `du -sb`, and the digest of a sorted per-file sha256
  list.
- `relay-copy.sh <src-path> <dst-path>`: run from the operator machine:
  `ssh vps 'sudo tar -C <src> -cf - . | zstd -T0' | ssh laptop 'zstd -d | sudo tar -C <dst> -xpf -'`.
  It keeps ownership and permissions. No key ever sits on the laptop or the VPS.

Diffing two `pg-parity` outputs **must be empty** for a pass. Size may differ by up to 1%: a
physical copy matches exactly, a logical restore does not.

## Step 2: Rehearsal A, logical restore from GCS (the DR proof on the new host)

1. Stop the dark ai-trading and expense stacks on the laptop. Keep Postgres up.
2. Restore with `infrastructure/backup/restore.sh` from the newest monthly plus daily objects into
   an **empty** laptop cluster:
   - destructive-confirm flag;
   - the operator's temporary objectViewer grant, removed afterwards;
   - `--tmpfs /tmp`, per the 2026-10-12 drill lessons.
3. Restore the receipt tar into the expense storage volume.
4. Compare with the VPS: `pg-parity.sh` on the restored laptop against the VPS taken at the
   backup's timestamp. Expect equal tables and differences only in rows written since the
   backup. Also: alembic heads equal, roles and settings equal, Desk runtime role reads its
   tables and is denied `CREATE`.
5. Start the stacks dark again and run the 0001c route probes.

**Gate A:** restore completes inside the 2-hour RTO; the role, settings and grant checks match.
`replay_blobs` is empty, which is expected.

## Step 3: Rehearsal B, a timed dry run of the cutover copy (no production downtime)

The goal is the copy **time**, not a consistent copy. Production keeps running.

1. **Throughput.** Run `relay-copy.sh` on a copy of the largest volume to a scratch dir. Measure
   MB/s, VPS to operator Mac to laptop.
2. **Postgres data dir.** A hot tar is inconsistent but fine for timing. Use `pg_basebackup` from
   the VPS cluster through a temporary port forward, or relay the dir to a scratch location.
   **Never start Postgres on this copy.**
3. Compute the freeze estimate:

   ```
   copy   = PG dir at measured MB/s + volumes at measured MB/s
   freeze = stop and final backup (5 min) + copy + start and parity (5 min)
            + two CI dispatches with image_tag (measured in Rehearsal C) + connector flip (2 min)
   ```

**Gate B:** the copy is **30 minutes or less**. Rehearsal C then confirms a total freeze of
**60 minutes or less**. If the copy is over budget:
- switch volumes to a warm `rsync` pre-copy on day T-2 plus a final delta; this needs a
  temporary laptop-to-VPS key, created and deleted in the window, or Mac-relayed `rsync -e`;
- or shrink the Postgres copy with `pg_dump` per DB, accepting the logical-restore path.

Record the choice here.

## Step 4: Rehearsal C, full cutover drill on the laptop (one week before 0001e)

Run [0001e](0001e-cutover.md) steps 1–7 **against the staging stacks only**: real procedure,
real scripts. Use a fresh logical restore as the "source" and leave the VPS untouched. Skip the
connector flip. Time every step and fix the runbook where reality differs.

**Gate C:**
- every 0001e step runs from the written runbook without improvising;
- the timed total, including both `image_tag` dispatches, is 60 minutes or less;
- the owner reviews the timings and approves the cutover date (Q15).

## Owner-gated items

- approving the probe numbers and the freeze budget;
- the temporary objectViewer grant for `restore.sh`;
- the cutover date.

## Rollback

Production is untouched. Laptop data from rehearsals is disposable: run `docker compose down`,
delete the data dir, re-init.
