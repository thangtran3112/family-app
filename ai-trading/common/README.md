# ai-trading-common

Every external data source for ai-trading lives here, behind one provider pattern
([02j](../plans/subplans/02j-common-data-providers-design.md)). Callers never talk to a vendor
directly; they build a `DataSources` and read through it.

## Layout

```
src/ai_trading_common/
  errors.py quality.py http.py bars.py fallback.py testing.py   core
  types.py     vendor-neutral result types and their as-of selectors
  sources.py   one runtime-checkable Protocol per data kind
  registry.py  Kind, Provider, REGISTRY, DEFAULT_CHAINS, DataSources.from_env()
  providers/   alpaca.py sec_edgar.py fred.py finnhub.py alphavantage.py eulerpool.py
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

## Re-recording fixtures

```bash
cd /Users/tobytran/personal/family-app && CLOUDSDK_ACTIVE_CONFIG_NAME=personal \
  python3 common/config/family_config.py run ai-trading/desk -- \
  sh -c 'cd ai-trading/common && uv run python scripts/record.py <provider>'
```

See `scripts/record.py`'s docstring and `_RECORDERS` for provider names. Fixtures hold only
response bodies, secrets stripped before they're written.
