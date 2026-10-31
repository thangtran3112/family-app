# 0001: Move all family-app production hosting from the shared VPS to the owner's Ubuntu laptop

Status: **planner draft, 2026-10-31.** Docs only; nothing is executed. The owner sets up the
laptop and hands over an SSH session first; execution starts after that, phase by phase.

This directory, `infrastructure/plans/`, is the plan home for cross-app infrastructure from now
on. App plans stay in their packages (`ai-trading/plans/`, `expense-tax-management/plans/`).
It follows ai-trading's ADR-0012 rule: plans describe future or in-flight work only. When a phase
closes, its durable choices move to an ADR or a README, and the phase detail leaves this tree.

**Supersedes** [`02q-laptop-migration.md`](../../ai-trading/plans/subplans/02q-laptop-migration.md).
02q was parked until the owner gave an explicit instruction. The owner has now given it. The
orchestrator marks 02q superseded; this plan does not edit it.

Execution subplans: [`subplans/`](subplans/)
- [0001a laptop bootstrap](subplans/0001a-laptop-bootstrap.md)
- [0001b IaC consolidation](subplans/0001b-iac-consolidation.md)
- [0001c staging bring-up](subplans/0001c-staging-bring-up.md)
- [0001d data migration and validation](subplans/0001d-data-migration-validation.md)
- [0001e cutover](subplans/0001e-cutover.md)
- [0001f VPS decommission](subplans/0001f-vps-decommission.md)
- [0001g post-cutover hardening](subplans/0001g-post-cutover-hardening.md)

---

## 1. Goal and constraints

**Goal.** Every family-app production workload that runs on the shared OVH VPS today runs on the
owner's spare Ubuntu 24.04 laptop instead. Both apps (expense-tax-management and ai-trading) move
in one coordinated cutover. Every piece of host setup and deployment lives as code under
`infrastructure/`.

**Constraints**

1. **Deadline.** The VPS is removed by the end of February 2027
   ([02q](../../ai-trading/plans/subplans/02q-laptop-migration.md) "Deadline context";
   [`../vps/README.md`](../vps/README.md)). Recommended target: cut over in December 2026 and
   decommission by 2027-01-31. That leaves a four-week buffer, and the move finishes before
   tax season, when the expense app is used most (Q15).
2. **The cloud side stays.** These do not move:
   - Firestore `family-config` (the single secret store, ADR-0007);
   - every GCS bucket: the static hub, Desk and MiroFish buckets, the backup bucket, and the
     Terraform state buckets;
   - Cloudflare Workers, DNS and tunnel definitions;
   - GitHub Actions and GHCR images.
3. **IaC first.** Use no console edits (root [`AGENTS.md`](../../AGENTS.md) "Everywhere"). The
   existing exceptions still hold: the shared Cloudflare token's own permission scope, and owner
   steps that have no API (installing the OS, BIOS settings, signing in to IB Gateway). This plan
   adds one candidate exception: creating the Tailscale OAuth client once, if the Terraform
   provider cannot create it (§5, Q3).
4. **Secrets.** Firestore is the only secret store, read through
   `common/config/family_config.py` ([ADR-0007](../../ai-trading/decisions/adr/ADR-0007-firestore-config.md)).
   Keep one shared Cloudflare token (`shared/cloudflare`); never create another.
5. **One coordinated cutover.** Neither app's sessions migrate the shared Postgres or a tunnel
   alone (02q "Constraints").
6. **Downtime.** Aim for as little as possible. Postgres has one writer, so accept a short
   planned write freeze, measured in tens of minutes, and keep a warm rollback window
   (§7, [0001e](subplans/0001e-cutover.md)).
7. **Parallel sessions.** ai-trading sessions B2 (bridge shadow) and C0 (02u historical
   correctness) are in flight. This plan does not assume they finish. It plans around their
   edits to `ai-trading/deploy/production/docker-compose.yml` (§4.5).
8. **Public repository.** Never commit hostnames of the tailnet, IP addresses, account numbers or
   emails. Those values stay in Firestore.

---

## 2. Current-state map

### 2.1 How the probe was done

Read-only SSH to the VPS was **not available** in the planning session: the harness's permission
mode denied every `ssh` command. The numbers below therefore come from the repository: source
files plus the latest recorded live probes, with dates. Before any cutover date is fixed,
[0001d](subplans/0001d-data-migration-validation.md) step 0 re-runs the allowed read-only
command list and fills in the "to probe" cells. That is a gate.

### 2.2 Host

| Fact | Value | Source |
|---|---|---|
| VPS shape | 6 vCPU, 11.4 GiB RAM, no swap, 96 GB disk | `ai-trading/plans/subplans/02d-desk-spike-results.md:81-84` (2026-10-10) |
| Free disk | Recorded readings fell from 35 GB to about 29 GB free. One ENOSPC incident happened (a MiroFish release is about 17 GB). `deploy.sh` refuses to deploy below 30 GiB free | `ai-trading/plans/STATUS.md:73,116`; handoff 2026-10-12 |
| RAM in use | 2.3 GiB used, 9.4 GiB available (before the Desk api, scheduler and bridge were added) | 02d:81-82 |
| SSH | Port 2222, user `ubuntu`, key-only, strict host keys pinned in Firestore `shared/vps` | `infrastructure/vps/steps/10-harden-ssh.sh`; `common/config/README.md:70` |
| Firewall | UFW default-deny inbound; allows SSH, 80 and 443 | `infrastructure/vps/steps/00-firewall.sh:34-46` |
| Laptop (target) | Intel i9, RTX 3070 Ti, 40 GB RAM, TB-scale storage | 02q:15 |

### 2.3 Containers (from the compose files; live list to probe)

