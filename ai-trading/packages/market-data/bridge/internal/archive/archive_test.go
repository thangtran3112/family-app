package archive

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"sync"
	"testing"
	"time"

	"google.golang.org/protobuf/types/known/timestamppb"

	pb "github.com/thangtran3112/family-app/ai-trading/market-data/bridge/gen/marketdata/v1"
	"github.com/thangtran3112/family-app/ai-trading/market-data/bridge/internal/providers/alpaca"
	"github.com/thangtran3112/family-app/ai-trading/market-data/bridge/internal/router"
)

// The recorded real Alpaca windows (02u T1). daily_range_spy: 9 SPY sessions, 2026-01-02..01-14.
const fixtures = "../../../../../common/tests/fixtures/alpaca/"

type row struct {
	T time.Time `json:"t"`
	O float64   `json:"o"`
	H float64   `json:"h"`
	L float64   `json:"l"`
	C float64   `json:"c"`
	V float64   `json:"v"`
}

func load(t *testing.T, name string) []row {
	t.Helper()
	raw, err := os.ReadFile(fixtures + name)
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Body struct {
			Bars []row `json:"bars"`
		} `json:"body"`
	}
	if err := json.Unmarshal(raw, &f); err != nil || len(f.Body.Bars) == 0 {
		t.Fatalf("%s: %v", name, err)
	}
	return f.Body.Bars
}

// vendor replays rows the way Alpaca does (start <= t <= end) and counts what it was asked.
type vendor struct {
	mu   sync.Mutex
	rows []row
	reqs []url.Values
}

func (v *vendor) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	start, _ := time.Parse(time.RFC3339, q.Get("start"))
	end, _ := time.Parse(time.RFC3339, q.Get("end"))
	v.mu.Lock()
	v.reqs = append(v.reqs, q)
	kept := []row{}
	for _, b := range v.rows {
		if !b.T.Before(start) && !b.T.After(end) {
			kept = append(kept, b)
		}
	}
	v.mu.Unlock()
	_ = json.NewEncoder(w).Encode(map[string]any{"bars": kept, "next_page_token": nil})
}

func (v *vendor) calls() int { v.mu.Lock(); defer v.mu.Unlock(); return len(v.reqs) }
func (v *vendor) last() url.Values {
	v.mu.Lock()
	defer v.mu.Unlock()
	return v.reqs[len(v.reqs)-1]
}
func (v *vendor) set(rows []row) { v.mu.Lock(); v.rows = rows; v.mu.Unlock() }

type rig struct {
	a     *Archive
	v     *vendor
	fetch Fetch
	store Store
}

// newRig wires the real Alpaca adapter and router to a replayed vendor, so the 5U padding and the
// closed-bar rule are in play. now is the fake clock for both the adapter and the archive.
func newRig(t *testing.T, store Store, rows []row, now string) *rig {
	t.Helper()
	at, err := time.Parse(time.RFC3339, now)
	if err != nil {
		t.Fatal(err)
	}
	v := &vendor{rows: rows}
	srv := httptest.NewServer(v)
	t.Cleanup(srv.Close)
	clock := func() time.Time { return at }
	al := alpaca.New("k", "s", alpaca.WithBaseURL(srv.URL), alpaca.WithClock(clock), alpaca.WithMinInterval(0))
	rt := router.New(router.Options{Role: "bridge", Now: clock,
		Ladders:   map[pb.DataClass][]string{pb.DataClass_EQUITY_BARS: {"alpaca"}},
		Providers: []router.Provider{al}})
	return &rig{a: New(store, slog.New(slog.DiscardHandler), clock), v: v, fetch: rt.Bars, store: store}
}

func (r *rig) bars(t *testing.T, tf pb.Timeframe, adj pb.Adjustment, start, end string) (*pb.GetBarsResponse, error) {
	t.Helper()
	s, _ := time.Parse(time.RFC3339, start)
	e, _ := time.Parse(time.RFC3339, end)
	return r.a.Bars(t.Context(), &pb.GetBarsRequest{Symbol: "SPY", Timeframe: tf, Adjustment: adj,
		Start: timestamppb.New(s), End: timestamppb.New(e)}, r.fetch)
}

func (r *rig) daily(t *testing.T, start, end string) *pb.GetBarsResponse {
	t.Helper()
	resp, err := r.bars(t, pb.Timeframe_DAY_1, pb.Adjustment_RAW, start, end)
	if err != nil {
		t.Fatal(err)
	}
	return resp
}

