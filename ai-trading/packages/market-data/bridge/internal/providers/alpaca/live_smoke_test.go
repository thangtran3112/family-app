package alpaca_test

// Live smoke test for Alpaca's historical bars API (the free IEX feed, RAW
// adjustment, the shape the bridge's archive depends on). The other tests in
// this package are offline fakes; these hit data.alpaca.markets.
//
// Gated on ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY. Without them every test
// SKIPs, so `go test ./...` and CI (which has no provider keys by design) stay
// green. Run it against the real API from ai-trading/packages/market-data/bridge:
//
//	ALPACA_API_KEY_ID=$(../../../../common/config/family_config.py get ai-trading/market-data ALPACA_API_KEY_ID) \
//	ALPACA_API_SECRET_KEY=$(../../../../common/config/family_config.py get ai-trading/market-data ALPACA_API_SECRET_KEY) \
//	go test -v -count=1 -run TestLive ./internal/providers/alpaca/
//
// Never log the key or secret: nothing below prints a header or a URL.

import (
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"testing"
	"time"
)

const liveBase = "https://data.alpaca.markets/v2/stocks"

type liveBar struct {
	T  *string  `json:"t"`
	O  *float64 `json:"o"`
	H  *float64 `json:"h"`
	L  *float64 `json:"l"`
	C  *float64 `json:"c"`
	V  *float64 `json:"v"`
	N  *float64 `json:"n"`  // optional
	VW *float64 `json:"vw"` // optional
}

type liveBars struct {
	Bars   []liveBar `json:"bars"`
	Symbol string    `json:"symbol"`
}

// liveGet returns the status and body of GET /v2/stocks/{symbol}/bars, or skips
// the test when the provider keys are not in the environment.
func liveGet(t *testing.T, symbol string, q url.Values) (int, []byte) {
	t.Helper()
	keyID, secret := os.Getenv("ALPACA_API_KEY_ID"), os.Getenv("ALPACA_API_SECRET_KEY")
	if keyID == "" || secret == "" {
		t.Skip("skipped: no ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY in the environment (live Alpaca smoke test)")
	}
	req, err := http.NewRequest(http.MethodGet, liveBase+"/"+url.PathEscape(symbol)+"/bars?"+q.Encode(), nil)
	if err != nil {
		t.Fatalf("building request: %v", err)
	}
	req.Header.Set("APCA-API-KEY-ID", keyID)
	req.Header.Set("APCA-API-SECRET-KEY", secret)
	resp, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
	if err != nil {
		t.Fatalf("Alpaca unreachable: %v", err.(*url.Error).Err) // *url.Error carries the URL; print only the cause
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		t.Fatalf("reading body: %v", err)
	}
	return resp.StatusCode, body
}

func dailyRaw(start, end string) url.Values {
	return url.Values{
		"timeframe": {"1Day"}, "start": {start}, "end": {end},
		"adjustment": {"raw"}, "feed": {"iex"}, "limit": {"1000"},
	}
}

func TestLiveHistoricalBarsShape(t *testing.T) {
	status, body := liveGet(t, "AAPL", dailyRaw("2024-01-02", "2024-02-01"))
	if status != http.StatusOK {
		t.Fatalf("HTTP %d, want 200", status)
	}
	var page liveBars
	if err := json.Unmarshal(body, &page); err != nil {
		t.Fatalf("malformed JSON: %v", err)
	}
	// January 2024 has 21 sessions; allow IEX gaps but not an empty or tiny page.
	if len(page.Bars) < 15 {
		t.Fatalf("got %d bars for AAPL in Jan 2024, want at least 15", len(page.Bars))
	}
	var prev time.Time
	for i, b := range page.Bars {
		if b.T == nil || b.O == nil || b.H == nil || b.L == nil || b.C == nil || b.V == nil {
			t.Fatalf("bar %d is missing one of t/o/h/l/c/v: %+v", i, b)
		}
		ts, err := time.Parse(time.RFC3339, *b.T)
		if err != nil {
			t.Fatalf("bar %d timestamp %q is not RFC 3339: %v", i, *b.T, err)
		}
		if i > 0 && !ts.After(prev) {
			t.Fatalf("bar %d (%s) is not after bar %d (%s): timestamps must ascend", i, ts, i-1, prev)
		}
		prev = ts
		if *b.L <= 0 || *b.H < *b.L || *b.O < *b.L || *b.O > *b.H || *b.C < *b.L || *b.C > *b.H {
			t.Fatalf("bar %d (%s) violates low <= open/close <= high: %+v", i, *b.T, b)
		}
		if *b.V < 0 || (b.N != nil && *b.N < 0) || (b.VW != nil && (*b.VW < *b.L || *b.VW > *b.H)) {
			t.Fatalf("bar %d (%s) has a bad volume, trade count or vwap: %+v", i, *b.T, b)
		}
	}
	t.Logf("%d bars, %s .. %s", len(page.Bars), *page.Bars[0].T, *page.Bars[len(page.Bars)-1].T)
}

// adjustment=raw must return prices as printed on the day. AAPL split 4:1 on
// 2020-08-31 and printed about 499 on 2020-08-28; the split-adjusted close is
// about 125. A close above 400 proves the archive gets unadjusted bars.
func TestLiveRawAdjustmentIsUnadjusted(t *testing.T) {
	status, body := liveGet(t, "AAPL", dailyRaw("2020-08-28", "2020-08-29"))
	if status != http.StatusOK {
		t.Fatalf("HTTP %d, want 200", status)
	}
	var page liveBars
	if err := json.Unmarshal(body, &page); err != nil {
		t.Fatalf("malformed JSON: %v", err)
	}
	if len(page.Bars) != 1 || page.Bars[0].C == nil {
		t.Fatalf("want exactly one 2020-08-28 bar with a close, got %+v", page.Bars)
	}
	if c := *page.Bars[0].C; c < 400 {
		t.Fatalf("AAPL 2020-08-28 raw close = %.2f, want > 400 (pre-split price); looks split-adjusted", c)
	}
}

func TestLiveInvalidSymbol(t *testing.T) {
	t.Run("malformed symbol is refused with HTTP 400 and a message", func(t *testing.T) {
		status, body := liveGet(t, "BAD SYM", dailyRaw("2024-01-02", "2024-02-01"))
		if status != http.StatusBadRequest {
			t.Fatalf("HTTP %d, want 400", status)
		}
		var e struct {
			Message string `json:"message"`
		}
		if err := json.Unmarshal(body, &e); err != nil || e.Message == "" {
			t.Fatalf("want a JSON {\"message\": ...} error body, got %q (%v)", body, err)
		}
	})
	t.Run("unknown but well-formed symbol returns no bars, never invented ones", func(t *testing.T) {
		status, body := liveGet(t, "ZZZZNOSUCH", dailyRaw("2024-01-02", "2024-02-01"))
		if status != http.StatusOK {
			t.Fatalf("HTTP %d, want 200 with an empty page", status)
		}
		var page liveBars
		if err := json.Unmarshal(body, &page); err != nil {
			t.Fatalf("malformed JSON: %v", err)
		}
		if len(page.Bars) != 0 {
			t.Fatalf("got %d bars for a symbol that does not exist", len(page.Bars))
		}
	})
}