| Stack | Compose project and file | Long-running services | One-shot jobs |
|---|---|---|---|
| ai-trading | `ai-trading`, `ai-trading/deploy/production/docker-compose.yml` (+ `docker-compose.mirofish.yml`) | web, ta-terminal, ta-research, ahf-terminal, market-data, market-data-bridge (02t B0, dark), vibe-trading, vibe-consensus, gateway (Caddy), auth, cloudflared, api (Desk), scheduler (Desk), mirofish (opt-in) = **14** | `api` alembic migrate |
| expense | `expense-tax-production`, `expense-tax-management/deploy/production/docker-compose.yml` (+ `docker-compose.mailbox.yml`, live) | app-api, foundry-service, workflow-worker, capture-web, office-web, foundry-web, mailbox-broker = **7** | app-api-migrate, foundry-service-migrate, mailbox-broker-migrate |
| shared Postgres | project `postgres`; hand-built at `/opt/expense-tax-management/postgres/`; **its compose file is not in git** | `expense-tax-postgres` (`pgvector/pgvector:pg17`) = **1** | — |
| shared Temporal | `infrastructure/temporal/docker-compose.yml`, hand-staged to `/opt/family-app/temporal/` | `family-temporal`, `family-temporal-ui` = **2** | — |
| legacy | — | old expense Temporal (stopped, `restart=no`; do not migrate) | — |

Expected total: **24 long-running containers** (23 with MiroFish off).

Host systemd units:
- `expense-tax-cloudflared.service` (the expense tunnel connector);
- `family-app-backup.service`, `.timer` and `family-app-backup-retry.service`;
- `ai-trading-control.service` (app controls).

### 2.4 Data stores and volumes

| Store | What | Size | Source |
|---|---|---|---|
| Postgres cluster `expense-tax-postgres` | 6 DBs: `postgres`, `expense_tax_db`, `temporal`, `temporal_visibility`, `mailbox_vault`, `ai_trading_desk_db` | **to probe** (not recorded anywhere) | `ai-trading/plans/subplans/02c-desk-v1-tasks/phase-3-runtime-and-alerts.md:7396-7418` |
| — `ai_trading_desk_db` `replay_blobs` | Re-fetchable practice cache | Up to about **1.8 GB** a month of use. The brief cites 1.4 GB; the repo records 1.8 GB | `infrastructure/backup/backup.sh:122-124` |
| — `feedback_attachments` | bytea; not re-fetchable | Worst case about 1.5 GB, realistic tens of MB | `02s-desk-feedback-log.md:69` |
| ai-trading volumes (`ai-trading_<name>`) | ta-data, ta-research-data, ahf-data, vibe-runs, vibe-sessions, vibe-uploads, vibe-swarm-runs, vibe-home, mirofish-uploads | to probe | prod compose |
| ai-trading host state | `/var/lib/family-app/ai-trading/control.json` (family on/off choices) | bytes | `deploy.sh:99-101` |
| expense volumes | `expense-tax-production_expense_tax_production_storage` (receipts), `..._inbound` | to probe | expense prod compose:56-58 |
| Postgres data dir | Bind dir or volume under `/opt/expense-tax-management/postgres/` | to probe | `infrastructure/vps/README.md:196-206` |

### 2.5 Networks, tunnels, DNS

- **Docker networks.** `postgres_default` is external. It exists only because the hand-built
  Postgres project is named `postgres`, and every DB client joins it: ai-trading `api` and
  `scheduler`, the expense services, Temporal, and the backup job. `family_shared` (external)
  connects Temporal and the expense services. ai-trading's own networks are internal to its
  project.
- **Two Cloudflare tunnels.** Both are managed by Terraform with `config_src = cloudflare`. Every
  DNS record is a CNAME to `<tunnel-uuid>.cfargotunnel.com`, so **moving a connector needs no DNS
  or Terraform change**.

| Tunnel | TF root and state | Connector | Token delivery | Ingress targets |
|---|---|---|---|---|
| `ai-trading` | `infrastructure/cloudflare/ai-trading`, `gs://tobytran-portfolio-tfstate` prefix `cloudflare/ai-trading` | `cloudflared` container in the ai-trading compose (networks `hub`, `gateway`) | CI `render-env.sh` looks the tunnel up by name on every deploy and stages `cloudflared.env` | Compose names: `gateway:8080`, `web:3000` |
| `expense-tax` | `infrastructure/cloudflare/expense-tax`, `expense-tax-tobytran-2026-tfstate` prefix `cloudflare/expense-tax` | Host systemd `expense-tax-cloudflared` | Operator, once: TF output, then `infrastructure/vps/bootstrap-cloudflared.sh`, which writes `/etc/cloudflared/expense-tax-tunnel.token` | Host loopback `127.0.0.1:{7301,7302,7303,8100,8200,8300}` |

- **Public hostnames.** All stay unchanged:
  - ai-trading: `trading`, `vibe-trading`, `tradingagents`, `ai-hedge-fund`, `trading-origin`
    and `mirofish-origin` through the tunnel. `trading-hub` and `mirofish` are Workers in front
    of GCS and the `*-origin` hostnames.
  - expense: `expense`, `expense-capture`, `expense-api`, `expense-office`, `expense-foundry`
    and `expense-mailbox`.

### 2.6 CI/CD paths

| Workflow | Trigger | Target and credentials | Host work |
|---|---|---|---|
| `ai-trading-deploy.yml` | Push to `main` (ai-trading paths, `common/config/**`, `infrastructure/vps/app-controls/**`); dispatch | WIF as `ai-trading-deploy` SA. Firestore `shared/vps` `VPS_DEPLOY_SSH_PRIVATE_KEY` and `VPS_SSH_KNOWN_HOSTS`. `VPS_HOST`, `VPS_PORT` and `VPS_USER` come from `ai-trading/deploy`, which links them to `shared/vps`. `StrictHostKeyChecking=yes` | scp to `/tmp/ai-trading-deploy/`, install to `/opt/family-app/ai-trading/`, GHCR pull, run `deploy.sh` as root |
| `expense-tax-deploy.yml` | `workflow_run` after "Expense Tax CI" succeeds on `main` | **GitHub env secrets** `VPS_DEPLOY_SSH_KEY` and `VPS_DEPLOY_KNOWN_HOSTS`, plus vars `VPS_HOST`, `VPS_PORT` and `VPS_USER`. These are CI-only copies of `shared/vps`. No GCP auth; a test asserts there is no `id-token` | scp to `/tmp/expense-tax-deploy/`, install to `/opt/expense-tax-management/app/`, run `family_config.py run expense-tax-management/production -- deploy.sh` |
| `ai-trading-infra.yml` | PR: validate. Main: plan `cloudflare/ai-trading`. Dispatch: apply | WIF `ai-trading-terraform` | none |
| `expense-tax-cloudflare.yml` | PR: validate. Main: plan with digest. Dispatch: apply | WIF `expense-tax-cf-terraform` | none |
| `family-backup-freshness.yml` | Daily 14:17 UTC | WIF, list-only on the backup bucket | none; host-agnostic |

