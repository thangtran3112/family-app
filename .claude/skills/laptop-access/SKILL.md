---
name: laptop-access
description: Use when SSHing to the family-app Ubuntu laptop (192.168.1.78 / staging host), running sudo there, deploying or debugging anything on the host, or when SSH to the laptop fails, asks for a password, or the key errors with "invalid format". Gives every harness the passwordless path - key from Firestore, BatchMode, sudo -n - and the hard rule to never prompt the owner.
---

# Passwordless access to the family-app laptop

The host: Ubuntu laptop, user `family-app`, LAN address `192.168.1.78`, sshd on port 22
(LAN) and 2222 (tailnet). `family-app` has `NOPASSWD:ALL` sudo (verify, never assume).
No harness or agent may ever prompt the owner for this machine's password.

## The invariant (why prompts happened, and how to never cause one)

Three conditions together make prompting impossible. All three are live; keep them that way:

1. **A valid key.** The operator key lives in Firestore `shared/laptop`
   `VPS_OPERATOR_SSH_PRIVATE_KEY`, stored **with its final newline** (`set --raw`,
   below). A key stored without the trailing newline is byte-short, and macOS `ssh`
   and `ssh-keygen` reject it as `invalid format` - which makes auth fail and fall
   back toward a password prompt. This is the exact bug that produced the "sudo
   password" prompts on 2026-10-31; the fix is one byte.
2. **No password path exists.** sshd on the laptop has `PasswordAuthentication no`
   and `KbdInteractiveAuthentication no`. A failed key fails fast; nothing can prompt.
3. **Non-interactive sudo.** Always `sudo -n`. `sudo` without `-n` is a bug in any
   script an agent runs: it hangs or, with a TTY, prompts.

## Connect (copy-paste, no prompts possible)

```bash
cd <repo root>
./common/config/family_config.py with-file shared/laptop VPS_OPERATOR_SSH_PRIVATE_KEY -- \
  bash -c 'ssh -i "$1" -p 22 -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
    -o ConnectTimeout=12 family-app@192.168.1.78 "sudo -n whoami"' _ {}
```

- `BatchMode=yes` disables every interactive auth method. With it, a broken key
  errors out instead of prompting. Use it in every command, script, and harness.
- Reach from other networks: `laptop-ssh.tobytran.dev` through Cloudflare Access
  (skill `manage-cloudflare-tunnel`), or the tailnet break-glass path (skill
  `manage-family-tailscale`). The LAN address only works on the home network.
- The deploy key `VPS_DEPLOY_SSH_PRIVATE_KEY` is used by CI; same storage rule.

## Storing or re-storing a key (the one-byte trap)

```bash
./common/config/family_config.py set shared/laptop VPS_OPERATOR_SSH_PRIVATE_KEY --raw \
  < ~/.ssh/id_ed25519_laptop
```

`--raw` keeps the trailing newline. Without it the CLI strips the last newline and
the key is invalid on every macOS consumer. Verify after any store:

```bash
./common/config/family_config.py with-file shared/laptop VPS_OPERATOR_SSH_PRIVATE_KEY -- \
  bash -c 'ssh-keygen -y -f "$1" >/dev/null && echo VALID || echo BROKEN' _ {}
```

Public halves also live in Firestore (`VPS_OPERATOR_SSH_PUBLIC_KEY`); a stored key
is authentic when its derived public key matches that value.

## Preflight when access fails

| Symptom | Meaning | Fix |
|---|---|---|
| `Load key ...: invalid format` | Stored key lost its trailing newline (or worse) | Re-store with `set --raw` from the local key `~/.ssh/id_ed25519_laptop` |
| `Permission denied (publickey)` with a valid key | Not the authorized key, or a different user | Compare `ssh-keygen -y` output to `VPS_OPERATOR_SSH_PUBLIC_KEY` |
| `sudo: a password is required` / `sudo -n` fails | NOPASSWD rule changed | `/etc/sudoers.d/family-app` must contain `family-app ALL=(ALL) NOPASSWD:ALL`; repair via console, never by prompting |
| A script hangs at `sudo` | Someone wrote `sudo` without `-n` | Fix the script; there is no password to type and prompting is never the answer |
| DNS name `*.tail3c367b.ts.net` unresolvable | That is the tailnet MagicDNS name; this Mac is not on that tailnet | Use the LAN IP on the home network, the Access hostname elsewhere |

## Hard boundary

- Never print, log, or commit a key value; verify by fingerprint and exit code.
- Never remove `BatchMode=yes` to "make it work" - that converts a failure into a
  password prompt, which is the one outcome this skill exists to prevent.
- Never write a password into a script, a command, or a harness prompt. The
  password in `ai-trading/temp/.env` is for the owner's console use only.
- Do not enable `PasswordAuthentication` on the laptop. If a key path breaks, fix
  the key; console access is the break-glass, not password auth.
