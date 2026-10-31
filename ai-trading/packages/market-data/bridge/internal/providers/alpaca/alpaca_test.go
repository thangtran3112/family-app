package alpaca

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"google.golang.org/protobuf/types/known/timestamppb"

	pb "github.com/thangtran3112/family-app/ai-trading/market-data/bridge/gen/marketdata/v1"
	"github.com/thangtran3112/family-app/ai-trading/market-data/bridge/internal/router"
)

// 2024-05-02 16:30 ET (EDT), a Thursday.
var now = time.Date(2024, 5, 2, 20, 30, 0, 0, time.UTC)

type recorder struct {
	mu   sync.Mutex
	reqs []*http.Request
}

func (r *recorder) last() *http.Request {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.reqs[len(r.reqs)-1]
}

func fakeAlpaca(t *testing.T, handler http.HandlerFunc) (*Client, *recorder) {
	t.Helper()
	rec := &recorder{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rec.mu.Lock()
		rec.reqs = append(rec.reqs, r)
		rec.mu.Unlock()
		handler(w, r)
	}))
	t.Cleanup(srv.Close)
	return New("key-id", "key-secret", WithBaseURL(srv.URL), WithClock(func() time.Time { return now }), WithMinInterval(0)), rec
}

func jsonBody(body string) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(body)) }
}

func TestQuotesAreDelayedAndCarryNoBidAsk(t *testing.T) {
	c, rec := fakeAlpaca(t, func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "ZZZZ") {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte(`{"bars":[{"t":"2024-05-02T20:14:00Z","o":1,"h":2,"l":1,"c":187.5,"v":900}],"next_page_token":null}`))
	})
	got, err := c.Quotes(context.Background(), []string{"AAPL", "ZZZZ"})
	if err != nil || len(got) != 1 {
		t.Fatalf("want one quote and ZZZZ left out: %v %v", got, err)
	}
	q := got[0]
	if q.Symbol != "AAPL" || q.Last != 187.5 || q.Quality != pb.Quality_DELAYED_15M || q.Provider != "alpaca" ||
		q.Bid != nil || q.Ask != nil || !q.AsOf.AsTime().Equal(time.Date(2024, 5, 2, 20, 14, 0, 0, time.UTC)) {
		t.Fatalf("quote: %+v", q)
	}
	r := rec.reqs[0]
	if r.URL.Path != "/AAPL/bars" || r.Header.Get("APCA-API-KEY-ID") != "key-id" || r.Header.Get("APCA-API-SECRET-KEY") != "key-secret" {
		t.Fatalf("request: %s %v", r.URL, r.Header)
	}
	want := map[string]string{"timeframe": "1Min", "feed": "sip", "sort": "desc", "limit": "1", "end": "2024-05-02T20:15:00Z"}
	for k, v := range want {
		if r.URL.Query().Get(k) != v {
			t.Errorf("query %s = %q, want %q", k, r.URL.Query().Get(k), v)
		}
	}
}

func TestNothingIsEverLabeledRealtime(t *testing.T) {
	c, _ := fakeAlpaca(t, jsonBody(`{"bars":[{"t":"2024-05-01T04:00:00Z","o":1,"h":2,"l":1,"c":2,"v":9}]}`))
	qs, _ := c.Quotes(context.Background(), []string{"AAPL"})
	req := &pb.GetBarsRequest{Symbol: "AAPL", Start: timestamppb.New(now.AddDate(0, 0, -5)), End: timestamppb.New(now)}
	var qualities []pb.Quality
	for _, tf := range []pb.Timeframe{pb.Timeframe_MINUTE_1, pb.Timeframe_HOUR_1, pb.Timeframe_DAY_1} {
		req.Timeframe = tf
		_, q, err := c.Bars(context.Background(), req)
		if err != nil {
			t.Fatal(err)
		}
		qualities = append(qualities, q)
	}
	qualities = append(qualities, qs[0].Quality, c.Health().Quality)
	for _, q := range qualities {
		if q == pb.Quality_REALTIME || q == pb.Quality_QUALITY_UNSPECIFIED {
			t.Fatalf("Alpaca Basic must be delayed-15m or eod, got %v in %v", q, qualities)
		}
	}
	if qualities[2] != pb.Quality_EOD || qualities[0] != pb.Quality_DELAYED_15M {
		t.Fatalf("qualities: %v", qualities)
	}
}