### 2.7 Secrets profiles that name the host

| Profile | Keys (names only) | Used by |
|---|---|---|
| `shared/vps` | `VPS_HOST`, `VPS_PORT`, `VPS_USER`, `VPS_IPV4_ADDRESS`, `VPS_IPV6_ADDRESS`, `VPS_SSH_KNOWN_HOSTS`, `VPS_DEPLOY_SSH_{PRIVATE,PUBLIC}_KEY`, `VPS_OPERATOR_SSH_{PRIVATE,PUBLIC}_KEY` | ai-trading deploy, `install-reader-key.sh`, bootstrap scripts |
| `ai-trading/deploy` | Links to `shared/vps` host, port and user | ai-trading deploy |
| `shared/vps-postgres` | `POSTGRES_SUPERUSER_PASSWORD` | operator DB bootstrap |
| `shared/vps-backup` | `BACKUP_WRITER_KEY_JSON`, `BACKUP_AGE_IDENTITY`, `BACKUP_AGE_RECIPIENT` | backup install |
| `shared/temporal` | Temporal DB password | `/etc/family-app/temporal.env` |
| GitHub expense env | Copies of the deploy key, known hosts, host, port and user | expense deploy |

### 2.8 Backups

- **Live since 2026-10-12.** It was installed with `bootstrap.sh --only backup`, and restore
  drills passed (phase-3 doc:7416-7426). `expense-tax-management/plans/ROADMAP.md`,
  [`../README.md`](../README.md) and [`../vps/README.md`](../vps/README.md) still say
  "deferred". That is stale (§10).
- **What is dumped.** `pg_dumpall --globals-only`, plus `role-settings.sql`, plus `pg_dump -Fc` of
  every non-template DB (excluding `*.replay_blobs` data), plus the receipt volume (full monthly,
  delta daily).
- **Destination.** Encrypted with age and uploaded to `gs://expense-tax-tobytran-2026-backups`
  under `daily/` and `monthly/`. The bucket has a locked 7-day retention, and lifecycle rules
  expire `daily/` at 30 days and `monthly/` at 365 days.
- **Schedule.** `00/12:00 UTC` with 15 minutes of jitter, plus an hourly retry, up to 4 attempts.
- **Freshness.** Checked locally from a marker file, and off-host by the daily workflow (warn at
  18 h, page at 22 h, breach at 24 h).

### 2.9 GCP inventory (from Terraform source)

Terraform state lives in GCS and was not read; the inventory comes from the `.tf` source.

| Root | Resources | Moves? |
|---|---|---|
| `gcp/ai-trading` (operator-applied) | WIF pools `ai-trading-deploy` and `ai-trading-terraform`, deploy and terraform SAs, public buckets for hub, Desk and MiroFish with uploader SAs, `datastore.viewer` grants, the retired `ai-trading-env-bundle` secret | Stays |
| `gcp/backup` (operator-only) | Backup bucket, writer SA, freshness SA, WIF provider `backup-freshness`, org-policy key exception | Stays |
| `gcp/family-config/*.sh` (scripts) | Firestore DB `family-config`; SA `family-config-reader` (display name "(VPS)") | Stays. The laptop gets its own key (§7.4) |
| `expense-tax-management/infrastructure/gcp/expense-tax/*.sh` (scripts) | Expense project, APIs, WIF pool `expense-tax-github`, SA `expense-tax-cf-terraform` | Stays cloud-side. The files move to `infrastructure/gcp/expense-tax/` (§4) |

What the laptop needs from the cloud:
- a `family-config-reader` key at `/etc/family-app/config-reader.json`;
- the backup writer key and age recipient (from `shared/vps-backup`);
- the two tunnel tokens;
- outbound access to `ghcr.io`.

Nothing else.

---

## 3. Target architecture

### 3.1 Layout on the laptop

```
laptop (Ubuntu 24.04 Desktop, tag:family-host on the tailnet; never sleeps on AC)
  sshd :2222 (tailscale0 only)             tailscaled (admin + CI SSH)
  systemd: expense-tax-cloudflared, family-app-backup{,.timer,-retry}, ai-trading-control,
           ibkr-edge (02t B1, later)
  desktop session: IB Gateway 127.0.0.1:4002 (owner's daily sign-in ritual, 02t §5.2)
  docker (rootful, /var/lib/docker on a dedicated large partition)
    project postgres     -> family-app-postgres (pg17 pgvector), net postgres_default, alias postgres, 127.0.0.1:5432
    project temporal     -> family-temporal, family-temporal-ui (127.0.0.1:7233/8233), nets family_shared + postgres_default
    project expense-tax-production -> 7 services on 127.0.0.1:{7301-7303,8100,8200,8300}
    project ai-trading   -> 14 services, no host ports; cloudflared inside (hub, gateway nets)
```

Host paths, project names, network names, volume names, UID/GID 22001 and the systemd unit
names all **stay exactly as they are on the VPS**. They are runtime contracts: Firestore DB URLs
use `postgres:5432`, the compose files name external networks, tests pin them, and Docker names
volumes after the project. Keeping them makes the move a re-host, not a redesign. The only
renames are the Postgres container (Q6) and the bootstrap directory in the repo (Q12).

### 3.2 Cloudflare tunnels

- Keep **both** existing tunnel resources unchanged. Only the connectors move.
- ai-trading: the `cloudflared` container comes up with the laptop's ai-trading stack, using the
  token CI fetches.
- expense: re-run `bootstrap-cloudflared.sh` (after 0001b it lives at
  `infrastructure/host/bootstrap-cloudflared.sh`) against the laptop to install the systemd
  connector. Its ingress targets host loopback, so it stays on the host network.
