# ai-trading Production Runbook

Release 1 runs the Trading Hub and three unmodified upstream apps on one host behind a dedicated Cloudflare Tunnel. Caddy and Clerk enforce the family session on every upstream route; Cloudflare Access is deferred. Design: `ai-trading/plans/subplans/01-release-1-hub-design.md`. Infrastructure as code: `ai-trading/plans/subplans/01c-release-1-infra-plan.md`.

| Service | Reached at | Notes |
|---|---|---|
| hub (Worker + GCS) | `https://trading-hub.tobytran.dev/` | Static hub from GCS; `/u/*` and `/__auth/*` through `trading-origin` to Caddy (01l) |
| `web` | `https://trading.tobytran.dev/` | The same hub, interim host until Desk Phase 4 takes it |
| `ta-terminal` | `https://tradingagents.tobytran.dev/` | TradingAgents in ttyd + tmux; also `/u/tradingagents/` on the hub |
| `ta-research` | internal only (own `research` network, port 8182) | Private, owner-scoped TradingAgents research API + static shell (06); `/research`, `/research/*`, `/api/research`, `/api/research/*` at the dedicated host, `/u/tradingagents/research...` on the hub. Own `ta-research-data` volume, never shares `ta-terminal`'s `ta-data`. Never on `ta` with `ta-terminal` -- see "Research (06)" below |
| `ahf-terminal` | `https://ai-hedge-fund.tobytran.dev/` | ai-hedge-fund in ttyd + tmux; also `/u/ai-hedge-fund/` on the hub |
| `market-data` | internal only (`ahf` network, port 8000) | Financial Datasets-shaped API for ai-hedge-fund: Alpaca free daily bars + SEC EDGAR fundamentals (01m). Missing Alpaca or SEC values return 502, never empty data |
| `vibe-trading` | `https://vibe-trading.tobytran.dev/` | Caddy-verified hub session, then upstream API key and hardening |
| `vibe-consensus` | internal only (`vibe` network, port 8000) | Authenticated free Finnhub recommendation counts; missing optional key yields analysis-only without stopping Vibe |
| Desk `api` | authenticated `/api/desk` and `/api/desk/*` | Caddy/Clerk only; internal `gateway` + `database` networks, no host port |
| Desk `scheduler` | internal only (`database` network) | Database-only background loop; no gateway, broker, order service, or host port |
| `cloudflared` | outbound only | Tunnel connector |

This source prepares the authenticated Desk API runtime but does not perform a
live activation. The Hub still exports no `/apps/desk` page, including on
interim `trading.tobytran.dev`; its registry and static Worker cutover remain
unchanged until the separately reviewed Phase 4 release.

On the host:

- `/opt/family-app/ai-trading/` holds the compose file, the scripts, `common/config/family_config.py`, `images.env`, and `last-good-tag`.
- `/etc/family-app/ai-trading/` holds one root-only env file per service, plus `.previous/` (the files from the deploy before last, restored automatically if a deploy fails).
- `/etc/family-app/config-reader.json` holds the `family-config-reader` service account key `deploy.sh` uses to render Firestore profiles straight onto the host.

Every secret and environment value lives in one Firestore database, `family-config` (project `tobytran-portfolio`), never in a file inside this repository. See `ai-trading/AGENTS.md` for the profile list and the Cloudflare token policy, and `common/config/README.md` for the schema and the `family_config.py` commands used below. The old `ai-trading-env-bundle` Secret Manager secret still exists (one retained version) but nothing reads it anymore.

## Bootstrap (once, in order)