func sources(bars []*pb.Bar) (archived, provider int) {
	for _, b := range bars {
		switch b.Source {
		case pb.BarSource_ARCHIVE:
			archived++
		case pb.BarSource_PROVIDER:
			provider++
		}
	}
	return
}

func days(bars []*pb.Bar) []string {
	out := []string{}
	for _, b := range bars {
		out = append(out, b.SessionDate)
	}
	return out
}

func sameDays(t *testing.T, got []*pb.Bar, want ...string) {
	t.Helper()
	g := days(got)
	if len(g) != len(want) {
		t.Fatalf("sessions %v, want %v", g, want)
	}
	for i := range g {
		if g[i] != want[i] {
			t.Fatalf("sessions %v, want %v", g, want)
		}
	}
}

const (
	winStart = "2026-01-02T05:00:00Z"
	winEnd   = "2026-01-15T00:00:00Z"
	later    = "2026-01-20T15:00:00Z" // every session in the window is finished
)

var allDays = []string{"2026-01-02", "2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08", "2026-01-09", "2026-01-12", "2026-01-13", "2026-01-14"}

// stores runs each scenario on the memory store and, when ARCHIVE_TEST_DATABASE_URL is set, on a
// real Postgres too (the same scenarios, so the two stores cannot drift).
func stores(t *testing.T) map[string]func() Store {
	out := map[string]func() Store{"memory": func() Store { return NewMemStore() }}
	if url := os.Getenv("ARCHIVE_TEST_DATABASE_URL"); url != "" {
		out["postgres"] = func() Store { return testPostgres(t, url) }
	}
	return out
}

func eachStore(t *testing.T, f func(t *testing.T, mk func() Store)) {
	for name, mk := range stores(t) {
		t.Run(name, func(t *testing.T) { f(t, mk) })
	}
}

// (a) archive hit: sessions already archived are answered with no vendor call.
func TestArchiveHitMakesNoProviderCall(t *testing.T) {
	eachStore(t, func(t *testing.T, mk func() Store) {
		rows := load(t, "daily_range_spy.json")
		warm := newRig(t, mk(), rows, later)
		first := warm.daily(t, winStart, winEnd)  // warms the archive
		cold := newRig(t, warm.store, nil, later) // a vendor that has nothing
		got := cold.daily(t, winStart, winEnd)
		if cold.v.calls() != 0 {
			t.Fatalf("%d vendor calls on a full archive hit", cold.v.calls())
		}
		if a, p := sources(got.Bars); a != 9 || p != 0 {
			t.Fatalf("source archive=%d provider=%d, want 9/0", a, p)
		}
		sameDays(t, got.Bars, allDays...)
		for i, b := range got.Bars {
			w := first.Bars[i]
			if b.Open != w.Open || b.High != w.High || b.Low != w.Low || b.Close != w.Close || b.Volume != w.Volume ||
				!b.Start.AsTime().Equal(w.Start.AsTime()) || !b.CloseAt.AsTime().Equal(w.CloseAt.AsTime()) {
				t.Errorf("archived bar %s differs from the fetched one:\n got  %v\n want %v", b.SessionDate, b, w)
			}
		}
		if got.Served.Provider != "alpaca" || got.Served.Fallback {
			t.Errorf("served %v, want the filling vendor", got.Served)
		}
	})
}

// (b) archive miss: fetch, store, return; the next request is a hit; a vendor revision never shows.
func TestArchiveMissFetchesStoresThenHits(t *testing.T) {
	eachStore(t, func(t *testing.T, mk func() Store) {
		rows := load(t, "daily_range_spy.json")
		r := newRig(t, mk(), rows, later)
		first := r.daily(t, winStart, winEnd)
		if r.v.calls() != 1 {
			t.Fatalf("%d vendor calls on a miss, want 1", r.v.calls())
		}
		if a, p := sources(first.Bars); a != 0 || p != 9 {
			t.Fatalf("source archive=%d provider=%d, want 0/9", a, p)
		}
		sameDays(t, first.Bars, allDays...)

		revised := append([]row(nil), rows...)
		revised[3].C += 5
		r.v.set(revised)
		second := r.daily(t, winStart, winEnd)
		if r.v.calls() != 1 {
			t.Fatalf("second request called the vendor (%d calls): the archive is write-once", r.v.calls())
		}
		if a, _ := sources(second.Bars); a != 9 {
			t.Fatalf("second request: %d archived bars, want 9", a)
		}
		if second.Bars[3].Close != first.Bars[3].Close {
			t.Errorf("a vendor revision reached the answer: %v != %v", second.Bars[3].Close, first.Bars[3].Close)
		}
	})
}