- **Replica hazard.** Any connector started with a tunnel's token becomes an active replica, and
  Cloudflare spreads traffic across replicas. A laptop connector started early would serve live
  users from a laptop database copy: split-brain writes. Staging therefore runs **dark**, with no
  connectors on the laptop ([0001c](subplans/0001c-staging-bring-up.md)). Connectors start on the
  laptop only at cutover.
- **Optional, recommended (Q14).** Add `cloudflare_notification_policy` resources (tunnel health
  alerts to the owner) to both Cloudflare roots. This is native, managed in Terraform, and needs
  no new vendor.

### 3.3 Tailscale: admin and CI only

- The laptop joins the owner's tailnet as `tag:family-host`, with key expiry disabled.
- GitHub-hosted runners join per job as ephemeral `tag:ci` nodes, through an OAuth client (§6).
- ACL: owner devices (`autogroup:admin`) and `tag:ci` may reach `tag:family-host:2222`. Nothing
  else may. Public traffic never uses Tailscale.
- A new Terraform root, `infrastructure/tailscale/`, holds the ACL, tag owners and the laptop's
  pre-auth key. Its state goes to `gs://tobytran-portfolio-tfstate` prefix `tailscale`. It is
  operator-applied (Q19). Credentials live in Firestore `shared/tailscale`, names only:
  - `TAILSCALE_TF_OAUTH_CLIENT_ID` and `TAILSCALE_TF_OAUTH_CLIENT_SECRET` (Terraform);
  - `TS_CI_OAUTH_CLIENT_ID` and `TS_CI_OAUTH_SECRET` (CI).
- This root is the "Tailscale ACL as code under `infrastructure/`" that 02t ruling 4 approved,
  repurposed (§3.4).

### 3.4 Bridge and IBKR edge: the 02t B1 link collapses to the local host

02t §5.1 assumed the stack on the VPS and IB Gateway on the laptop. It linked them with an
app-scoped `bridge-tailscale` sidecar and an ACL `tag:ai-trading-bridge` → `tag:ibkr-edge`
(02t §5.1, §7.1; ruling 4). Ruling 4's rationale was "the shared VPS host stays untouched". When
the stack and the gateway share one laptop, that rationale is gone.

**Target (post-cutover):**

```
IB Gateway 127.0.0.1:4002 (Trusted IPs 127.0.0.1, unchanged; 02t §5.3)
   ^ localhost
ibkr-edge (host systemd, Restart=always; 02t §5.2 step 4) listens on the docker0 address only
   ^ http://ibkr-edge:<port>, IBKR_EDGE_TOKEN still required
market-data-bridge (compose, extra_hosts: "ibkr-edge:host-gateway", joins marketdata directly)
```

- The bridge needs **no sidecar** and no `TS_AUTHKEY`. The Tailscale ACL has **no**
  bridge-to-edge rule.
- UFW allows the edge port only from the Docker subnets. The Gateway's localhost-only guards are
  unchanged.
- Keep `IBKR_EDGE_TOKEN`. It still limits which callers the edge answers.
- `IBKR_EDGE_URL` stays a Firestore value (`ai-trading/market-data-bridge`). Only its value
  changes.
- 02t §5.4's `edge_unreachable` keeps its meaning: the edge is down, or the laptop is off.

**Sequencing with B1** (Q4). B1 is the ai-trading lane's work; this plan only fixes the seam.

| If B1 starts... | Then |
|---|---|
| After cutover | Build B1 directly in the local form above. No sidecar is ever built. |
| More than ~3 weeks before cutover | Build it as 02t §7.1 says (sidecar on the VPS). At cutover, delete the `bridge-tailscale` service, move the bridge back onto `marketdata`, change `IBKR_EDGE_URL`, and drop the bridge-to-edge ACL rule. |
| Less than ~3 weeks before cutover | Recommend waiting for cutover. The sidecar would live only days. |

### 3.5 Postgres

- Keep **one cluster for both apps**, as today. It is already shared, and 02u H1 plans its
  bridge-archive database inside it too.
- The cluster becomes code for the first time: `host/steps/30-postgres.sh`, reconciled with live
  (0001b):
  - Pin the compose project name to `postgres`, so the network stays `postgres_default`.
  - Keep the service alias `postgres`, so every Firestore DB URL stays valid.
  - Use the same image digest as the VPS.
  - Bind to `127.0.0.1:5432`.
  - Container name `family-app-postgres` (Q6). The operator scripts' defaults
    (`bootstrap-*-db.sh`, `recovery-drill.sh`) align to it in 0001b.
- Data moves by a **cold physical copy** of the data directory at cutover. That gives the same
  roles, passwords, grants and settings, with no restore-defect class. The rehearsal uses a
  logical restore from GCS backups, which doubles as a disaster-recovery drill (§7, Q5).

### 3.6 Sizing against the probe numbers

| Resource | Demand on the laptop | Laptop | Headroom |
|---|---|---|---|
| RAM, ceilings | ai-trading `mem_limit` sum about 11.4 GiB (MiroFish 4 GiB included); expense about 4.5 GiB; Temporal 1 GiB; Postgres 2–4 GiB (no limit set); IB Gateway about 1.5 GiB plus edge 0.25 GiB; desktop and OS about 3 GiB. **About 24 GiB in the worst case** | 40 GB | About 16 GiB. The VPS ran the older set in 11.4 GiB with no swap |
| Swap | none on the VPS | Add an 8 GiB swapfile (0001a) | MiroFish OOM risk goes away |
| Disk, Docker | ai-trading: two releases about 34 GB plus the 30 GiB guard; expense images about 10 GB (to probe); Postgres plus volumes (to probe, likely under 20 GB) plus 02u archive growth | TB-scale | Give `/var/lib/docker` a dedicated partition or logical volume of **at least 500 GB** (Q10). That ends the ENOSPC history |
| CPU | VPS 6 vCPU, mostly idle | i9 | Ample |
| Network | Public traffic is family-scale. GHCR pulls are about 17 GB for a full ai-trading release (rare) | Home broadband | Ethernet recommended (Q8) |

### 3.7 Home-laptop realities and mitigations (owner decisions)

