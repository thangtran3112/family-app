package server

import (
	"context"
	"errors"
	"log/slog"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/types/known/timestamppb"

	pb "github.com/thangtran3112/family-app/ai-trading/market-data/bridge/gen/marketdata/v1"
	"github.com/thangtran3112/family-app/ai-trading/market-data/bridge/internal/archive"
	"github.com/thangtran3112/family-app/ai-trading/market-data/bridge/internal/providers/cache"
)

// The hot tier must be invisible on the wire (02t, Redis plan §5.7). The whole conformance script
// runs once more with every provider wrapped by the cache, over an emptied store before each step,
// so every goldens answer is a miss that went through encode, store, decode and window slicing.
func TestConformanceWithTheHotTierOnAColdStore(t *testing.T) {
	conformance(t, newCachedHarness, func(h *harness) { h.Hot.Reset() })
}

func getBars(t *testing.T, h *harness, req *pb.GetBarsRequest) []byte {
	t.Helper()
	status, body := h.post("GetBars", req, readAuth())
	if status != 200 {
		t.Fatalf("GetBars status %d: %s", status, body)
	}
	return body
}

// Plain, cold and warm answers are the same JSON, for the windows that stress the slicing: a
// one-session DAY_1 window (the 5U case), a wider one, a window with the vendor's extra session
// outside it, and HOUR_1.
func TestWarmAndColdCacheAnswerLikeNoCache(t *testing.T) {
	reqs := []*pb.GetBarsRequest{
		{Symbol: "AAPL", Timeframe: pb.Timeframe_DAY_1, Adjustment: pb.Adjustment_RAW,
			Start: timestamppb.New(time.Date(2024, 5, 1, 8, 0, 0, 0, time.UTC)), End: timestamppb.New(time.Date(2024, 5, 2, 0, 0, 0, 0, time.UTC))},
		{Symbol: "AAPL", Timeframe: pb.Timeframe_DAY_1, Adjustment: pb.Adjustment_ALL,
			Start: timestamppb.New(fixedNow.AddDate(0, 0, -5)), End: timestamppb.New(fixedNow)},
		{Symbol: "SPY", Timeframe: pb.Timeframe_HOUR_1, Adjustment: pb.Adjustment_RAW,
			Start: timestamppb.New(time.Date(2023, 11, 24, 0, 0, 0, 0, time.UTC)), End: timestamppb.New(time.Date(2023, 11, 25, 5, 0, 0, 0, time.UTC))},
	}
	plain, hot := newHarness(t), newCachedHarness(t)
	for i, r := range reqs {
		want := normalize(t, getBars(t, plain, r))
		cold := normalize(t, getBars(t, hot, r))
		calls := hot.alpacaCalls.Load()
		warm := normalize(t, getBars(t, hot, r))
		if !reflect.DeepEqual(want, cold) || !reflect.DeepEqual(want, warm) {
			t.Errorf("request %d differs:\n plain %v\n cold  %v\n warm  %v", i, want, cold, warm)
		}
		if hot.alpacaCalls.Load() != calls {
			t.Errorf("request %d: the warm read reached the vendor", i)
		}
	}
}

// as_of is applied after the cache and is not part of the key: two requests that differ only in
// as_of share one vendor call, and the earlier as_of still hides the bar that had not closed.
func TestAsOfIsAppliedAfterTheCacheAndSharesTheKey(t *testing.T) {
	h := newCachedHarness(t)
	req := func(asOf *timestamppb.Timestamp) *pb.GetBarsRequest {
		return &pb.GetBarsRequest{Symbol: "AAPL", Timeframe: pb.Timeframe_DAY_1, Adjustment: pb.Adjustment_RAW,
			Start: timestamppb.New(fixedNow.AddDate(0, 0, -5)), End: timestamppb.New(fixedNow), AsOf: asOf}
	}
	decode := func(body []byte) *pb.GetBarsResponse {
		var r pb.GetBarsResponse
		if err := protojson.Unmarshal(body, &r); err != nil {
			t.Fatal(err)
		}
		return &r
	}
	full := decode(getBars(t, h, req(nil)))
	cut := decode(getBars(t, h, req(timestamppb.New(time.Date(2024, 5, 1, 19, 59, 0, 0, time.UTC)))))
	if len(full.Bars) != 2 || len(cut.Bars) != 1 || cut.Bars[0].SessionDate != "2024-04-30" {
		t.Fatalf("as_of cut over a cached superset: full %d bars, cut %v", len(full.Bars), cut.Bars)
	}
	if n := h.alpacaCalls.Load(); n != 1 {
		t.Errorf("two requests that differ only in as_of made %d vendor calls, want 1", n)
	}
}

