package archive

import (
	"context"
	"testing"

	pb "github.com/thangtran3112/family-app/ai-trading/market-data/bridge/gen/marketdata/v1"
	"github.com/thangtran3112/family-app/ai-trading/market-data/bridge/internal/router"
)

func (r *rig) ensure(t *testing.T, symbol, first, last string) *pb.Coverage {
	t.Helper()
	return r.a.Ensure(t.Context(), symbol, pb.Timeframe_DAY_1, first, last, r.fetch)
}

func wantCoverage(t *testing.T, got *pb.Coverage, archived, fetched, missing int) {
	t.Helper()
	if int(got.Archived) != archived || int(got.FetchedNow) != fetched || len(got.Missing) != missing || got.Error != "" {
		t.Fatalf("coverage archived=%d fetched=%d missing=%d error=%q, want %d/%d/%d: %v",
			got.Archived, got.FetchedNow, len(got.Missing), got.Error, archived, fetched, missing, got)
	}
}

// Fresh store fetches every session; the identical call fetches none and makes no vendor call; the
// filled sessions then answer GetBars from the archive.
func TestEnsureFreshThenAllPresent(t *testing.T) {
	eachStore(t, func(t *testing.T, mk func() Store) {
		r := newRig(t, mk(), load(t, "daily_range_spy.json"), later)
		wantCoverage(t, r.ensure(t, "SPY", "2026-01-02", "2026-01-14"), 0, 9, 0)
		if r.v.calls() != 1 {
			t.Fatalf("%d vendor calls, want 1", r.v.calls())
		}
		wantCoverage(t, r.ensure(t, "SPY", "2026-01-02", "2026-01-14"), 9, 0, 0)
		if r.v.calls() != 1 {
			t.Fatalf("repeat called the vendor (%d calls)", r.v.calls())
		}
		if a, p := sources(r.daily(t, winStart, winEnd).Bars); a != 9 || p != 0 || r.v.calls() != 1 {
			t.Fatalf("GetBars after Ensure: archive=%d provider=%d calls=%d, want 9/0/1", a, p, r.v.calls())
		}
	})
}

// Partial: only the sessions the archive lacks are fetched, and the vendor is asked only from the
// first gap on.
func TestEnsurePartialFetchesOnlyTheGap(t *testing.T) {
	eachStore(t, func(t *testing.T, mk func() Store) {
		r := newRig(t, mk(), load(t, "daily_range_spy.json"), later)
		wantCoverage(t, r.ensure(t, "SPY", "2026-01-02", "2026-01-07"), 0, 4, 0)
		wantCoverage(t, r.ensure(t, "SPY", "2026-01-02", "2026-01-14"), 4, 5, 0)
		if start := r.v.last().Get("start"); start < "2026-01-08" {
			t.Errorf("second fetch started %s, want from the first gap 2026-01-08", start)
		}
	})
}

// One symbol's provider error is that symbol's result; the others are filled.
func TestEnsureProviderErrorIsPerSymbol(t *testing.T) {
	r := newRig(t, NewMemStore(), load(t, "daily_range_spy.json"), later)
	fetch := func(ctx context.Context, req *pb.GetBarsRequest) (*pb.GetBarsResponse, error) {
		if req.Symbol == "BAD" {
			return nil, &router.RouteError{Kind: pb.ErrorKind_UNAVAILABLE, Summary: "alpaca: edge_unreachable"}
		}
		return r.fetch(ctx, req)
	}
	bad := r.a.Ensure(t.Context(), "BAD", pb.Timeframe_DAY_1, "2026-01-02", "2026-01-14", fetch)
	good := r.a.Ensure(t.Context(), "SPY", pb.Timeframe_DAY_1, "2026-01-02", "2026-01-14", fetch)
	wantCoverage(t, good, 0, 9, 0)
	if bad.FetchedNow != 0 || len(bad.Missing) != 9 || bad.Missing[0].Error != pb.ErrorKind_UNAVAILABLE ||
		bad.Missing[0].Message != "alpaca: edge_unreachable" || bad.Missing[0].SessionDate != "2026-01-02" {
		t.Fatalf("BAD coverage: %v", bad)
	}
}

// Archive trouble is reported, never raised: an unreadable store is Error, an unwritable one leaves
// every session missing, and neither claims a session was fetched.
func TestEnsureStoreFailures(t *testing.T) {
	r := newRig(t, brokenStore{}, load(t, "daily_range_spy.json"), later)
	if got := r.ensure(t, "SPY", "2026-01-02", "2026-01-14"); got.Error == "" || got.FetchedNow != 0 || r.v.calls() != 0 {
		t.Fatalf("unreadable store: %v (vendor calls %d)", got, r.v.calls())
	}
	r = newRig(t, writeFails{NewMemStore()}, load(t, "daily_range_spy.json"), later)
	if got := r.ensure(t, "SPY", "2026-01-02", "2026-01-14"); got.FetchedNow != 0 || len(got.Missing) != 9 || got.Missing[0].Error != pb.ErrorKind_UNAVAILABLE {
		t.Fatalf("unwritable store: %v", got)
	}
}

// Dates before the calendar floor are listed (weekdays only), never fetched or counted missing.
func TestEnsureReportsUncoveredBeforeTheFloor(t *testing.T) {
	r := newRig(t, NewMemStore(), load(t, "daily_range_spy.json"), later)
	got := r.ensure(t, "SPY", "2015-12-28", "2016-01-04")
	want := []string{"2015-12-28", "2015-12-29", "2015-12-30", "2015-12-31"}
	if len(got.Uncovered) != len(want) {
		t.Fatalf("uncovered %v, want %v", got.Uncovered, want)
	}
	for i := range want {
		if got.Uncovered[i] != want[i] {
			t.Fatalf("uncovered %v, want %v", got.Uncovered, want)
		}
	}
}

func TestInfoReportsBoundsAndUnreachable(t *testing.T) {
	eachStore(t, func(t *testing.T, mk func() Store) {
		store := mk()
		r := newRig(t, store, load(t, "daily_range_spy.json"), later)
		if info := r.a.Info(t.Context()); !info.Enabled || info.Backend != store.Backend() || len(info.Ranges) != 0 {
			t.Fatalf("empty archive: %v", info)
		}
		r.ensure(t, "SPY", "2026-01-02", "2026-01-14")
		info := r.a.Info(t.Context())
		if len(info.Ranges) != 1 || info.Ranges[0].Timeframe != pb.Timeframe_DAY_1 ||
			info.Ranges[0].EarliestSession != "2026-01-02" || info.Ranges[0].LatestSession != "2026-01-14" {
			t.Fatalf("ranges %v", info.Ranges)
		}
	})
	down := newRig(t, brokenStore{}, nil, later).a.Info(t.Context())
	if !down.Enabled || down.Reason != "database_unreachable" || len(down.Ranges) != 0 {
		t.Fatalf("unreachable archive: %v", down)
	}
}