| Risk | Mitigation (recommended default) | Owner decision |
|---|---|---|
| Sleep or suspend (GNOME on 24.04 can auto-suspend) | Mask `sleep`, `suspend`, `hibernate` and `hybrid-sleep` targets; logind `HandleLidSwitch*=ignore`. Managed in code in `host/steps/05-power.sh` | Q7 |
| Power cut | The battery is a built-in UPS for the laptop. BIOS "restore on AC power loss" set to on. A small UPS for the modem and router | Q7, Q8 |
| Battery wear from being plugged in all the time | BIOS or firmware charge limit (about 80%) if the model supports it | Q7 |
| WiFi drops | Wired Ethernet (USB-C adapter if needed) plus a DHCP reservation. cloudflared and tailscaled reconnect on their own; a drop is an outage while it lasts | Q8 |
| OS updates and reboots | `unattended-upgrades` for security updates only, auto-reboot **Saturdays only** (same rule as 02t §5.2). Restart policies `unless-stopped`; units enabled | Q7 |
| Reboot with disk encryption | LUKS with TPM2 auto-unlock (clevis), so an unattended reboot comes back without a passphrase and a stolen disk stays encrypted | Q9 |
| Heat with the lid closed | Lid open, or a vertical stand; check `sensors` during the burn-in | Q7 |
| Theft or LAN pivot | Put the laptop on a guest or isolated VLAN or SSID if the router supports it. UFW allows inbound SSH on `tailscale0` only. Docker publishes only to `127.0.0.1` (already true) | Q17 |
| Single host, no standby | GCS backups (already live) plus a written "restore onto any Ubuntu box" runbook, drilled quarterly (0001g) | Q16 |
| Wake-on-LAN | Not needed: the host never sleeps. WoL rarely works over WiFi | — |

---

## 4. IaC consolidation

### 4.1 Principles

- **The repo layout moves; the host layout does not.** Staged names on the host (for example
  `$APP_DIR/deploy/production/mirofish-runtime.sh`, which `deploy.sh:173` and
  `control/runtime.py` resolve) stay the same. The workflows map the new repo paths onto the old
  staged names.
- **App code stays with the app.** Dockerfiles, bake files, upstream wrappers, app-controls
  Python logic and local-dev compose stay. Only host and deploy artifacts move.
- **Tests move with the shell scripts they test.** This follows the pattern already used in
  `infrastructure/backup/` and `infrastructure/temporal/`. The expense TypeScript contract tests
  stay in their package and repoint their paths.
- **Do it before cutover, and prove it on the VPS.** First do a no-op redeploy to the VPS from the
  moved paths. That separates "files moved" risk from "host moved" risk.

### 4.2 Target tree

```
infrastructure/
├── README.md                     rewritten host-neutral; links plans/
├── plans/                        NEW: infra plan home (this file, subplans/)
├── host/                         RENAMED from vps/ (Q12): bootstrap for the laptop or any DR host
│   ├── bootstrap.sh, bootstrap-cloudflared.sh, test-*.sh
│   ├── steps/00-firewall.sh      80/443 optional (off for a tunnel-only host); SSH on tailscale0 option
│   ├── steps/05-power.sh         NEW: sleep masks, logind, unattended-upgrades Saturday window, swap
│   ├── steps/10-harden-ssh.sh
│   ├── steps/15-tailscale.sh     NEW: install tailscaled, join with the TF-issued tagged key
│   ├── steps/20-docker.sh        + data-root check (dedicated partition)
│   ├── steps/30-postgres.sh      reconciled with live: project name pinned, image digest, container name
│   ├── steps/35-temporal.sh      NEW: replaces the hand-staging runbook in README.md:39-58
│   ├── steps/40-backup.sh        PG password source fixed for the real layout; BACKUP_HOST_ID per host
│   ├── apps/*.conf
│   └── app-controls/             moved from vps/app-controls/
├── apps/                         NEW
│   ├── ai-trading/               from ai-trading/deploy/production/ + deploy/ci/render-env.sh
│   │   ├── docker-compose.yml, docker-compose.mirofish.yml, Caddyfile
│   │   ├── deploy.sh, health-check.sh, mirofish-runtime.sh, prepare-mirofish.sh, render-env.sh
│   │   ├── README.md             the production runbook
│   │   └── tests/                test-deploy-firestore.sh, test-app-controls-deploy.sh,
│   │                             test-health-rollback.sh, test-l6-desk.sh, test-app-controls-gateway.sh,
│   │                             test-render-env.sh, desk-target-state/
│   └── expense-tax/              from expense-tax-management/deploy/production/
│       ├── docker-compose.yml, docker-compose.mailbox.yml
│       ├── deploy.sh, health-check.sh
│       └── bootstrap-temporal-db.sh, bootstrap-mailbox-vault-db.sh
├── gcp/
│   ├── ai-trading/, backup/, family-config/, bootstrap-state.sh     unchanged
│   └── expense-tax/              moved from expense-tax-management/infrastructure/gcp/expense-tax/
├── cloudflare/                   unchanged (+ optional notification policies, Q14)
├── tailscale/                    NEW Terraform root (§3.3)
└── backup/, temporal/, postgres/, nginx/, docker-compose*.yml        unchanged (the last three are local dev)
```

### 4.3 What stays app-local

| Stays | Why |
|---|---|
| `ai-trading/deploy/docker-bake*.hcl`, `deploy/upstream/**`, `auth/Dockerfile`, package Dockerfiles | Build contexts are app code |
| `ai-trading/control/*.py`, `catalog.json` | App-controls logic; staged as config, owned by the app |
| `ai-trading/deploy/local/**` | Local dev. Its override's `../local/Caddyfile` path is fixed in 0001b |
| `ai-trading/deploy/ci/smoke-test.sh`, `upload-*-static.sh`, `check-*.sh`, `test-vibe-*.sh` | Build and static checks, not host deploy. `smoke-test.sh:477` repoints the Caddyfile mount |
| `expense-tax-management/**/Dockerfile`, local `docker-compose.yml`, `scripts/compose.sh`, `docker/postgres/zz-20-*.sh` | App code, app schema roles, local dev |
| expense TS contract tests (`production-deployment-boundaries.test.ts`, `deploy-script.test.ts`, `check-*.mjs`) | Expense package tests. They repoint paths in 0001b-2 |