func TestStatusMapsOntoTheErrorTaxonomy(t *testing.T) {
	cases := map[int]error{
		401: router.ErrNotConfigured, 403: router.ErrNotConfigured, 429: router.ErrSoftBanned,
		404: router.ErrNoData, 400: router.ErrNoData, 422: router.ErrNoData,
		500: router.ErrUnavailable, 502: router.ErrUnavailable, 418: router.ErrUnavailable,
	}
	for status, want := range cases {
		c, _ := fakeAlpaca(t, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(status) })
		_, err := c.Quotes(context.Background(), []string{"AAPL"})
		if status == 404 || status == 400 || status == 422 {
			// A per-symbol miss is left out of Quotes; it surfaces as NoData one level up.
			if err != nil {
				t.Errorf("HTTP %d: a missing symbol must not be an error from Quotes: %v", status, err)
			}
			if _, _, err := c.Bars(context.Background(), &pb.GetBarsRequest{Symbol: "AAPL", Timeframe: pb.Timeframe_DAY_1, Start: timestamppb.New(now.AddDate(0, 0, -3)), End: timestamppb.New(now)}); !errors.Is(err, want) {
				t.Errorf("HTTP %d: Bars error %v, want %v", status, err, want)
			}
			continue
		}
		if !errors.Is(err, want) {
			t.Errorf("HTTP %d: got %v, want %v", status, err, want)
		}
	}
}

func TestMalformedAndUnreachableAreUnavailableAndLeakNoSecret(t *testing.T) {
	c, _ := fakeAlpaca(t, jsonBody(`{not json`))
	_, err := c.Quotes(context.Background(), []string{"AAPL"})
	if !errors.Is(err, router.ErrUnavailable) {
		t.Fatalf("bad JSON: %v", err)
	}
	dead := New("key-id", "key-secret", WithBaseURL("http://127.0.0.1:1"), WithMinInterval(0))
	_, err = dead.Quotes(context.Background(), []string{"AAPL"})
	if !errors.Is(err, router.ErrUnavailable) {
		t.Fatalf("connection refused: %v", err)
	}
	for _, s := range []string{"key-id", "key-secret", "127.0.0.1:1/AAPL", "?"} {
		if strings.Contains(err.Error(), s) {
			t.Fatalf("error leaks %q: %v", s, err)
		}
	}
}

func TestNotConfiguredSendsNothing(t *testing.T) {
	called := false
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { called = true }))
	defer srv.Close()
	c := New("", "", WithBaseURL(srv.URL))
	if c.Configured() || c.Health().State != pb.HealthState_HEALTH_STATE_NOT_CONFIGURED {
		t.Fatal("empty key must be NOT_CONFIGURED")
	}
	if _, err := c.Quotes(context.Background(), []string{"AAPL"}); !errors.Is(err, router.ErrNotConfigured) || called {
		t.Fatalf("err=%v called=%v", err, called)
	}
}

