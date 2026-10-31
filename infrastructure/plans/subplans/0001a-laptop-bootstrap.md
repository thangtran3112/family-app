# 0001a: Laptop bootstrap (owner's Day-0, then the agent's host bootstrap)

Parent: [0001](../0001-laptop-migration.md) §3, §6. Next: [0001b](0001b-iac-consolidation.md)
can run in parallel, because it touches only the repository.

**Outcome:** the laptop is a reachable, hardened, always-on Docker host on the tailnet. No family
data and no tunnel connector run on it yet.

## Part 1: Owner Day-0 (hands on the machine)

Steps on the machine, in order.

1. **Firmware (BIOS/UEFI):**
   - Update the firmware.
   - Enable TPM 2.0 and virtualization (VT-x).
   - Set "restore on AC power loss" to **on** (Q7).
   - Set a battery charge limit (about 80%) if the firmware offers one.
   - Set Secure Boot to the default (on).
2. **Install Ubuntu 24.04 LTS Desktop** (Q18):
   - Minimal installation.
   - **LUKS full-disk encryption** (Q9). The installer's TPM-backed option is acceptable.
     Otherwise use a passphrase now; the agent adds TPM2 auto-unlock with clevis in Part 2.
     **Record the recovery passphrase in the owner's password manager, not in Firestore and not
     in the repo.**
   - Partitioning: give **`/var/lib/docker` its own partition or LVM logical volume of at least
     500 GB** (Q10). If the installer makes this awkward, create one large root and say so; the
     agent then moves Docker's data-root to a logical volume in Part 2.
3. **Network:**
   - Plug in wired Ethernet if possible (Q8).
   - Add a DHCP reservation on the router.
   - Put the laptop on a guest or isolated VLAN if the router supports it (Q17).
   - Give the modem and router a small UPS if available.
4. **Base packages:** `sudo apt update && sudo apt install -y openssh-server curl`.
5. **Ops user.** Create a dedicated, non-desktop ops user for deploys, for example `family-ops`,
   with passwordless sudo, matching `ubuntu` on the VPS. The owner's own desktop account stays
   separate; IB Gateway runs there later.
6. **Tailscale:**
   - Install Tailscale from the official apt repository.
   - Join the tailnet with the **tagged pre-auth key** that the operator generates from
     `infrastructure/tailscale/` (0001b-1 creates that root). Until then, join interactively.
     The agent re-tags the device in Part 2.
   - Disable key expiry for this device. The Terraform root manages the tag.
7. **Operator key.** Install the operator public key into `~family-ops/.ssh/authorized_keys`.
   The agent provides the new `shared/laptop` operator public key; this step never needs a
   private key.
8. **Lid and power for now.** Keep the lid open and AC connected. The agent's `05-power.sh`
   step makes this permanent.
9. **Hand over** the laptop's tailnet name (sent privately; the agent stores it in Firestore
   `shared/laptop` `VPS_HOST`). Confirm that the operator machine can reach
   `ssh -p 22 family-ops@<tailnet-name>`. Port 2222 comes in Part 2.

### Owner handover checklist (copy into the session)

- [ ] Firmware updated; TPM on; AC-restore on; charge limit set (or not supported)
- [ ] Ubuntu 24.04 Desktop installed with LUKS; recovery passphrase stored by the owner
- [ ] `/var/lib/docker` partition or LV of 500 GB or more (or "single root, agent to fix")
- [ ] Ethernet with DHCP reservation, or WiFi (decision noted)
- [ ] `family-ops` user with passwordless sudo; operator public key installed
- [ ] Tailscale joined; key expiry disabled; tailnet name handed over
- [ ] `ssh` works from the operator machine over the tailnet

## Part 2: Agent host bootstrap (over SSH, from the operator machine)

The steps use the consolidated scripts from 0001b-1. If 0001b-1 has not merged yet, use the same
steps from `infrastructure/vps/`. They are compatible apart from the new steps 05, 15 and 35.

