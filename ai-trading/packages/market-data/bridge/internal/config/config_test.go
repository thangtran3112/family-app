package config

import (
	"strings"
	"testing"

	pb "github.com/thangtran3112/family-app/ai-trading/market-data/bridge/gen/marketdata/v1"
)

func env(m map[string]string) func(string) string { return func(k string) string { return m[k] } }

func TestDefaults(t *testing.T) {
	c, err := FromEnv(env(nil))
	if err != nil {
		t.Fatal(err)
	}
	if c.Listen != ":8080" || c.Token != "" {
		t.Fatalf("defaults: %+v", c)
	}
	if got := c.Ladders[pb.DataClass_EQUITY_QUOTES]; len(got) != 1 || got[0] != "alpaca" {
		t.Fatalf("quotes ladder: %v", got)
	}
	if _, on := c.Ladders[pb.DataClass_OPTION_CHAIN]; on {
		t.Fatal("option chain must be off before B6")
	}
}

func TestLadderValidation(t *testing.T) {
	cases := map[string]struct{ env, val, want string }{
		"empty":            {"BRIDGE_LADDER_EQUITY_QUOTES", " , ", "BRIDGE_LADDER_EQUITY_QUOTES: empty ladder"},
		"tradier unknown":  {"BRIDGE_LADDER_EQUITY_QUOTES", "tradier,alpaca", `unknown provider "tradier"`},
		"not serving":      {"BRIDGE_LADDER_EQUITY_BARS", "ibkr", `provider "ibkr" does not serve equity_bars`},
		"marketdata_app":   {"BRIDGE_LADDER_EQUITY_QUOTES", "alpaca,marketdata_app", `provider "marketdata_app" does not serve equity_quotes`},
		"duplicate":        {"BRIDGE_LADDER_EQUITY_QUOTES", "alpaca,alpaca", "listed twice"},
		"options not bars": {"BRIDGE_LADDER_OPTION_CHAIN", "marketdata_app,alpaca", ""},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := FromEnv(env(map[string]string{tc.env: tc.val}))
			if tc.want == "" {
				if err != nil {
					t.Fatalf("want ok, got %v", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("want %q, got %v", tc.want, err)
			}
		})
	}
}

func TestMissingKeysAreNotAnError(t *testing.T) {
	if _, err := FromEnv(env(map[string]string{"MARKET_DATA_BRIDGE_TOKEN": "t"})); err != nil {
		t.Fatal(err)
	}
}