// A pinned request must reach the vendor every time and never touch the store.
func TestPinnedRequestsBypassTheHotTier(t *testing.T) {
	h := newCachedHarness(t)
	pinned := &pb.GetBarsRequest{Symbol: "AAPL", Timeframe: pb.Timeframe_DAY_1, Adjustment: pb.Adjustment_RAW, PinProvider: "alpaca",
		Start: timestamppb.New(fixedNow.AddDate(0, 0, -5)), End: timestamppb.New(fixedNow)}
	getBars(t, h, pinned)
	getBars(t, h, pinned)
	if n := h.alpacaCalls.Load(); n != 2 || h.Hot.Len() != 0 {
		t.Fatalf("pinned bars: %d vendor calls (want 2), %d stored (want 0)", n, h.Hot.Len())
	}
	h.IBKR.setDown(true)
	quote := &pb.GetQuotesRequest{Symbols: []string{"AAPL"}, PinProvider: "alpaca"}
	for range 2 {
		if status, body := h.post("GetQuotes", quote, readAuth()); status != 200 {
			t.Fatalf("pinned quote %d: %s", status, body)
		}
	}
	if n := h.alpacaCalls.Load(); n != 4 || h.Hot.Len() != 0 {
		t.Fatalf("pinned quotes: %d vendor calls in all (want 4), %d stored (want 0)", n, h.Hot.Len())
	}
}

// An unpinned quote served by the delayed rung is cached; the realtime rung is never stored.
func TestQuotesAreCachedOnlyBelowRealtime(t *testing.T) {
	h := newCachedHarness(t)
	quote := &pb.GetQuotesRequest{Symbols: []string{"AAPL", "MSFT"}}
	for range 2 { // ibkr is up: realtime, nothing stored
		if status, body := h.post("GetQuotes", quote, readAuth()); status != 200 {
			t.Fatalf("realtime quote: %d %s", status, body)
		}
	}
	if h.Hot.Len() != 0 {
		t.Fatalf("a REALTIME quote was stored (%d keys)", h.Hot.Len())
	}
	h.IBKR.setDown(true)
	for range 2 {
		if status, body := h.post("GetQuotes", quote, readAuth()); status != 200 {
			t.Fatalf("delayed quote: %d %s", status, body)
		}
	}
	if n := h.alpacaCalls.Load(); n != 2 {
		t.Errorf("two delayed reads of 2 symbols made %d vendor calls, want 2 (the second read is warm)", n)
	}
}

// brokenArchive is a Postgres outage under the archive.
type brokenArchive struct{ archive.Store }

var errArchiveDown = errors.New("archive down")

func (brokenArchive) Read(context.Context, string, string, string, string) ([]archive.Session, error) {
	return nil, errArchiveDown
}
func (brokenArchive) Write(context.Context, string, string, []archive.Session) error {
	return errArchiveDown
}

// Archive interplay (Redis plan §5.8): archive above, hot tier below. A finished RAW session costs
// one vendor call ever; today's open window read twice within the TTL costs one; with the archive
// store down, a repeat read of a finished window comes from the hot tier.
func TestArchiveAndHotTierDoNotDoubleFetch(t *testing.T) {
	withArchive := func(store archive.Store) func(*Options) {
		return func(o *Options) {
			o.Archive = archive.New(store, slog.New(slog.DiscardHandler), func() time.Time { return fixedNow })
		}
	}
	finished := &pb.GetBarsRequest{Symbol: "AAPL", Timeframe: pb.Timeframe_DAY_1, Adjustment: pb.Adjustment_RAW,
		Start: timestamppb.New(time.Date(2024, 4, 29, 8, 0, 0, 0, time.UTC)), End: timestamppb.New(time.Date(2024, 5, 2, 0, 0, 0, 0, time.UTC))}

	h := newCachedHarness(t, withArchive(archive.NewMemStore()))
	getBars(t, h, finished)
	getBars(t, h, finished)
	if n := h.alpacaCalls.Load(); n != 1 {
		t.Errorf("finished RAW session: %d vendor calls, want 1", n)
	}

	open := &pb.GetBarsRequest{Symbol: "AAPL", Timeframe: pb.Timeframe_MINUTE_1, Adjustment: pb.Adjustment_RAW,
		Start: timestamppb.New(time.Date(2024, 5, 2, 8, 0, 0, 0, time.UTC)), End: timestamppb.New(fixedNow)}
	before := h.alpacaCalls.Load()
	getBars(t, h, open)
	getBars(t, h, open)
	if n := h.alpacaCalls.Load() - before; n != 1 {
		t.Errorf("open-session window read twice: %d vendor calls, want 1", n)
	}

	down := newCachedHarness(t, withArchive(brokenArchive{archive.NewMemStore()}))
	getBars(t, down, finished)
	getBars(t, down, finished)
	if n := down.alpacaCalls.Load(); n != 1 {
		t.Errorf("archive down: a repeat read of a finished window made %d vendor calls, want 1 (the hot tier covers the outage)", n)
	}
	if strings.Contains(down.Logs.String(), "panic") {
		t.Error("panic in the logs")
	}
}