### 4.4 Package rules: how the move respects them

- **Root [`AGENTS.md`](../../AGENTS.md):** "start a session inside the package you are changing",
  and "main releases carry only the owning package's paths". So the consolidation runs as **two
  sessions and two PRs**:
  - **0001b-1:** the ai-trading lane plus shared infra. Starts in `ai-trading/` or
    `infrastructure/`, under ai-trading's standing delivery authorization.
  - **0001b-2:** the expense lane. Starts in `expense-tax-management/` and follows expense
    `AGENTS.md`: no staging, explicit approval for production mutations, exact-path staging and
    cherry-pick releases (Q11).
- **Ownership rule for the orchestrator to add to root `AGENTS.md`:**
  "`infrastructure/apps/<app>/` belongs to `<app>` for release scoping and delivery
  authorization; shared `infrastructure/*` roots belong to infra plans." With that rule, an
  ai-trading release may carry `infrastructure/apps/ai-trading/**`, and the expense rules govern
  `infrastructure/apps/expense-tax/**`.
- **[`ai-trading/AGENTS.md`](../../ai-trading/AGENTS.md)** says "Application deployment artifacts
  ... live in `ai-trading/deploy/`". **`expense-tax-management/AGENTS.md:103`** lists the current
  infra sources. The orchestrator amends both in the same PRs. This plan does not edit them.
- **Workflow path filters** gain `infrastructure/apps/<app>/**` (and `infrastructure/host/app-controls/**`
  for ai-trading), so a change to a moved file still deploys its app.

### 4.5 Coordination with in-flight sessions

B2 and C0 edit `ai-trading/deploy/production/docker-compose.yml` and `deploy.sh`. 0001b-1 is a
mechanical `git mv` plus path fixes, landed in one quiet window that the orchestrator announces.
Git's rename detection carries most parallel edits through a merge. Any session that merges after
the move re-applies its compose edits at the new path. 0001b lists every pinned path to fix
(about 25 in the ai-trading lane, about 15 in the expense lane, from the probe).

---

## 5. Networking decision matrix

| Criterion | Cloudflare tunnel only | Tailscale only | **Both (recommended)** |
|---|---|---|---|
| Public hostnames | Yes, as today (CNAME to the tunnel; no inbound ports) | No. Funnel exists, but means new DNS and no Workers integration | Tunnel |
| Admin and CI SSH | Needs Cloudflare Access plus `cloudflared access ssh`. Access onboarding is a separate owner-approved exception (ai-trading AGENTS.md "Infrastructure") | Native: tailnet SSH to port 2222, strict host keys kept | Tailscale |
| Latency | Edge PoP to home over the tunnel; fine for family scale | Direct WireGuard, or a DERP relay behind CGNAT | Same as each column |
| Security | Zero inbound ports; Clerk gate as today | Zero inbound ports; identity-based ACL | Zero inbound ports on the home router either way |
| Failure modes | Cloudflare outage takes down the public apps (true today) | Tailscale coordination outage blocks new CI joins; existing sessions keep working | Each failure affects only its own lane: public traffic never depends on Tailscale |
| Terraform | Existing roots; nothing new | New `tailscale/` root | Existing roots plus the new `tailscale/` root |
| New credentials | Access service token (if SSH goes through Cloudflare) | Tailscale OAuth clients (Terraform and CI) | Tailscale OAuth clients |

**Recommendation: both** (Q1). Cloudflare tunnels serve every public hostname, with DNS
unchanged. Tailscale is for SSH by the owner, operator sessions and CI. The bridge-to-edge path
uses neither: it is local (§3.4).

---

## 6. CI/CD redesign

### 6.1 Options for GitHub-hosted runners to reach a laptop on home WiFi

| Option | How | Pros | Cons |
|---|---|---|---|
| **A. Tailscale from the runner (recommended)** | Pinned `tailscale/github-action` with `oauth-client-id`, `oauth-secret` and `tags: tag:ci`; ephemeral node per job; then the existing scp/ssh to the laptop's tailnet name on port 2222 | Keeps `deploy.sh` flows, strict host keys and existing tests. No inbound port. Nodes clean themselves up | One new credential pair. Runs depend on Tailscale coordination |
| B. Cloudflare Access SSH | `cloudflared access ssh` through an Access app plus a service token | Uses the existing vendor | Needs the Access onboarding exception and a new Terraform surface; adds a ProxyCommand to two workflows |
| C. Self-hosted runner on the laptop | The runner polls GitHub; no inbound | No network path needed | **Public repo**: fork PRs can target self-hosted runners, and the runner needs docker/root, which means full host compromise. GitHub advises against self-hosted runners on public repos. Not recommended |

**Recommendation: A** (Q2).

### 6.2 Changes

1. **Firestore** (Q3):
   - Create **`shared/laptop`** with the **same key names** as `shared/vps` (`VPS_HOST` is the
     laptop's tailnet name, `VPS_PORT=2222`, `VPS_USER`, `VPS_SSH_KNOWN_HOSTS` from a keyscan
     over the tailnet, new deploy and operator key pairs). The same key names keep the workflow
     and script diffs to a group name.
   - Keep `shared/vps` **untouched until 0001f**: rollback needs it.
   - Repoint the `ai-trading/deploy` links to `shared/laptop` at cutover.
   - Add `shared/tailscale` (§3.3).
   - `shared/vps-postgres` and `shared/vps-backup` keep their names. Their values describe the
     cluster and the bucket, not the host, and ADR-0007 treats profile names as stable.
2. **`ai-trading-deploy.yml`:**
   - Add a dispatch input `target: vps | laptop`, which selects the Firestore group, and
     `dark: true|false` for staging ([0001c](subplans/0001c-staging-bring-up.md)).
   - Add the Tailscale step before scp, with OAuth credentials fetched from `shared/tailscale`
     after WIF, masked.
   - Rename "Deploy to the VPS" to "Deploy to the host".
   - At cutover, the push default flips to `laptop`.
