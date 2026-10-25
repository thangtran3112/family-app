# ai-trading-common

Every external data source for ai-trading lives here, behind one provider pattern
([02j](../plans/subplans/02j-common-data-providers-design.md)). Callers never talk to a vendor
directly; they build a `DataSources` and read through it.

## Layout

```
src/ai_trading_common/
  errors.py quality.py http.py bars.py fallback.py testing.py   core
  types.py     vendor-neutral result types and their as-of selectors
  trades.py    the tape: `Trades` (one row per print: t, p, s, x, c) and `empty_trades_frame()`
  sources.py   one runtime-checkable Protocol per data kind
  registry.py  Kind, Provider, REGISTRY, DEFAULT_CHAINS, DataSources.from_env()
  providers/   alpaca.py sec_edgar.py fred.py finnhub.py alphavantage.py eulerpool.py ibkr.py
```

Each `providers/<name>.py` holds that vendor's raw client, one `<Name>Source` adapter mapping
its records into `types.py` objects, and a `PROVIDER` registry entry. `registry.py` is the only
module that imports `providers/*`.

## The rule

Callers use `DataSources` (built once via `DataSources.from_env()`), plus `types`, `sources`,
`bars`, `errors`, `quality` (and `testing` in tests). **Never import `ai_trading_common.providers`
directly** -- the Desk enforces this with an import-boundary test; any other caller should too.

A `DataSources` attribute (`bars`, `consensus`, `targets`, ...) is a chain: it tries its
`DATA_PROVIDERS_<KIND>` providers in order (env override, else `DEFAULT_CHAINS`), relabeling a
non-primary result `quality="fallback"`. A missing key is never a startup error -- that provider
raises `NotConfigured` when called, and the chain moves on.

## Replacing a provider

See [02j §8](../plans/subplans/02j-common-data-providers-design.md#8-replacing-a-provider-the-checklist):
add `providers/x.py` (client, `XSource`, `PROVIDER`, fixtures, tests), add one `REGISTRY` line,
store the key and point `DATA_PROVIDERS_<KIND>` at it in Firestore, redeploy. No caller changes.

## IBKR gateway quotes (off by default)

`providers/ibkr.py` is a read-only live-quote source over a local IB Gateway session. It serves the
`quotes` kind only, and `DEFAULT_CHAINS["quotes"]` is `ibkr,alpaca`. A provider with an `enabled(env)`
switch is left out of every chain while the switch is off, so with nothing set Alpaca is the primary
(`delayed-15m`, never relabeled `fallback`).

Enable it only after the Monday 2026-10-26 gateway probe passes (02e, 02m §b4 item 3):

```bash
# from the repository root; values are never echoed
python3 common/config/family_config.py set ai-trading/desk DESK_IBKR_GATEWAY_ENABLED   # value: 1
# IBKR_DATA_USERNAME / IBKR_DATA_PASSWORD are already in ai-trading/desk (02e)
# optional: IBKR_GATEWAY_HOST (127.0.0.1) IBKR_GATEWAY_PORT (4002) IBKR_GATEWAY_CLIENT_ID (902) IBKR_GATEWAY_MAX_LINES (70)
```

and install the wire client (`uv sync --extra ibkr` / `ai-trading-common[ibkr]`). The session is read-only: no order,
position, or balance call exists in this module (`tests/providers/test_ibkr.py` pins that). `DataSources.gateway_status()`
reports `not_configured | down | reconnecting | connected` for the Desk's `/status`.

## Re-recording fixtures

```bash
cd /Users/tobytran/personal/family-app && CLOUDSDK_ACTIVE_CONFIG_NAME=personal \
  python3 common/config/family_config.py run ai-trading/desk -- \
  sh -c 'cd ai-trading/common && uv run python scripts/record.py <provider>'
```

See `scripts/record.py`'s docstring and `_RECORDERS` for provider names. Fixtures hold only
response bodies, secrets stripped before they're written.
