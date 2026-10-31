// Package config reads the bridge's environment (02t §3.4). Names only: the
// values live in Firestore `family-config` and arrive as env vars.
package config

import (
	"fmt"
	"strings"

	pb "github.com/thangtran3112/family-app/ai-trading/market-data/bridge/gen/marketdata/v1"
)

// Known maps every provider the bridge may ever name to the classes it can
// serve. Anything absent is unknown by construction (tradier: owner decision
// 2026-10-31), and marketdata_app lacks the equity classes (decision 4), so a
// ladder naming it for stocks fails at startup.
var Known = map[string][]pb.DataClass{
	"alpaca":         {pb.DataClass_EQUITY_QUOTES, pb.DataClass_EQUITY_BARS, pb.DataClass_OPTION_CHAIN},
	"ibkr":           {pb.DataClass_EQUITY_QUOTES, pb.DataClass_OPTION_CHAIN},
	"longbridge":     {pb.DataClass_EQUITY_QUOTES, pb.DataClass_OPTION_CHAIN},
	"marketdata_app": {pb.DataClass_OPTION_CHAIN},
}

// Serves reports whether a known provider can serve the class.
func Serves(provider string, class pb.DataClass) bool {
	for _, c := range Known[provider] {
		if c == class {
			return true
		}
	}
	return false
}

// ClassName is the lower-case name used in logs and messages.
func ClassName(c pb.DataClass) string { return strings.ToLower(c.String()) }

type classEnv struct {
	class      pb.DataClass
	env        string
	dflt       string
	mayBeEmpty bool // an empty ladder is allowed: the class is off on this build
}

var classEnvs = []classEnv{
	{pb.DataClass_EQUITY_QUOTES, "BRIDGE_LADDER_EQUITY_QUOTES", "alpaca", false},
	{pb.DataClass_EQUITY_BARS, "BRIDGE_LADDER_EQUITY_BARS", "alpaca", false},
	// Option chains arrive at B6; until then the class is off.
	{pb.DataClass_OPTION_CHAIN, "BRIDGE_LADDER_OPTION_CHAIN", "", true},
}

type Config struct {
	Listen       string
	Token        string // MARKET_DATA_BRIDGE_TOKEN: grants reads
	AdminToken   string // MARKET_DATA_BRIDGE_ADMIN_TOKEN: also required for SetRouting
	AlpacaKeyID  string
	AlpacaSecret string
	// Ladders is the env routing default and the allowlist, per class.
	Ladders map[pb.DataClass][]string
	// ArchiveEnabled (ARCHIVE_ENABLED=1) turns on the H1 RAW history archive. Off by default, so a
	// bridge deploys without it; ArchiveURL is then unused.
	ArchiveEnabled bool
	ArchiveURL     string
}

// ArchiveURL is the archive's Postgres connection string: ARCHIVE_DATABASE_URL, else the Desk's
// DESK_RUNTIME_DATABASE_URL (local dev: the Desk database already exists; the archive lives in
// its own schema there, `market_archive`). `bridge migrate` reads it with the archive still off.
func ArchiveURL(getenv func(string) string) string {
	if u := strings.TrimSpace(getenv("ARCHIVE_DATABASE_URL")); u != "" {
		return u
	}
	return strings.TrimSpace(getenv("DESK_RUNTIME_DATABASE_URL"))
}

// FromEnv validates fail-fast, naming the variable. A missing key or token is
// not an error: the provider reports NOT_CONFIGURED, and with no token every
// call is rejected.
func FromEnv(getenv func(string) string) (*Config, error) {
	c := &Config{
		Listen:       getenv("BRIDGE_LISTEN"),
		Token:        getenv("MARKET_DATA_BRIDGE_TOKEN"),
		AdminToken:   getenv("MARKET_DATA_BRIDGE_ADMIN_TOKEN"),
		AlpacaKeyID:  getenv("ALPACA_API_KEY_ID"),
		AlpacaSecret: getenv("ALPACA_API_SECRET_KEY"),
		Ladders:      map[pb.DataClass][]string{},
		ArchiveURL:   ArchiveURL(getenv),
	}
	switch v := strings.TrimSpace(getenv("ARCHIVE_ENABLED")); v {
	case "", "0":
	case "1":
		c.ArchiveEnabled = true
		if c.ArchiveURL == "" {
			return nil, fmt.Errorf("ARCHIVE_ENABLED=1 needs ARCHIVE_DATABASE_URL (or DESK_RUNTIME_DATABASE_URL)")
		}
	default:
		return nil, fmt.Errorf("ARCHIVE_ENABLED: %q is not 0 or 1", v)
	}
	if c.Listen == "" {
		c.Listen = ":8080"
	}
	for _, ce := range classEnvs {
		raw, set := strings.TrimSpace(getenv(ce.env)), true
		if raw == "" {
			raw, set = ce.dflt, false
		}
		ladder, err := parseLadder(ce, raw, set)
		if err != nil {
			return nil, err
		}
		if len(ladder) > 0 {
			c.Ladders[ce.class] = ladder
		}
	}
	return c, nil
}

func parseLadder(ce classEnv, raw string, set bool) ([]string, error) {
	var ladder []string
	seen := map[string]bool{}
	for _, part := range strings.Split(raw, ",") {
		name := strings.ToLower(strings.TrimSpace(part))
		if name == "" {
			continue
		}
		switch {
		case Known[name] == nil:
			return nil, fmt.Errorf("%s: unknown provider %q", ce.env, name)
		case !Serves(name, ce.class):
			return nil, fmt.Errorf("%s: provider %q does not serve %s", ce.env, name, ClassName(ce.class))
		case seen[name]:
			return nil, fmt.Errorf("%s: provider %q listed twice", ce.env, name)
		}
		seen[name] = true
		ladder = append(ladder, name)
	}
	if len(ladder) == 0 && !ce.mayBeEmpty {
		return nil, fmt.Errorf("%s: empty ladder", ce.env)
	}
	return ladder, nil
}