1. **Firestore** (names only; values are never printed):
   - Create `shared/laptop`: `VPS_HOST`, `VPS_PORT=2222`, `VPS_USER=family-ops`.
   - Add new `VPS_DEPLOY_SSH_{PRIVATE,PUBLIC}_KEY` and `VPS_OPERATOR_SSH_{PRIVATE,PUBLIC}_KEY`,
     generated locally and streamed in with `family_config.py set`.
   - Create `shared/tailscale`: the OAuth client credentials for Terraform and CI (0001 §3.3).
2. **Tailscale Terraform** (operator applies `infrastructure/tailscale/`):
   - tag owners for `tag:family-host` and `tag:ci`;
   - ACL: `autogroup:admin` and `tag:ci` to `tag:family-host:2222`, nothing else;
   - the laptop's tagged auth key.
   - Re-tag the device as `tag:family-host`.
3. **Pin the host keys.** `ssh-keyscan -p 22 -t ed25519 <tailnet-name>` over the tailnet, compared
   against the fingerprint the owner reads on the console (`ssh-keygen -lf
   /etc/ssh/ssh_host_ed25519_key.pub`). Store the matching line in `shared/laptop`
   `VPS_SSH_KNOWN_HOSTS`, rewritten for `[<tailnet-name>]:2222` after step 4.
4. **Run `bootstrap.sh`** against `shared/laptop`. It runs these steps, in order:
   - `00-firewall`: UFW default-deny inbound. SSH is allowed **on `tailscale0` only**; 80 and 443
     are **not** opened. Docker-subnet access to the future edge port is added in B1.
   - `05-power` (new):
     - mask `sleep.target`, `suspend.target`, `hibernate.target` and `hybrid-sleep.target`;
     - logind `HandleLidSwitch=ignore` and `HandleLidSwitchExternalPower=ignore`;
     - GNOME idle-suspend off;
     - an 8 GiB swapfile;
     - `unattended-upgrades` for security updates only, with
       `Automatic-Reboot-Time` on Saturdays only (a systemd timer gate);
     - journald capped at 512 MiB (the VPS lesson, STATUS.md:73).
   - `10-harden-ssh`: port 2222, key-only, no root password login. **Keep the current session
     open until a new session on 2222 succeeds.**
   - `15-tailscale` (new): makes sure tailscaled is enabled; checks the tag.
   - `20-docker`: Docker Engine from get.docker.com, rootful, with **no** userns-remap
     (app-controls refuses it); data-root on the dedicated partition; `family-ops` in the docker
     group; the log driver `local` with size caps.
   - **LUKS TPM2 auto-unlock** (if the installer did not do it): bind `clevis-luks` to TPM2
     PCR 7. **Owner-gated:** the owner confirms one unattended reboot comes back up.
5. **Reader key.** Run `install-reader-key.sh --profile shared/laptop --keep-existing` (the 0001b
   change). Verify with `family_config.py keys expense-tax-management/production` on the host.
   **Never run the unmodified script; it deletes the VPS's key** (0001 §7.4).
6. **Do not install yet:** Postgres, Temporal, the backup job and cloudflared. They come in 0001c
   and 0001e.

## Gates

- [ ] SSH over the tailnet on 2222 with `StrictHostKeyChecking=yes` and the `shared/laptop` known
      hosts, using both the operator key and the deploy key
- [ ] SSH does **not** answer on the LAN IP or on port 22 (checked from another LAN device)
- [ ] `systemctl status sleep.target` shows it masked; a closed lid for 10 minutes on AC leaves the
      host reachable
- [ ] One unattended reboot comes back on the tailnet with no keyboard input (TPM unlock)
- [ ] `docker info`: rootful, no userns, data-root on the large partition; `df -h` shows 500 GB or
      more there
- [ ] Firestore read with the laptop's reader key works; the VPS still deploys (its key is intact)
- [ ] `infrastructure/host/test-bootstrap.sh` green against the new steps (offline test in CI)

## Owner-gated items

Firmware and OS install, disk encryption choice, network and VLAN, UPS, the TPM reboot test, and
reading the host-key fingerprint on the console.

## Rollback

Nothing in production depends on the laptop yet. Rollback means wiping and reinstalling the
laptop, deleting `shared/laptop`, and removing the laptop's reader key with `gcloud iam
service-accounts keys delete` on that key id only.