// An entry is a hit inside its TTL and a vendor call again once the TTL has passed, read through
// the endpoint. The window touches the open session (bars: 60 s) and the quote is the delayed rung
// of a live session (30 s), both ±10% jitter, so 20 s is inside and 2 minutes is past.
func TestHotTierEntriesExpireThroughTheEndpoint(t *testing.T) {
	open := &pb.GetBarsRequest{Symbol: "AAPL", Timeframe: pb.Timeframe_MINUTE_1, Adjustment: pb.Adjustment_RAW,
		Start: timestamppb.New(time.Date(2024, 5, 2, 8, 0, 0, 0, time.UTC)), End: timestamppb.New(fixedNow)}
	for _, tc := range []struct {
		name string
		read func(*testing.T, *harness) any // the data the cache owns; "served" is router metadata
	}{
		{"bars", func(t *testing.T, h *harness) any { return normalize(t, getBars(t, h, open)) }},
		{"quotes", func(t *testing.T, h *harness) any {
			status, body := h.post("GetQuotes", &pb.GetQuotesRequest{Symbols: []string{"AAPL"}}, readAuth())
			if status != 200 {
				t.Fatalf("GetQuotes status %d: %s", status, body)
			}
			return normalize(t, body).(map[string]any)["quotes"]
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newCachedHarness(t)
			h.IBKR.setDown(true) // the realtime rung is never stored; the delayed rung is
			cold := tc.read(t, h)
			if n := h.alpacaCalls.Load(); n != 1 || h.Hot.Len() == 0 {
				t.Fatalf("miss: %d vendor calls (want 1), %d keys stored (want >0)", n, h.Hot.Len())
			}
			h.Advance(20 * time.Second)
			if warm := tc.read(t, h); !reflect.DeepEqual(cold, warm) || h.alpacaCalls.Load() != 1 {
				t.Fatalf("hit inside the TTL: %d vendor calls (want 1)\n cold %v\n warm %v", h.alpacaCalls.Load(), cold, warm)
			}
			h.Advance(2 * time.Minute)
			tc.read(t, h)
			if n := h.alpacaCalls.Load(); n != 2 {
				t.Errorf("after the TTL: %d vendor calls, want 2 (the entry expired)", n)
			}
		})
	}
}

// Redis down must be invisible to the caller: the endpoint answers 200 with the vendor's data, as it
// would with no cache, whether Redis dies after warming or was never up. A real RedisStore over
// miniredis, killed under the running server.
func TestRedisDownTheEndpointStillAnswersFromTheProvider(t *testing.T) {
	req := &pb.GetBarsRequest{Symbol: "AAPL", Timeframe: pb.Timeframe_DAY_1, Adjustment: pb.Adjustment_RAW,
		Start: timestamppb.New(fixedNow.AddDate(0, 0, -5)), End: timestamppb.New(fixedNow)}
	want := normalize(t, getBars(t, newHarness(t), req)) // the no-cache answer
	quote := &pb.GetQuotesRequest{Symbols: []string{"AAPL"}}

	for _, tc := range []struct {
		name      string
		warmFirst bool
	}{
		{"dies after warming", true},
		{"down from boot", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			mr := miniredis.RunT(t)
			store, err := cache.NewRedisStore("redis://" + mr.Addr() + "/0")
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { store.Close() })
			h := newCachedHarnessOn(t, store)
			h.IBKR.setDown(true)
			if tc.warmFirst {
				getBars(t, h, req)
				getBars(t, h, req)
				if n := h.alpacaCalls.Load(); n != 1 || len(mr.Keys()) == 0 {
					t.Fatalf("warm-up over redis: %d vendor calls (want 1), %d keys (want >0)", n, len(mr.Keys()))
				}
			}
			mr.Close() // redis is gone
			before := h.alpacaCalls.Load()
			begin := time.Now()
			const reads = 10
			for i := range reads {
				if got := normalize(t, getBars(t, h, req)); !reflect.DeepEqual(want, got) {
					t.Fatalf("GetBars %d with redis down differs from the no-cache answer:\n want %v\n got  %v", i, want, got)
				}
				if status, body := h.post("GetQuotes", quote, readAuth()); status != 200 {
					t.Fatalf("GetQuotes %d with redis down: %d %s", i, status, body)
				}
			}
			if n := h.alpacaCalls.Load() - before; n != 2*reads { // nothing is cached any more: every read is a vendor call
				t.Errorf("%d vendor calls for %d reads of bars and quotes, want %d", n, reads, 2*reads)
			}
			// The breaker opens after a few failures; without it each of the 20 reads would spend its timeout.
			if took := time.Since(begin); took > 3*time.Second {
				t.Errorf("%d reads with redis down took %v: the breaker is not limiting the cost", 2*reads, took)
			}
			if strings.Contains(h.Logs.String(), "panic") {
				t.Error("panic in the logs")
			}
		})
	}
}