1. State bucket: `CLOUDSDK_ACTIVE_CONFIG_NAME=personal infrastructure/gcp/bootstrap-state.sh --project tobytran-portfolio --bucket tobytran-portfolio-tfstate`.
2. Apply `infrastructure/gcp/ai-trading` (creates the `ai-trading-deploy` and `ai-trading-terraform` workload identity pools, their service accounts, the static-hosting buckets, and grants both service accounts `roles/datastore.viewer` so CI can read Firestore — one root, one operator-reviewed `terraform plan`/`apply`, not a second apply). See that root's README for the access-token apply steps. Do this before any push to `main` that would run `ai-trading-deploy.yml`/`ai-trading-infra.yml`'s Firestore reads — they fail with a permission error until this root's `datastore.viewer` grants are applied.
3. Create the `ai-trading/tradingagents`, `ai-trading/ai-hedge-fund`, `ai-trading/vibe-trading`, `ai-trading/gateway`, `ai-trading/clerk`, `ai-trading/cloudflare`, and `ai-trading/deploy` profiles in Firestore (see "Editing values" below); `ai-trading/cloudflare` must exist before any Terraform apply that reads Cloudflare values out of it, and before the first deploy.
4. Apply only `infrastructure/cloudflare/ai-trading` through `common/config/family_config.py run ai-trading/cloudflare -- terraform ...` (see that root's README). Zero Trust/Access requires separate future approval and onboarding.
5. Release to `main` with ai-trading paths only (never merge all of `dev` into `main`). The push runs `ai-trading-deploy`, which builds images, pushes them to GHCR, and deploys to the VPS, which renders its own env files from Firestore.

## Editing values

```bash
CLI=common/config/family_config.py
$CLI keys ai-trading/tradingagents      # names only, no values printed
printf '%s' "$NEW_VALUE" | $CLI set ai-trading/tradingagents ANTHROPIC_API_KEY
$CLI get ai-trading/clerk PUBLISHABLE_KEY   # prints one value exactly
```

LLM keys are shared: every app profile links `ANTHROPIC_API_KEY` and an `OPENAI_API_KEY_*` from `shared/llm`. No provider spend limit is set (owner decision, 2026-10-08).

Vibe-Trading uses **direct OpenAI**, never OpenRouter: its Firestore profile sets `LANGCHAIN_PROVIDER=openai`, `LANGCHAIN_MODEL_NAME=gpt-5.5`, `OPENAI_BASE_URL=https://api.openai.com/v1`, and `VIBE_TRADING_DESKTOP_SECURE_CREDENTIALS=1`; `OPENAI_API_KEY` remains linked to `shared/llm:OPENAI_API_KEY_1`. The wrapper refuses a different provider/endpoint at startup and seeds private, non-secret settings from the injected profile. Native secure-credential mode reads keys from the environment, so the UI cannot fall back to upstream's OpenRouter example and no key is copied into its settings file. Upstream's provider picker remains unmodified; switching it manually is unsupported for this deployment and the next startup restores the Firestore defaults.

The wrapper retains the optional native Anthropic adapter from `deploy/upstream/vibe-trading/requirements-anthropic.lock`, with exact versions and wheel hashes. It leaves upstream's pinned dependencies and source unchanged. The smoke test constructs both adapters offline, checks installed upstream versions, and checks that the API settings match the OpenAI environment without exposing/copying its key. On an upstream bump, regenerate the additions against that base image if compatibility changes. Do not install dependencies by hand on the running VPS.

Rotate a shared provider key with `family_config.py set shared/llm <KEY_NAME>` (value on stdin), then redeploy the apps linked to it. The retired Secret Manager bundle is not used.

Vibe's optional free Finnhub key belongs only in `ai-trading/consensus`, **not** in `ai-trading/market-data` or `ai-trading/vibe-trading`. When the owner supplies it, run `printf '%s' "$NEW_VALUE" | common/config/family_config.py set ai-trading/consensus FINNHUB_API_KEY` from outside the repository, then redeploy. An absent/unavailable profile leaves `vibe-consensus.env` comment-only (no key); the private service stays healthy while recommendation requests return `503 not_configured`. No other app group receives the key.

## Account and sign-out

The header's Account panel shows the signed-in Clerk user's name and email read-only. There are no account-editing controls, and identity data is loaded client-side rather than embedded in GCS assets.

Sign out pauses new session exchanges, waits for an active exchange to settle, clears this browser's shared HttpOnly trading cookie through Origin-checked `POST /__auth/logout`, then ends the current Clerk session. The workspace is hidden during the action; a failed action offers Retry sign out instead of reporting success. Other family apps using that same Clerk session may also become signed out; this does not sign out the Google account itself.

This is browser-cookie cleanup, not server-side revocation: copied stateless cookies can remain valid until their one-hour expiry, and already-open external WebSocket/SSE connections are not forcibly closed. The serializer is per tab; an already-started refresh in another tab can still repopulate the shared cookie. A genuinely stalled exchange can delay sign-out, because the existing serial queue never aborts an active request. Public Worker cutover still requires separate approval and review of these limits.

## Terminal analyses

TradingAgents is a one-analysis CLI, not a chat loop. The shared captive launcher keeps the tmux pane and output after normal completion, an app error, or Ctrl+C cancellation, then offers **Press Enter to start another analysis**. It never automatically retries a run or opens a shell. Reconnecting attaches to that same pane without launching another analysis; EOF closes it. The image smoke tests exercise this lifecycle for both terminal apps using dummy commands, without provider calls. Deploying new terminal images still interrupts existing panes, so wait for active analyses to finish before rollout.

## Research (06)

`ta-research` serves a private, owner-scoped TradingAgents research history
(list/detail/share/download) at `/research`/`/api/research` on this
dedicated host and `/u/tradingagents/research...` on the hub — reachable
from the hub's TradingAgents terminal page via its "Research dashboard"
button (`frontend/components/terminal-frame.tsx`), which opens that
`/u/tradingagents/research` URL in a new tab; see
`ai-trading/tradingagents-web/DIVERGENCE.md` for the verified integration
evidence (every case in `ta_web`'s four `tests/test_*.py` files running
inside the built image — see `ai-trading/deploy/ci/test-tradingagents-research.sh`
for the current count rather than trusting a number here — plus the full
real-Caddy `smoke-test.sh all` suite, and the private/share/revoke/download
contract against the real service). It shares `ta-terminal`'s `tradingagents.env` and
appuser UID but never its data volume: `ta-research-data` is private to this
service, and the legacy `ta-data` volume stays terminal-only (no read mount
by default; see the research plan for the explicit operator import path).
`ta-research` trusts the identity/prefix headers the gateway sets, so it is
never on `ta` with `ta-terminal`: it has its own `research` network, joined
only by `gateway` (same shape as `vibe`), with `FORWARDED_ALLOW_IPS` scoped
to that network's own fixed subnet, not `"*"` (see `DIVERGENCE.md` "Network
isolation"). Rollback behaves like every other service in `SERVICES` (`health-check.sh`):
an unhealthy `ta-research` after a deploy triggers the same automatic
previous-tag rollback as any other service, not a special case.

## Deploy

Every push to `main` touching `ai-trading/**` (excluding `ai-trading/plans/**` and any `*.md` file), `.gitmodules`, this workflow file itself, or `common/config/**` runs `build` and `deploy` below unconditionally. A manual `workflow_dispatch` instead runs **only** the jobs whose boolean input the operator explicitly sets true on that dispatch; every input defaults to `false`, so a bare "Run workflow" click with no inputs changed runs nothing.

| Input (`workflow_dispatch`) | Default | Effect |
|---|---|---|
| `deploy_app` | `false` | Runs `build` then `deploy` (manual redeploy/rollback). Ignored on a push — push always runs both. |
| `activate_mirofish` | `false` | Sends `MIROFISH_ACTIVATE=1` (turn MiroFish on). **Only takes effect when `deploy_app` is also `true`.** Without it, and on every push, `deploy.sh` gets `keep`. |
| `stop_mirofish` | `false` | Sends `MIROFISH_ACTIVATE=0` (turn MiroFish off); wins over `activate_mirofish`. Only takes effect when `deploy_app` is also `true`. |
| `upload_hub_static` | `false` | Runs the independent `hub-static-upload` job: builds the frontend's Next.js static export with pnpm and uploads it to the hub bucket. Never builds/pushes images, never runs `deploy`, never touches MiroFish. |
| `upload_mirofish_static` | `false` | Runs the independent `mirofish-static-upload` job: builds MiroFish's static Vue export and uploads it to its own bucket. Same isolation as `upload_hub_static`. |

1. `build`: builds and smoke-tests the images with a fake Clerk key, then builds and pushes the real images to GHCR tagged with the commit SHA, using the publishable key from the repo-scoped GitHub Actions variable `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` (see `ai-trading/AGENTS.md`). Before any image in this job is built or pushed (including the fake-keyed smoke build), `ai-trading/deploy/ci/check-clerk-publishable-key.sh` fails the job closed unless that variable is a `pk_live_` key decoding to this app's own Clerk Frontend API domain — the same guard `hub-static-upload` runs before its `pnpm build`.

   Production smoke/export builds read CI layer caches but clear `cache-to` (`set: '*.cache-to='`), so optional GitHub cache uploads cannot hold up the deployment. PR CI still seeds caches. The immutable GHCR push build does not use the CI cache-export overlay. Verify the override locally with `docker buildx bake -f ai-trading/deploy/docker-bake.hcl -f ai-trading/deploy/docker-bake.ci.hcl --set '*.cache-to=' --print`: targets retain `cache-from` and have no `cache-to`.
2. `deploy` (environment `ai-trading-production`): authenticates to GCP over Workload Identity Federation (no stored key), fetches only the live Cloudflare tunnel token (`ai-trading/deploy/ci/render-env.sh`, `ai-trading/cloudflare` profile) and the VPS deploy SSH key (`shared/vps` `VPS_DEPLOY_SSH_PRIVATE_KEY`), then copies the compose files, `deploy.sh`, `health-check.sh`, `common/config/family_config.py`, and the one CI-rendered file (`cloudflared.env`) to the host and runs `deploy.sh`.

On the host, `deploy.sh` renders `ai-trading/tradingagents`, `ai-trading/ai-hedge-fund`, `ai-trading/vibe-trading`, and `ai-trading/gateway` (renamed `auth.env`) straight from Firestore with the `family-config-reader` key, validates every file (well-formed `KEY=value` lines, no empty value, no NUL or CR byte), backs up the current files to `.previous/`, derives `vibe-gateway.env` (only `VIBE_API_AUTH_KEY`, copied from `vibe-trading.env`'s `API_AUTH_KEY`, for the Caddy gateway), installs all six files (the five above, plus `cloudflared.env`, the one file CI itself staged) as `root:root 0600`, then pulls and restarts the stack. If the new tag fails to come up healthy, it restores `.previous/` and rolls back to `last-good-tag`.

### Vibe long-run protection (SP5)

Vibe now checks out the original `HKUDS/Vibe-Trading` repo at upstream ancestor `d71b28c7`. The deleted family fork is not a deploy dependency: `deploy/upstream/vibe-trading/family-baseline.patch` and `family-sp5.patch` recreate the exact reviewed family source **inside the image build only**, before locked dependency installation and frontend compilation. `deploy/ci/test-vibe-overlay.sh` checks the full source tree (including tests and docs); no patch is dropped and the upstream submodule remains unmodified. Future pin changes must rebase and re-verify both patches before any release.

For a running, enabled Vibe group, deploys pause **new chat sends** (HTTP 503 with `Retry-After`) while existing chat and private automatic committee runs finish. The old process exposes a loopback-only, API-key-authenticated drain; the key is read inside its container and never passed to CI or in Docker command arguments. The lease expires after 10 minutes without renewal. If protected work remains after 60 minutes, the deploy aborts before changing saved app choices, active secrets/configs or app containers. Other groups and MiroFish's `keep` setting are unchanged.

The first SP5 release starts from an older Vibe image with no drain endpoint. That one cutover temporarily runs the staged Caddyfile on **gateway only**, blocking authenticated new-chat POSTs while an old-image file preflight checks the old process's actual `VIBE_TRADING_HOME` (or `/home/vibe/.vibe-trading`) session and private-committee records for two zero-work samples 10 seconds apart. It does not stop an in-flight Vibe run. An unobservable pending committee-thread handoff on that old image remains a bootstrap limitation: if quiet-window safety is uncertain, **hold the release** rather than treating a missing endpoint or unreadable state as idle. After the first release, the in-process drain closes that race.

After any drain reaches idle, Caddy's owner-tagged admission marker stays in place through image pull, Compose replacement, health checks and the `last-good-tag` commit. A pre-switch failure restores files without restarting Vibe (and restores only MiroFish if an operator stop had already removed a previously running instance). A failed health check after the switch rolls back under the marker. A successful commit removes it and reopens chat. A marker whose owner changed is never removed by an older deploy or its 90-minute expiry timer.

If logs say **"release applied but Vibe admission marker could not be cleared"**, the new tag was committed: the workflow reports failure but must **not** roll back over fresh research. Check the saved tag, Vibe health, and marker/timer ownership before any retry; do not delete a marker blindly or print its lease or provider keys. Unexpected service restarts appear as amber Interrupted with sanitized progress; users choose whether to retry the exact original prompt. Standalone swarms, Alpha/scheduled jobs and persistent live runners are not covered by this chat/automatic-committee drain.

### MiroFish activation (`activate_mirofish`, `stop_mirofish`)

The workflow always passes an explicit `MIROFISH_ACTIVATE` to the remote `deploy.sh` (see `ai-trading/AGENTS.md`):

- A push to `main`, or a dispatch without either input, sends `keep`: MiroFish stays on only if a `mirofish` container is running now; otherwise it stays off.
- A dispatch with `deploy_app=true` and `activate_mirofish=true` sends `1`: MiroFish is turned on.
- A dispatch with `deploy_app=true` and `stop_mirofish=true` sends `0`: MiroFish is turned off. It wins over `activate_mirofish`.

`1` and `keep` both render the `ai-trading/mirofish` Firestore profile; a malformed or absent profile leaves MiroFish disabled and logs why, without failing the other three apps' deploy (`activate_mirofish()` in `deploy.sh`). Any deploy that ends with MiroFish disabled stops and removes a running MiroFish container (`ensure_mirofish_stopped()`).

### Hub and MiroFish static uploads

Both static-upload jobs are fully independent of `build`/`deploy` and of each other: neither builds/pushes a GHCR image, runs `deploy.sh`, or changes MiroFish's activation state. Each needs its own GitHub Actions repository variable pointing at its Terraform-provisioned bucket, and both authenticate through the **same existing** `ai-trading-deploy` Workload Identity Federation pool/provider as `build`/`deploy` above — no new WIF provider or role is created.

| | Hub (`upload_hub_static`) | MiroFish (`upload_mirofish_static`) |
|---|---|---|
| Bucket repo variable | `HUB_STATIC_BUCKET` | `AI_TRADING_MIROFISH_BUCKET_NAME` |
| Copy from Terraform output | `infrastructure/gcp/ai-trading` → `hub_bucket_name` | `infrastructure/gcp/ai-trading` → `mirofish_bucket_name` |
| Upload identity (WIF service account) | `ai-trading-hub-upload@tobytran-portfolio.iam.gserviceaccount.com` | `ai-trading-mirofish-upload@tobytran-portfolio.iam.gserviceaccount.com` |
| IAM scope | `roles/storage.objectAdmin` on its own bucket only (`hub-bucket.tf`) | `roles/storage.objectAdmin` on its own bucket only (`mirofish-bucket.tf`) |
| GitHub Environment | `ai-trading-production` | `ai-trading-production` |
| Clerk claim needed | Real `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` repo variable (build fails closed if unset; no fake key is ever used here) | none |
| Build method | `pnpm install --frozen-lockfile` + `pnpm build` (Next.js static export, no Docker) | `docker buildx bake` (`mirofish-frontend` target) |

**Why `environment: ai-trading-production` on both, not a per-job environment name**: `infrastructure/gcp/ai-trading/main.tf`'s WIF provider `attribute_condition` requires `assertion.environment == var.github_environment` (`ai-trading-production`) for *every* job on this pool — the job's own boolean dispatch input, not its GitHub Environment name, is what gates whether it runs. A GitHub Environment name other than `ai-trading-production` (the MiroFish job previously used `ai-trading-mirofish-upload`) makes Google's OIDC token exchange fail closed with an `invalid_target`-style error, regardless of the dispatch input. Set `HUB_STATIC_BUCKET` and `AI_TRADING_MIROFISH_BUCKET_NAME` as **repository**-scoped variables (or on the shared `ai-trading-production` environment) — either is fine, since all WIF jobs already share that one environment.

**Operator caveat**: because both upload jobs and `deploy` now share one GitHub Environment, a required-reviewer protection rule added to `ai-trading-production` applies to all three. There is no way to require approval for a MiroFish/hub static publish without also requiring it for a normal app deploy, short of applying a separate narrower rule keyed off the job name (GitHub Environments do not support that natively).

## App Controls (Settings)

Either approved family user can open `/settings` on the hub and turn one of
four groups on/off to save VPS RAM. A switch affects both users; the Hub
itself (`web`/`gateway`/`auth`/`cloudflared`/`market-data`) and the Family Desk's
`api` and `scheduler` are never controllable and stay always-on.

| App ID | Controlled services |
|---|---|
| `tradingagents` | `ta-terminal`, `ta-research` |
| `ai-hedge-fund` | `ahf-terminal` |
| `vibe-trading` | `vibe-consensus`, `vibe-trading` |
| `mirofish` | `mirofish` |

- **Behavior and shared cancellation:** Settings shows each group's real
  status (`Running`/`Starting`/`Stopping`/`Stopped`/`Needs setup`/
  `Unhealthy`/`Error`), never guesses Running or Stopped while unconfirmed,
  and polls faster (2s) only while a transition is active. Turning a running
  app off asks for confirmation (Escape/Cancel makes no request and restores
  focus); turning one on does not. Only one app change may be in flight at a
  time — every switch disables globally while any app is
  Starting/Stopping/mutating, so a second request is refused client-side
  before it is ever sent, and the private helper itself serializes app
  operations the same way. A stale revision (another tab/user changed it
  first) returns 409 and refreshes instead of silently overwriting. Retry
  reconciles the same desired choice; it never queues a duplicate or flips
  the opposite toggle. Stopping never deletes a volume, image, or calls
  `compose down` — it only stops that group's containers to free RAM.
- **Target bootstrap:** `infrastructure/vps/app-controls/install.sh` creates
  the dedicated `ai-trading-gateway` identity (UID/GID 22001, no Docker group
  membership), the state directory (`/var/lib/family-app/ai-trading`), and
  the socket/run directory, refusing a symlinked path, an incompatible
  existing UID, or rootless/user-namespace-remapped Docker rather than
  weakening the peer check. It is rootful Linux/systemd only. `install.sh`
  never writes the control helper's own code/catalog or its systemd unit —
  that is `deploy.sh`'s job, on every deploy, so the genuinely-prior version
  of both can be captured and restored on a rollback (see below). A fresh
  host with no running stack adopts the standard defaults (three apps on,
  MiroFish off); adopting an existing host's compose project detects any
  already-running app (including MiroFish) and seeds the preference file
  from what is actually running, never from the defaults.
- **Helper unavailable / drift recovery:** if the private control helper is
  unreachable, Caddy's own generic `no-store` 503 is returned (never the
  helper's own app-specific body), and Settings reports the same
  "can't confirm status" guidance it uses for any other unconfirmed read —
  never a false Running or Stopped. On restart, the helper reconciles any
  operation that was active when it stopped (crash or deploy) from the
  persisted state file itself, never resetting to fresh defaults; a
  genuinely non-converged app after reconciliation is retried, not silently
  dropped. A deploy that fails after installing new control code, catalog,
  or systemd unit content restores the prior version byte-for-byte (not the
  about-to-be-discarded new one) and either restarts it (if the prior unit
  was active) or, on a genuine first activation with no prior version,
  stops and disables the just-installed unit — never leaving an
  orphaned, now-unknown-version helper running. That redeploy's own
  health check skips verifying the control helper only in this one
  case (no matching prior version to check against); it still requires
  every other selected service and the tunnel, and still verifies the
  helper normally whenever a prior version was restored.
- **Preference snapshot across a deploy:** before `deploy.sh` touches any
  secret, config, or unit file, it snapshots the current desired on/off
  choices (`control/state.py snapshot`) to a private file under
  `/var/lib/family-app/ai-trading/`. If the deploy fails for any reason, it
  restores those exact choices (`control/state.py restore`) at a strictly
  increased revision, regardless of what else did or didn't roll back — a
  user's saved preference always survives a failed release.
- **Operator MiroFish flags unchanged:** the deploy-time `activate_mirofish`/
  `stop_mirofish` workflow dispatch inputs (see "MiroFish activation" above)
  still decide whether MiroFish's Firestore credentials get rendered/staged
  at all on that deploy. Settings' own MiroFish switch only ever starts/stops
  an already-staged MiroFish; it cannot activate MiroFish without an operator
  having turned it on at deploy time first (`Needs setup` status covers that
  case) and never regenerates its Firestore-sourced credentials.
- **Temporary host, no backup:** this VPS is planned to move to a different
  host; see "Moving to a new host" above. Stopping an app does not back it
  up or export it anywhere — it only stops containers and keeps their
  existing volumes on this same disk. Recurring backup/restore is explicit
  future scope (Release 2+), not part of this feature.
- **No Docker socket exposure:** the control helper never mounts or proxies
  the Docker socket into any container (web, gateway, terminal, or
  research); it is a root-owned host process reached only over a private
  Unix socket (`/run/family-app/ai-trading-control/control.sock`, group-owned
  by the Caddy UID/GID 22001), itself peer-UID-checked
  (`SO_PEERCRED`) before any request is serviced. Only Caddy's
  `forward_auth`/reverse-proxy ever reaches it; the public `/__control/*`
  routes still require the same Clerk bearer token as the rest of the hub.

## Acceptance checklist (Mac and iPad)

1. Clerk login on the hub grants a session cookie for both hostnames; without it both terminal routes and Vibe-Trading return 401 (including the direct origin hostname). Opening Vibe-Trading directly before signing in through the hub returns 401.
2. The hub home page and navigation work. `tradingagents.` and `ai-hedge-fund.tobytran.dev` send a signed-out browser to the hub login and open the terminal full-screen after sign-in.
3. One TradingAgents analysis completes.
4. After closing the tab mid-run, reopening the route reattaches to the running session.
5. ai-hedge-fund opens its terminal UI and reaches a backtest screen (with a data key) or its missing-key prompt.
6. Vibe-Trading opens with no key to paste (the gateway supplies `API_AUTH_KEY` after the Clerk check) and answers one chat request.
7. Account opens with read-only name/email on desktop and iPad; Escape closes it and restores focus. Sign out returns to Clerk sign-in, and new backend requests from that browser return 401 until signing in again.

## Operations

- Caddyfile changes: `deploy.sh` labels the `gateway` container with the Caddyfile's sha256, so a deploy that changes the Caddyfile recreates the gateway (a running container never sees the new file through its single-file bind mount). Open terminal connections drop once when that happens.
- Logs: `sudo docker compose -p ai-trading --env-file /opt/family-app/ai-trading/images.env -f /opt/family-app/ai-trading/docker-compose.yml logs -f <service>`
- Redeploy the current tag: rerun the `ai-trading-deploy` GitHub Actions workflow (`workflow_dispatch`, `deploy_app=true`); it re-renders the four core profiles from Firestore and redeploys `${{ github.sha }}` of the `main` branch tip. MiroFish keeps its current state (`MIROFISH_ACTIVATE=keep`: on only if it is running now and its profile still renders); add `activate_mirofish=true` to turn it on or `stop_mirofish=true` to turn it off (see "MiroFish activation" above). `deploy.sh` always requires a fresh `ENV_STAGING_DIR/cloudflared.env` and always re-renders the four core profiles on the host — there is no manual mode that reuses a stale staging directory — so a host-only, direct `deploy.sh` run needs a real `cloudflared.env` staged first; rerunning the workflow is simpler.
- Disk: one release unpacks to ~17 GB (MiroFish's backend alone is ~12 GB) and shares no layers with the previous tag. Before touching Firestore, a container, or any secret, `deploy.sh` removes every commit-tagged image in the registry's `ai-trading-*` repos except the release being deployed and `last-good-tag` (an image a container still uses is never removed; other apps' and third-party images are never touched), then stops with a clear message unless `AI_TRADING_MIN_FREE_GB` (default 30) GiB is free on `AI_TRADING_DOCKER_DATA_DIR` (default `/var/lib/docker`). That stop leaves the running release untouched. Without it, a full disk fails the pull mid-deploy and also breaks the env-file rollback (2026-10-10).
- Rotate the Vibe-Trading access key: change `API_AUTH_KEY` in `ai-trading/vibe-trading` (see "Editing values"), and rerun the deploy workflow; the gateway picks up the new key, so browsers need nothing.
- Upstream updates arrive as one grouped Dependabot pull request per week. Merge it to `dev` when CI is green, then release to `main`.

## Moving to a new host

1. Run `infrastructure/vps/bootstrap.sh --only firewall,ssh,docker` against the new host, then `infrastructure/gcp/family-config/install-reader-key.sh` to install `/etc/family-app/config-reader.json` there.
2. Update `shared/vps`'s `VPS_HOST`, `VPS_PORT`, `VPS_USER`, and `VPS_SSH_KNOWN_HOSTS` (`ssh-keyscan -t ed25519 <new-host>`) — `ai-trading/deploy` references these by name, so it needs no separate update (see "Editing values").
3. Rerun the deploy workflow.
4. Stop the stack on the old host: `sudo docker compose -p ai-trading ... down`.

App data in the Docker volumes is trial data and is not copied. Release 2 adds backups.

## Local development

See `ai-trading/deploy/local/README.md`.