3. **`expense-tax-deploy.yml`** (expense lane, 0001b-2):
   - Same Tailscale step.
   - Credentials come as GitHub environment secret **copies** (`TS_CI_OAUTH_CLIENT_ID`,
     `TS_CI_OAUTH_SECRET`), set with `gh secret set` from Firestore. This is the documented
     CI-copy pattern, because the deploy has no GCP auth and a test pins that.
   - Repoint `vars.VPS_*`, `secrets.VPS_DEPLOY_SSH_KEY` and `VPS_DEPLOY_KNOWN_HOSTS` at cutover.
   - Add a `workflow_dispatch` with `target` and `dark` for staging. A dispatch to `main` needs
     owner confirmation at execution time (expense AGENTS.md).
4. **Strict host keys stay.** `VPS_SSH_KNOWN_HOSTS` holds the laptop's ed25519 key for
   `[<tailnet-name>]:2222`. Use `StrictHostKeyChecking=yes` and no keyscan in CI. Tailscale SSH
   is not used for CI, so the host-key contract and tests stay as they are.
5. **The host needs a deploy user with passwordless sudo** (same as `ubuntu` on the VPS), a
   rootful Docker, and systemd: the existing requirements.
6. **Unchanged:** builds and GHCR pushes, static uploads (WIF to buckets), the Terraform
   workflows, and the backup-freshness workflow.

---

## 7. Data migration

### 7.1 Per datastore

| Store | Rehearsal (0001d) | Cutover (0001e) | Validation |
|---|---|---|---|
| Postgres cluster (6 DBs) | `restore.sh` from the newest monthly plus daily GCS objects into the laptop cluster. This proves the DR path on the target host | **Cold physical copy**: stop the VPS cluster, stream the data dir VPS → operator Mac → laptop (`tar` + `zstd`, no keys on the laptop), start the same image digest on the laptop | Same DB list; `pg_database_size` per DB within 1%; exact `count(*)` per user table diffed before and after (empty diff); `alembic current` (Desk) and expense migration heads equal; Temporal `expense-tax` namespace present |
| `replay_blobs` | Missing after a logical restore (excluded from backups by design) | Carried by the physical copy | Row count equal. If ever lost, it refills from Alpaca |
| ai-trading volumes (9) | Full copy | Final full copy during the freeze. If the probe shows large volumes, an rsync delta pass instead (warm copy on day T-2) | Per volume: file count, `du -sb`, sorted sha256 manifest digest equal |
| `control.json` | Copy | Copy | Content hash equal; Settings page shows the same on/off state |
| Expense receipts and inbound volumes | Restored from the backup's `receipts.tar` | Final copy during the freeze | Same manifest check |
| Temporal | Lives in Postgres | Lives in Postgres | Namespace and schedules listed; worker connects |

**Sizes.** To be filled from the 0001d step-0 probe. **Gate:** the measured relay throughput must
fit the whole cutover copy inside a 30-minute freeze. If it does not, switch the volumes to the
warm-rsync path, and consider logical replication for Postgres (not expected at family scale).

### 7.2 Why a cold physical copy at cutover

- It is exact: same pg17 image digest, same architecture (x86_64 on both; checked in 0001d),
  and glibc inside the image, so no collation drift.
- It carries roles, passwords, per-DB role settings, grants and caches.
- The 2026-10-12 restore drills found four logical-restore defects (phase-3 doc:7426). All are
  fixed, but a physical copy has no such class of defect at all.
- **Rollback stays simple.** The VPS data dir is never modified after the freeze.

The logical path still runs in the rehearsal, so the disaster-recovery story is proven on the new
host.

### 7.3 Backups after the move

1. At the freeze, run one last VPS backup (`systemctl start family-app-backup.service`), then
   **disable the VPS timer**, so two hosts never write.
2. Install the laptop backup with `bootstrap.sh --only backup`: new `BACKUP_HOST_ID` (for
   example `family-laptop-1`), the same bucket, the same writer key from `shared/vps-backup`.
3. Fix `40-backup.sh`'s Postgres password source for the real layout (0001b).
4. Check that the 512 MiB staging tmpfs holds the plaintext dumps plus the receipt tar at the real
   sizes; raise it if not.
5. Run the first laptop backup inside the cutover window, and a restore drill from laptop-written
   objects inside the rollback window. The freshness workflow needs no change.

### 7.4 Firestore reader key on the laptop

`install-reader-key.sh` **deletes every older user-managed key** after it verifies the new one
(`install-reader-key.sh:59-62`). Run unchanged against the laptop, it would revoke the VPS's key
and break VPS deploys during the rollback window. 0001b therefore adds:

- a `--profile <group>` argument (default `shared/vps`; the laptop uses `shared/laptop`);
- `--keep-existing` (install and verify only; delete nothing).

The VPS key is deleted in 0001f. The SA's display name "(VPS)" becomes host-neutral in the same
change.

---

## 8. Execution phases

| Phase | Subplan | Who | Gate to next |
|---|---|---|---|
| a | [Laptop bootstrap](subplans/0001a-laptop-bootstrap.md) | Owner Day-0, then agent | SSH over the tailnet with pinned host keys; host bootstrap tests green on the real host |
| b | [IaC consolidation](subplans/0001b-iac-consolidation.md) | ai-trading/infra lane (b-1), expense lane (b-2) | No-op VPS redeploy of both apps from the moved paths; all pinned-path tests green |
| c | [Staging bring-up](subplans/0001c-staging-bring-up.md) | Agent | Both stacks healthy **dark** on the laptop through the real CI path (`target=laptop dark=true`) |
| d | [Data migration and validation](subplans/0001d-data-migration-validation.md) | Agent; owner approves the probe numbers | Full rehearsal passes the parity checks; freeze estimate under 30 minutes |
| e | [Cutover](subplans/0001e-cutover.md) | Agent plus owner present | Every hostname and every critical flow verified; rollback window opens |
| f | [VPS decommission](subplans/0001f-vps-decommission.md) | Owner (OVH account) plus agent | Rollback window closed clean; final archive verified |
| g | [Post-cutover hardening](subplans/0001g-post-cutover-hardening.md) | Agent | Backups, monitoring, update policy and DR runbook live; docs reconciled |