func TestBarsEmbargoPagingHygieneAndClosedOnly(t *testing.T) {
	page := 0
	c, rec := fakeAlpaca(t, func(w http.ResponseWriter, r *http.Request) {
		page++
		if page == 1 {
			// Daily bars, newest last. May 2 is today (16:30 ET): its 16:00 close has passed -> kept.
			// May 3 would not have closed (not possible here, but a vendor bug must not repaint).
			_, _ = w.Write([]byte(`{"bars":[
				{"t":"2024-05-01T04:00:00Z","o":10,"h":12,"l":9,"c":11,"v":1000},
				{"t":"2024-05-01T04:00:00Z","o":10,"h":12,"l":9,"c":11.5,"v":1100},
				{"t":"2024-04-30T04:00:00Z","o":0,"h":12,"l":9,"c":11,"v":1}
			],"next_page_token":"p2"}`))
			return
		}
		if r.URL.Query().Get("page_token") != "p2" {
			t.Errorf("second page must carry the token: %s", r.URL)
		}
		_, _ = w.Write([]byte(`{"bars":[
			{"t":"2024-05-02T04:00:00Z","o":11,"h":13,"l":10,"c":12,"v":2000},
			{"t":"2024-05-03T04:00:00Z","o":11,"h":13,"l":10,"c":12,"v":2000},
			{"t":"2024-04-29T04:00:00Z","o":11,"h":9,"l":10,"c":10,"v":5}
		],"next_page_token":null}`))
	})
	bars, q, err := c.Bars(context.Background(), &pb.GetBarsRequest{
		Symbol: "AAPL", Timeframe: pb.Timeframe_DAY_1, Adjustment: pb.Adjustment_SPLIT,
		Start: timestamppb.New(now.AddDate(0, 0, -10)), End: timestamppb.New(now.AddDate(0, 0, 5)),
	})
	if err != nil || q != pb.Quality_EOD {
		t.Fatalf("%v %v", q, err)
	}
	// Dropped: the zero-price row, the high<low row, and the not-yet-closed May 3 bar; the duplicate keeps the last.
	if len(bars) != 2 || bars[0].Close != 11.5 || bars[0].Volume != 1100 || bars[1].Close != 12 {
		t.Fatalf("bars: %v", bars)
	}
	first := rec.reqs[0].URL.Query()
	if first.Get("adjustment") != "split" || first.Get("timeframe") != "1Day" || first.Get("feed") != "sip" ||
		first.Get("end") != "2024-05-02T20:15:00Z" {
		t.Fatalf("the end must be capped to now-15m and adjustment passed through: %v", first)
	}
}

func TestIntradayBarsDropTheStillOpenBar(t *testing.T) {
	c, _ := fakeAlpaca(t, jsonBody(`{"bars":[
		{"t":"2024-05-02T18:00:00Z","o":1,"h":2,"l":1,"c":2,"v":9},
		{"t":"2024-05-02T20:00:00Z","o":1,"h":2,"l":1,"c":2,"v":9},
		{"t":"2024-05-02T20:15:00Z","o":1,"h":2,"l":1,"c":2,"v":9}]}`))
	bars, q, err := c.Bars(context.Background(), &pb.GetBarsRequest{
		Symbol: "AAPL", Timeframe: pb.Timeframe_HOUR_1, Start: timestamppb.New(now.Add(-24 * time.Hour)), End: timestamppb.New(now),
	})
	// 20:00 closes at 21:00 > now: dropped. 18:00 closes at 19:00: kept. 20:15 likewise dropped.
	if err != nil || q != pb.Quality_DELAYED_15M || len(bars) != 1 || !bars[0].Start.AsTime().Equal(time.Date(2024, 5, 2, 18, 0, 0, 0, time.UTC)) {
		t.Fatalf("%v %v %v", bars, q, err)
	}
}

func TestEmptyWindowSendsNoRequest(t *testing.T) {
	c, rec := fakeAlpaca(t, jsonBody(`{}`))
	// The whole window is inside the embargo: nothing can be served.
	bars, _, err := c.Bars(context.Background(), &pb.GetBarsRequest{
		Symbol: "AAPL", Timeframe: pb.Timeframe_MINUTE_1, Start: timestamppb.New(now.Add(-5 * time.Minute)), End: timestamppb.New(now),
	})
	if err != nil || len(bars) != 0 || len(rec.reqs) != 0 {
		t.Fatalf("%v %v requests=%d", bars, err, len(rec.reqs))
	}
}

func TestProbeTreatsNoDataAsAlive(t *testing.T) {
	c, _ := fakeAlpaca(t, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(404) })
	if err := c.Probe(context.Background()); err != nil {
		t.Fatalf("an answering service is up: %v", err)
	}
	c2, _ := fakeAlpaca(t, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(503) })
	if err := c2.Probe(context.Background()); !errors.Is(err, router.ErrUnavailable) {
		t.Fatalf("503: %v", err)
	}
}

func TestThrottleSpacesRequests(t *testing.T) {
	c, _ := fakeAlpaca(t, jsonBody(`{"bars":[]}`))
	c.minInterval = 40 * time.Millisecond
	start := time.Now()
	_, _ = c.Quotes(context.Background(), []string{"A", "B", "C"})
	if d := time.Since(start); d < 70*time.Millisecond {
		t.Fatalf("3 requests at 40ms spacing took only %v", d)
	}
}