// (c) partial hit: the archive holds some sessions, the provider fills only the rest.
func TestPartialHitFillsOnlyTheGap(t *testing.T) {
	eachStore(t, func(t *testing.T, mk func() Store) {
		rows := load(t, "daily_range_spy.json")
		r := newRig(t, mk(), rows, later)
		r.daily(t, winStart, "2026-01-09T00:00:00Z") // archives 01-02..01-08
		before := r.v.calls()
		got := r.daily(t, winStart, winEnd)
		if r.v.calls() != before+1 {
			t.Fatalf("%d new vendor calls, want 1 for the gap", r.v.calls()-before)
		}
		if s := r.v.last().Get("start"); s != "2026-01-09T05:00:00Z" {
			t.Errorf("vendor asked from %s, want only the gap from 2026-01-09T05:00:00Z", s)
		}
		sameDays(t, got.Bars, allDays...)
		if a, p := sources(got.Bars); a != 5 || p != 4 {
			t.Fatalf("source archive=%d provider=%d, want 5/4", a, p)
		}
		for i, b := range got.Bars {
			if wantArchive := i < 5; (b.Source == pb.BarSource_ARCHIVE) != wantArchive {
				t.Errorf("bar %s source %v", b.SessionDate, b.Source)
			}
		}
		if again := r.daily(t, winStart, winEnd); r.v.calls() != before+1 {
			t.Fatalf("gap was not archived: %d vendor calls after a repeat (%d bars)", r.v.calls(), len(again.Bars))
		}
	})
}

// A session still open (before 20:15 ET) is served from the provider and never stored.
func TestOpenSessionIsNotArchived(t *testing.T) {
	eachStore(t, func(t *testing.T, mk func() Store) {
		rows := load(t, "daily_range_spy.json")
		r := newRig(t, mk(), rows, "2026-01-14T21:00:00Z") // 16:00 ET: bar closed, session not final
		got := r.daily(t, winStart, winEnd)
		sameDays(t, got.Bars, allDays...)
		saved, err := r.store.Read(t.Context(), "SPY", "1d", "2026-01-01", "2026-01-31")
		if err != nil || len(saved) != 8 {
			t.Fatalf("archived %d sessions (%v), want the 8 finished ones", len(saved), err)
		}
		r.daily(t, winStart, winEnd)
		if r.v.calls() != 2 {
			t.Fatalf("%d vendor calls, want 2: the open session is fetched again each time", r.v.calls())
		}
	})
}

// A finished session the vendor has no bar for is a quiet session: complete, not re-fetched.
func TestQuietSessionIsArchivedOnce(t *testing.T) {
	eachStore(t, func(t *testing.T, mk func() Store) {
		rows := load(t, "daily_range_spy.json")
		rows = append(append([]row(nil), rows[:5]...), rows[6:]...) // no 2026-01-09
		r := newRig(t, mk(), rows, later)
		sameDays(t, r.daily(t, winStart, winEnd).Bars, "2026-01-02", "2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08", "2026-01-12", "2026-01-13", "2026-01-14")
		r.daily(t, winStart, winEnd)
		if r.v.calls() != 1 {
			t.Fatalf("%d vendor calls: the quiet session was fetched again", r.v.calls())
		}
	})
}

