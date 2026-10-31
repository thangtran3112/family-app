# ADR-0007: Firestore `family-config` holds every secret

Status: standing rule. Source: `common/config/README.md`, AGENTS.md.

Decision: every ai-trading secret and env value lives in Firestore `family-config` (project `tobytran-portfolio`), read and written **only** through `common/config/family_config.py`. Targets are `shared/<group>` or `<app>/<profile>`; `run`/`render` take only `<app>/<profile>`, never a bare group. **No `.env` files, keys, or tokens in the repo, not even gitignored ones.** Deploy renders profiles straight from Firestore on the VPS; CI only ever fetches the tunnel token and deploy SSH material.

Consequences: changing a key means editing Firestore, never code; the public repo stays committable; profile names (`ai-trading/market-data-bridge`, `ai-trading/consensus`, ...) are stable infrastructure even when code layout moves.
