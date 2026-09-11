# Production Clerk Runtime Status

## Runtime

- Issuer/frontend API: `https://clerk.tobytran.dev`
- JWKS: `https://clerk.tobytran.dev/.well-known/jwks.json`
- Tenant audience: `expense-app`
- Platform audience: `expense-foundry-platform`
- App target: `mch_3JAI0juruFRPSkrE1rpcDKx1k1i`
- Foundry target: `mch_3JAIAMNUiVXteVOki8QENYHvJjp`
- App worker source: `mch_3JAIPnx8itUTJsizuEGewr6NGBX`
- Foundry worker source: `mch_3JAIi2BwnqBf8bNzbjTtjJa6nGw`

No production Clerk secrets or publishable keys belong in repository files.

## Production State

- Secret Manager version `3` is sole enabled production bundle; prior version destroyed.
- Capture, Office, Foundry, App API, and worker images deployed through GitHub CI/CD.
- Private Cloudflare Tunnel routes five product hosts; VPS app ports remain loopback-only.
- Clerk invitation links use ticket-based `/accept-invitation`; invited email is authoritative, CAPTCHA mounts before signup, and password minimum is 8.
- Clerk SPF/DKIM DNS records verified. DMARC record is managed by Terraform: `v=DMARC1; p=none; adkim=s; aspf=s`.

## Verification

- Full CI and production deploy workflows pass.
- HTTPS host routing and API health checks pass.
- M2M probes validate issuer, source subject, target audience, scope, `jti`, and `exp`.
- Remaining verification requires users to finish signup, PostgreSQL identity/operator mappings, webhook configuration, and authenticated smoke tests.
