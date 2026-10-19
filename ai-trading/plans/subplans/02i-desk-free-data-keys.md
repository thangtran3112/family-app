# Family Desk: Free Data-Provider Keys (Phase 2a)

Phase 2a's clients for Finnhub, FRED, Alpha Vantage, and Eulerpool need one free API key each. Only you can create them, because each signup needs an email login. All four are free; none needs a card.

| Provider | Used for | Free limit | Sign up |
|---|---|---|---|
| Finnhub | Earnings calendar, dividends, company news; consensus EPS fallback | 60 calls per minute | <https://finnhub.io/register>, then copy the key from the dashboard |
| FRED (St. Louis Fed) | Macro series with vintages, release dates | 120 calls per minute | Create an account at <https://fredaccount.stlouisfed.org>, then request a key at <https://fredaccount.stlouisfed.org/apikeys> (purpose: "personal research app") |
| Alpha Vantage | Consensus EPS fallback (earnings estimates) | 25 calls per day | <https://www.alphavantage.co/support/#api-key> |
| Eulerpool | Consensus EPS, revisions, analyst targets (the 10-symbol pilot decides if it becomes primary) | 100,000 calls per month, non-commercial | <https://eulerpool.com/financial-data-api>, create an account, then copy the key from the developer dashboard |

## Store each key

Run from the repository root. `read -rs` keeps the key out of your shell history and off the screen. Paste the key and press Enter:

```bash
cd ~/personal/family-app
export CLOUDSDK_ACTIVE_CONFIG_NAME=personal

read -rs K && printf '%s' "$K" | python3 common/config/family_config.py set shared/finnhub FINNHUB_API_KEY; unset K
read -rs K && printf '%s' "$K" | python3 common/config/family_config.py set shared/fred FRED_API_KEY; unset K
read -rs K && printf '%s' "$K" | python3 common/config/family_config.py set shared/alphavantage ALPHA_VANTAGE_API_KEY; unset K
read -rs K && printf '%s' "$K" | python3 common/config/family_config.py set shared/eulerpool EULERPOOL_API_KEY; unset K
```

The keys go into `shared/` groups because TradingAgents and Vibe-Trading can use the same free keys later (02a §7). Tell the agent when they are in; it links them into `ai-trading/desk` and checks them with one live call each, without printing them.

## What waits on the keys

- Recording the real responses that the Finnhub, FRED, and consensus EPS clients are tested against.
- The Eulerpool 10-symbol pilot, written up in 02d.

Everything else in Phase 2a (the shared HTTP layer, Alpaca, Stooq, SEC EDGAR, the Postgres bar store, the futures roll map, and streaming slots) starts now without them.