// Adjusted series, and a pinned provider, are never archived.
func TestAdjustedAndPinnedPassThrough(t *testing.T) {
	eachStore(t, func(t *testing.T, mk func() Store) {
		r := newRig(t, mk(), load(t, "daily_range_spy.json"), later)
		for range 2 {
			resp, err := r.bars(t, pb.Timeframe_DAY_1, pb.Adjustment_ALL, winStart, winEnd)
			if err != nil {
				t.Fatal(err)
			}
			if a, p := sources(resp.Bars); a != 0 || p != 9 {
				t.Fatalf("adjusted: archive=%d provider=%d", a, p)
			}
		}
		if r.v.calls() != 2 {
			t.Errorf("adjusted answers must not be cached: %d vendor calls", r.v.calls())
		}
		pinned := &pb.GetBarsRequest{Symbol: "SPY", Timeframe: pb.Timeframe_DAY_1, Adjustment: pb.Adjustment_RAW, PinProvider: "alpaca",
			Start: timestamppb.New(time.Date(2026, 1, 2, 5, 0, 0, 0, time.UTC)), End: timestamppb.New(time.Date(2026, 1, 15, 0, 0, 0, 0, time.UTC))}
		if _, err := r.a.Bars(t.Context(), pinned, r.fetch); err != nil {
			t.Fatal(err)
		}
		if saved, _ := r.store.Read(t.Context(), "SPY", "1d", "2026-01-01", "2026-01-31"); len(saved) != 0 {
			t.Errorf("a pinned request wrote %d sessions", len(saved))
		}
	})
}

// 1m: a sub-session request archives the whole session; the next, different window is a hit.
func TestMinuteSessionIsArchivedWhole(t *testing.T) {
	eachStore(t, func(t *testing.T, mk func() Store) {
		rows := load(t, "minute_half_day.json") // 2025-11-28, an early close: 12:45-13:15 ET
		r := newRig(t, mk(), rows, "2025-12-02T15:00:00Z")
		first, err := r.bars(t, pb.Timeframe_MINUTE_1, pb.Adjustment_RAW, "2025-11-28T17:45:00Z", "2025-11-28T18:15:00Z")
		if err != nil {
			t.Fatal(err)
		}
		if len(first.Bars) != 31 {
			t.Fatalf("%d bars, want the 31 recorded", len(first.Bars))
		}
		if s := r.v.last().Get("start"); s != "2025-11-28T05:00:00Z" {
			t.Errorf("vendor asked from %s, want the whole ET day", s)
		}
		inner, err := r.bars(t, pb.Timeframe_MINUTE_1, pb.Adjustment_RAW, "2025-11-28T17:50:00Z", "2025-11-28T18:00:00Z")
		if err != nil {
			t.Fatal(err)
		}
		if r.v.calls() != 1 {
			t.Fatalf("%d vendor calls: the second window should be an archive hit", r.v.calls())
		}
		if a, p := sources(inner.Bars); a != 11 || p != 0 {
			t.Fatalf("source archive=%d provider=%d, want 11/0 (17:50..18:00 inclusive)", a, p)
		}
		for _, b := range inner.Bars {
			if !b.CloseAt.AsTime().Equal(b.Start.AsTime().Add(time.Minute)) {
				t.Errorf("close_at %v for a minute bar at %v", b.CloseAt.AsTime(), b.Start.AsTime())
			}
		}
	})
}

type brokenStore struct{}

func (brokenStore) Read(context.Context, string, string, string, string) ([]Session, error) {
	return nil, errors.New("database down")
}
func (brokenStore) Write(context.Context, string, string, []Session) error {
	return errors.New("database down")
}

// Archive down: bars pass through from the provider, marked as such; the request does not fail.
func TestStoreFailureNeverFailsTheRequest(t *testing.T) {
	r := newRig(t, brokenStore{}, load(t, "daily_range_spy.json"), later)
	got := r.daily(t, winStart, winEnd)
	if a, p := sources(got.Bars); a != 0 || p != 9 {
		t.Fatalf("archive=%d provider=%d, want 0/9", a, p)
	}
	// And a store that reads fine but cannot write still answers.
	r2 := newRig(t, writeFails{NewMemStore()}, load(t, "daily_range_spy.json"), later)
	sameDays(t, r2.daily(t, winStart, winEnd).Bars, allDays...)
}

type writeFails struct{ *MemStore }

func (writeFails) Write(context.Context, string, string, []Session) error {
	return errors.New("read-only")
}

// A no-data answer stays a no-data error (not an empty success), as on the provider path.
func TestNoDataStaysNoData(t *testing.T) {
	r := newRig(t, NewMemStore(), nil, later)
	_, err := r.bars(t, pb.Timeframe_DAY_1, pb.Adjustment_RAW, winStart, winEnd)
	var re *router.RouteError
	if !errors.As(err, &re) || re.Kind != pb.ErrorKind_NO_DATA {
		t.Fatalf("err %v, want a NO_DATA route error", err)
	}
}