Suggested calendar (owner sets dates, Q15):
- Nov 2026: a, b, c.
- Early Dec 2026: d (two rehearsals).
- A weekend in mid-December 2026: e.
- 14-day rollback window.
- By 2027-01-31: f.
- g runs alongside the rollback window.

---

## 9. Open questions for Hermes

Each question has a recommendation; **bold** marks the recommended answer.

1. **Network model.** Tunnel only, Tailscale only, or **both: Cloudflare tunnels for public
   hostnames, Tailscale for admin and CI SSH** (§5).
2. **CI path.** **Ephemeral Tailscale node per job from GitHub-hosted runners**, Cloudflare Access
   SSH, or a self-hosted runner. The self-hosted runner is rejected: public repo, and a
   docker/root runner means host compromise (§6.1).
3. **Firestore shape.** **A new `shared/laptop` with the same key names; `shared/vps` kept until
   decommission; `vps-postgres` and `vps-backup` names unchanged; a new `shared/tailscale`.**
   Also: may the Tailscale OAuth clients be created once in the admin console if the Terraform
   provider cannot create them? **Yes, as a named exception like the Cloudflare token scope.**
4. **02t ruling 4 (sidecar).** Re-scope it post-cutover to **the local host-gateway path; keep
   the "ACL as code" part for admin and CI only**. If B1 starts less than about 3 weeks before
   cutover, **wait** and never build the sidecar (§3.4).
5. **Postgres cutover method.** **Cold physical copy at cutover; logical restore from GCS in the
   rehearsal** (§7.2).
6. **Postgres container name on the laptop.** **`family-app-postgres` (the IaC default), with the
   project pinned to `postgres`, so `postgres_default` and the alias `postgres` do not change.**
   The alternative keeps `expense-tax-postgres`, which needs no script default changes but keeps
   a misleading name.
7. **Power policy.** **Never sleep (masked targets, lid ignored); BIOS AC-restore on; charge
   limit about 80% if supported; security-only unattended upgrades with Saturday-only reboots;
   lid open or a stand.**
8. **Network link.** **Wired Ethernet plus a DHCP reservation, and a small UPS for the modem and
   router.** WiFi works, but every drop is an outage.
9. **Disk encryption.** **LUKS with TPM2 auto-unlock**, rather than a passphrase at boot (blocks
   unattended reboots) or no encryption (family financial data plus credentials on a portable
   machine).
10. **Disk sizing.** **A dedicated partition or logical volume of at least 500 GB for
    `/var/lib/docker`, plus an 8 GiB swapfile.**
11. **Expense consolidation.** **Yes: a separate expense-lane run (0001b-2) under expense
    AGENTS.md**, so package rules win in-package. It also moves
    `expense-tax-management/infrastructure/gcp/expense-tax/`.
12. **Rename `infrastructure/vps/` to `infrastructure/host/`.** **Yes, in 0001b-1.** All
    references are grep-able, the VPS ends in February 2027, and the same scripts serve any future
    DR host. Dropping the rename saves about 10 path edits.
13. **Staging hostnames.** **None.** Do dark checks over the tailnet plus full browser checks
    inside the rollback window. Staging hostnames would churn Clerk origins, allowlists and the
    tunnel config.
14. **Monitoring.** **`cloudflare_notification_policy` tunnel-health alerts in both Cloudflare
    roots, plus the existing backup-freshness workflow**, rather than a new uptime vendor or a
    frequent Actions cron (minutes rule).
15. **Dates.** **Cutover on a mid-December 2026 weekend, outside market hours, away from the
    00:00/12:00 UTC backups and the 02:00 mailbox scan; a 14-day rollback window; decommission
    by 2027-01-31.**
16. **DR after the VPS is gone.** **No standby host. A tested "bootstrap plus restore onto any
    Ubuntu box" runbook, drilled quarterly (2-hour RTO target).**
17. **Home LAN isolation.** **A guest or isolated VLAN for the laptop if the router supports
    it.** Otherwise accept the risk, with tailnet-only SSH and loopback-only ports.
18. **OS edition.** **Ubuntu 24.04 Desktop**: IB Gateway needs a GUI session, and GNOME Remote
    Desktop over the tailnet serves the daily ritual when the owner is away from the machine.
19. **Who applies `infrastructure/tailscale/`.** **The operator from their machine, like the
    `gcp/` roots**, validated in the existing `ai-trading-infra.yml` PR job. Do not add a new
    workflow.

---

## 10. Findings for the orchestrator (not fixed here)

Read-only. Defects and status files are the orchestrator's to edit.

1. **Public-repo hygiene.** These files commit values that root AGENTS.md forbids:
   - `infrastructure/cloudflare/expense-tax/README.md:144` (VPS IPv4 and a local key path in an
     example);
   - `docs/superpowers/specs/2026-10-05-family-config-firestore-design.md:364` (VPS address);
   - `expense-tax-management/infrastructure/gcp/expense-tax/README.md` (org and billing account
     IDs).

   The values are not repeated here.
2. **Stale docs.** Backup is described as deferred in
   `expense-tax-management/plans/ROADMAP.md:3,59-60`, `infrastructure/README.md:60-65` and
   `infrastructure/vps/README.md:163-174`, but it has been live since 2026-10-12.
   `ai-trading/deploy/production/README.md:262-269` says volume data "is not copied" on a host
   move; this plan copies it. 0001g reconciles all of these.
3. **Container-name ambiguity, resolved.** The live cluster is `expense-tax-postgres`, project
   `postgres` (phase-3 doc:7396-7398). `production-activation-runbook.md:320` calls the name
   "not determinable". Q6 settles the target.
4. **`install-reader-key.sh` revokes all older keys** (§7.4). Do not run it for the laptop before
   0001b adds `--keep-existing`.
5. **Replay-blob figure.** The brief says 1.4 GB; the repo records up to 1.8 GB
   (`infrastructure/backup/backup.sh:122-124`).
6. **02u** (`ai-trading/plans/subplans/02u-central-market-data-api.md`) is not on `dev` at
   `e03ef3c7`. Its H1 archive DB lands in the shared cluster and is covered by §3.5 and by the
   backup job's "every DB" scope.
