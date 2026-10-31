#!/usr/bin/env python3
"""Laptop staging tunnels and hostnames (0001c). NOT production: new tunnels, new `staging*` names.

Creates two remotely-managed Cloudflare tunnels, their ingress and proxied CNAMEs, using the
shared Cloudflare token. Never touches an existing record: it refuses any hostname that already
exists without this script's comment marker, so production DNS cannot be edited by mistake.

  CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_ZONE_NAME=... provision.py apply
  ... provision.py token trading|expense     # prints that tunnel's connector token (pipe it, never log it)
  ... provision.py destroy                   # removes only the records/tunnels this script owns

ponytail: plain API calls, not Terraform (staging is disposable); move to a TF root if it outlives cutover.
"""
import json
import os
import sys
import urllib.error
import urllib.request

API = "https://api.cloudflare.com/client/v4"
MARK = "family-app laptop staging (0001c)"
ZONE = os.environ.get("CLOUDFLARE_ZONE_NAME", "tobytran.dev")
ACCOUNT = os.environ["CLOUDFLARE_ACCOUNT_ID"]
TOKEN = os.environ["CLOUDFLARE_API_TOKEN"]

GATEWAY, WEB = "http://gateway:8080", "http://web:3000"


def host_rewrite(service, host):
    return {"service": service, "originRequest": {"httpHostHeader": host}}


# tunnel key -> (tunnel name, ingress rules without the final catch-all)
TUNNELS = {
    "trading": (
        "family-laptop-staging-trading",
        [  # connector runs in a container on ai-trading_gateway + ai-trading_hub (compose service names)
            {"hostname": f"staging.{ZONE}", "path": "^/u/tradingagents(/.*)?$", "service": GATEWAY},
            {"hostname": f"staging.{ZONE}", "path": "^/u/ai-hedge-fund(/.*)?$", "service": GATEWAY},
            {"hostname": f"staging.{ZONE}", "path": "^/__auth/.*$", "service": GATEWAY},
            {"hostname": f"staging.{ZONE}", "service": WEB},
            {"hostname": f"staging-origin.{ZONE}", "service": GATEWAY},
            {"hostname": f"staging-vibe.{ZONE}", **host_rewrite(GATEWAY, f"vibe-trading.{ZONE}")},
            # Host passes through unchanged: the gateway Caddyfile has `staging-*` aliases for these two
            # and derives the hub login origin from the host, so a signed-out redirect stays on staging.
            {"hostname": f"staging-tradingagents.{ZONE}", "service": GATEWAY},
            {"hostname": f"staging-ai-hedge-fund.{ZONE}", "service": GATEWAY},
        ],
    ),
    "expense": (
        "family-laptop-staging-expense",
        [  # connector runs on the host (systemd): origins are loopback ports
            {"hostname": f"staging-expense.{ZONE}", "service": "http://127.0.0.1:7301"},
            {"hostname": f"staging-expense-api.{ZONE}", "service": "http://127.0.0.1:8100"},
            {"hostname": f"staging-expense-capture.{ZONE}", "service": "http://127.0.0.1:7301"},
            {"hostname": f"staging-expense-office.{ZONE}", "service": "http://127.0.0.1:7302"},
            {"hostname": f"staging-expense-foundry.{ZONE}", "path": "/internal/v1/*", "service": "http://127.0.0.1:8200"},
            {"hostname": f"staging-expense-foundry.{ZONE}", "service": "http://127.0.0.1:7303"},
            {"hostname": f"staging-expense-mailbox.{ZONE}", "path": "/oauth/google/callback", "service": "http://127.0.0.1:8300"},
            {"hostname": f"staging-expense-mailbox.{ZONE}", "path": "/oauth/google/begin", "service": "http://127.0.0.1:8300"},
        ],
    ),
}


def call(method, path, body=None):
    req = urllib.request.Request(
        API + path,
        method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.load(resp)
    except urllib.error.HTTPError as err:
        data = json.load(err)
        sys.exit(f"{method} {path} -> HTTP {err.code}: {[e.get('message') for e in data.get('errors', [])]}")
    if not data.get("success"):
        sys.exit(f"{method} {path} failed: {[e.get('message') for e in data.get('errors', [])]}")
    return data["result"]


def zone_id():
    zones = call("GET", f"/zones?name={ZONE}")
    if len(zones) != 1:
        sys.exit(f"zone {ZONE} not found")
    return zones[0]["id"]


def find_tunnel(name):
    found = call("GET", f"/accounts/{ACCOUNT}/cfd_tunnel?name={name}&is_deleted=false")
    return found[0] if found else None


def apply():
    zid = zone_id()
    wanted = {r["hostname"] for _, rules in TUNNELS.values() for r in rules}
    for host in sorted(wanted):  # fail closed before creating anything
        for rec in call("GET", f"/zones/{zid}/dns_records?name={host}"):
            if rec.get("comment") != MARK:
                sys.exit(f"refusing: {host} already exists and is not owned by this script")
    for key, (name, rules) in TUNNELS.items():
        tunnel = find_tunnel(name) or call(
            "POST", f"/accounts/{ACCOUNT}/cfd_tunnel", {"name": name, "config_src": "cloudflare"}
        )
        call("PUT", f"/accounts/{ACCOUNT}/cfd_tunnel/{tunnel['id']}/configurations",
             {"config": {"ingress": rules + [{"service": "http_status:404"}]}})
        target = f"{tunnel['id']}.cfargotunnel.com"
        for host in sorted({r["hostname"] for r in rules}):
            existing = call("GET", f"/zones/{zid}/dns_records?name={host}")
            record = {"type": "CNAME", "name": host, "content": target, "proxied": True, "comment": MARK}
            if existing:
                call("PUT", f"/zones/{zid}/dns_records/{existing[0]['id']}", record)
            else:
                call("POST", f"/zones/{zid}/dns_records", record)
        print(f"{key}: tunnel {name} ready, {len({r['hostname'] for r in rules})} hostnames")


def token(key):
    tunnel = find_tunnel(TUNNELS[key][0])
    if not tunnel:
        sys.exit("tunnel does not exist; run apply first")
    result = call("GET", f"/accounts/{ACCOUNT}/cfd_tunnel/{tunnel['id']}/token")
    sys.stdout.write(result if isinstance(result, str) else result["token"])


def destroy():
    zid = zone_id()
    for name, rules in TUNNELS.values():
        for host in sorted({r["hostname"] for r in rules}):
            for rec in call("GET", f"/zones/{zid}/dns_records?name={host}"):
                if rec.get("comment") == MARK:
                    call("DELETE", f"/zones/{zid}/dns_records/{rec['id']}")
        tunnel = find_tunnel(name)
        if tunnel:
            call("DELETE", f"/accounts/{ACCOUNT}/cfd_tunnel/{tunnel['id']}/connections")
            call("DELETE", f"/accounts/{ACCOUNT}/cfd_tunnel/{tunnel['id']}")
        print(f"removed {name}")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "apply":
        apply()
    elif cmd == "token" and len(sys.argv) == 3 and sys.argv[2] in TUNNELS:
        token(sys.argv[2])
    elif cmd == "destroy":
        destroy()
    else:
        sys.exit(__doc__)
